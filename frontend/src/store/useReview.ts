/**
 * The Review tab's state: which PR, what is in it, and what the checks found.
 *
 * Selecting a PR pulls its file list, then every sound's bytes from the head
 * repo, then runs the same format rules the Upload form enforces plus the
 * audio audit (length, silence). The decoded AudioBuffer is kept on each entry
 * so playing a sound is instant; chatsounds are seconds long, so a whole PR's
 * worth of decoded audio is smaller than one Extract recording.
 *
 * Denials post to the PR immediately, as decided: the first one submits a
 * changes-requested review naming the sound, the rest go up as plain comments,
 * so the author gets one red review and a thread, not a stack of red reviews.
 */

import { create } from 'zustand'
import {
  type PrDetail,
  type PrSummary,
  type ReviewEntry,
  REALM_ROOT,
  canPush,
  fetchBlobBytes,
  getPrDetail,
  listOpenPrs,
  listPrFiles,
  listReviews,
  mergePr,
  postPrComment,
  submitReview,
} from '../lib/github'
import { type Audit, auditEnvelope } from '../pipeline/audit'
import { computeEnvelope } from '../pipeline/envelope'
import { type OggInfo, OGG_PROBE_BYTES, describeOggProblem, identifyOgg } from '../pipeline/ogg'

export interface ReviewSound {
  path: string
  realm: string
  name: string
  sha: string
  state: 'pending' | 'ready' | 'failed'
  /** Why it failed to load or decode, when it did. */
  error?: string
  format?: OggInfo
  /** The format rule it breaks, when it breaks one. */
  formatProblem?: string
  audit?: Audit
  buffer?: AudioBuffer
  denied?: boolean
}

export interface OtherFile {
  path: string
  status: string
}

type Gate = 'unknown' | 'checking' | 'allowed' | 'restricted'

interface ReviewState {
  gate: Gate
  /** The token the gate was answered for; a different account asks again. */
  gateFor: string | null
  prs: PrSummary[] | null
  detail: PrDetail | null
  sounds: ReviewSound[]
  others: OtherFile[]
  reviews: ReviewEntry[]
  loading: string | null
  busy: boolean
  merged: boolean
  error: string | null

  checkAccess: (token: string) => Promise<void>
  loadPrs: (token: string) => Promise<void>
  open: (token: string, number: number) => Promise<void>
  close: () => void
  deny: (token: string, path: string, comment: string, myLogin: string) => Promise<void>
  denyAll: (token: string, comment: string) => Promise<void>
  approveAll: (token: string) => Promise<void>
  merge: (token: string) => Promise<void>
}

export const useReview = create<ReviewState>((set, get) => ({
  gate: 'unknown',
  gateFor: null,
  prs: null,
  detail: null,
  sounds: [],
  others: [],
  reviews: [],
  loading: null,
  busy: false,
  merged: false,
  error: null,

  async checkAccess(token) {
    const { gate, gateFor } = get()
    // Same account, settled or being settled: nothing to redo. A different
    // token means someone signed out and back in, and their rights are their
    // own, as is what the last account was looking at.
    if (gateFor === token && gate !== 'unknown') return
    set({
      gate: 'checking',
      gateFor: token,
      prs: null,
      detail: null,
      sounds: [],
      others: [],
      reviews: [],
      error: null,
    })
    try {
      set({ gate: (await canPush(token)) ? 'allowed' : 'restricted' })
    } catch {
      // Failing to answer is not proof of rights; the safe reading is no.
      set({ gate: 'restricted' })
    }
  },

  async loadPrs(token) {
    try {
      set({ prs: await listOpenPrs(token), error: null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  async open(token, number) {
    set({
      detail: null,
      sounds: [],
      others: [],
      reviews: [],
      merged: false,
      error: null,
      loading: 'reading the pull request',
    })

    try {
      const [detail, files, reviews] = await Promise.all([
        getPrDetail(token, number),
        listPrFiles(token, number),
        listReviews(token, number),
      ])

      const sounds: ReviewSound[] = []
      const others: OtherFile[] = []
      for (const file of files) {
        const inRealms = file.path.startsWith(`${REALM_ROOT}/`)
        const isOgg = file.path.toLowerCase().endsWith('.ogg')
        if (inRealms && isOgg && file.status !== 'removed') {
          const relative = file.path.slice(REALM_ROOT.length + 1)
          const slash = relative.indexOf('/')
          sounds.push({
            path: file.path,
            realm: slash > 0 ? relative.slice(0, slash) : '',
            name: slash > 0 ? relative.slice(slash + 1) : relative,
            sha: file.sha,
            state: 'pending',
          })
        } else {
          others.push({ path: file.path, status: file.status })
        }
      }

      set({ detail, sounds, others, reviews, merged: detail.merged })

      if (!detail.headOwner) {
        set({ loading: null, error: 'The fork this came from is gone, so the sounds cannot be fetched.' })
        return
      }

      for (const [index, sound] of sounds.entries()) {
        // Bail out if the user opened another PR meanwhile.
        if (get().detail?.number !== number) return
        set({ loading: `checking ${sound.name} (${index + 1}/${sounds.length})` })
        const checked = await checkSound(token, detail, sound)
        set((state) => ({
          sounds: state.sounds.map((item) => (item.path === sound.path ? checked : item)),
        }))
      }
      set({ loading: null })
    } catch (error) {
      set({ loading: null, error: error instanceof Error ? error.message : String(error) })
    }
  },

  close() {
    set({ detail: null, sounds: [], others: [], reviews: [], loading: null, error: null })
  },

  async deny(token, path, comment, myLogin) {
    const { detail, reviews, sounds } = get()
    const sound = sounds.find((item) => item.path === path)
    if (!detail || !sound) return
    set({ busy: true, error: null })
    try {
      const line = `\`${sound.realm}/${sound.name}\`: ${comment}`
      // My newest review decides: already red, and another red review would
      // just stack; still green or absent, and the first denial flips it.
      const mine = reviews.filter((review) => review.reviewer === myLogin)
      const alreadyRed = mine[mine.length - 1]?.state === 'CHANGES_REQUESTED'
      if (alreadyRed) await postPrComment(token, detail.number, line)
      else await submitReview(token, detail.number, 'REQUEST_CHANGES', line)

      set((state) => ({
        busy: false,
        sounds: state.sounds.map((item) =>
          item.path === path ? { ...item, denied: true } : item,
        ),
        reviews: state.reviews,
      }))
      set({ reviews: await listReviews(token, detail.number) })
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async denyAll(token, comment) {
    const { detail } = get()
    if (!detail) return
    set({ busy: true, error: null })
    try {
      await submitReview(token, detail.number, 'REQUEST_CHANGES', comment)
      set((state) => ({
        busy: false,
        sounds: state.sounds.map((item) => ({ ...item, denied: true })),
      }))
      set({ reviews: await listReviews(token, detail.number) })
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async approveAll(token) {
    const { detail } = get()
    if (!detail) return
    set({ busy: true, error: null })
    try {
      await submitReview(token, detail.number, 'APPROVE', '')
      set({ busy: false, reviews: await listReviews(token, detail.number) })
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async merge(token) {
    const { detail } = get()
    if (!detail) return
    set({ busy: true, error: null })
    try {
      await mergePr(token, detail.number)
      set({ busy: false, merged: true })
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },
}))

async function checkSound(
  token: string,
  detail: PrDetail,
  sound: ReviewSound,
): Promise<ReviewSound> {
  try {
    const bytes = await fetchBlobBytes(token, detail.headOwner, detail.headRepo, sound.sha)
    const format = identifyOgg(bytes.slice(0, OGG_PROBE_BYTES))
    const formatProblem = describeOggProblem(sound.name, format) ?? undefined

    // A file the format check rejects may still decode (48 kHz, say), and being
    // able to hear it is half the point, so decoding is attempted regardless.
    let buffer: AudioBuffer | undefined
    let audit: Audit | undefined
    try {
      const context = new OfflineAudioContext(1, 128, 44100)
      buffer = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
      const mono = buffer.getChannelData(0)
      audit = auditEnvelope(computeEnvelope(mono, buffer.sampleRate), buffer.duration)
    } catch {
      // Undecodable is already covered by the format problem.
    }

    return { ...sound, state: 'ready', format, formatProblem, audit, buffer }
  } catch (error) {
    return {
      ...sound,
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
