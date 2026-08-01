/**
 * The Review tab's state: which PR, what is in it, and what the checks found.
 *
 * Selecting a PR pulls its file list, then every sound's bytes from the head
 * repo, then runs the same format rules the Upload form enforces plus the
 * audio audit (length, silence). The decoded AudioBuffer is kept on each entry
 * so playing a sound is instant; chatsounds are seconds long, so a whole PR's
 * worth of decoded audio is smaller than one Extract recording.
 *
 * Denials post immediately, and land on the file they are about rather than in
 * the conversation, so the author reads each objection beside the sound that
 * earned it. The pull request is put into changes-requested alongside the first
 * one; a second red review on top of a red one says nothing new.
 */

import { create } from 'zustand'
import {
  type FileComment,
  type PrDetail,
  type PrStatus,
  type PrSummary,
  type ReviewEntry,
  REALM_ROOT,
  canPush,
  closePr,
  fetchBlobBytes,
  fileRefFromComment,
  getPrDetail,
  listFileComments,
  listOpenPrs,
  listPrComments,
  listPrFiles,
  listReviews,
  mergePr,
  postFileComment,
  postPrComment,
  statusFrom,
  submitReview,
} from '../lib/github'
import { type Audit, auditEnvelope } from '../pipeline/audit'
import { computeEnvelope } from '../pipeline/envelope'
import { type OggInfo, OGG_PROBE_BYTES, describeOggProblem, identifyOgg } from '../pipeline/ogg'
import { type PathCheck, checkPath, sparseNewRealms, unpaddedVariations } from '../pipeline/pathcheck'
import { fetchRealms } from '../lib/realms'

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
  /** What the path itself means to the game, known before any bytes arrive. */
  pathCheck?: PathCheck
}

export interface OtherFile {
  path: string
  status: string
}

/** Anyone signed in may look; only push access may rule on anything. */
type Rights = 'unknown' | 'checking' | 'reviewer' | 'onlooker'

export interface PrListing extends PrSummary {
  /** Undefined until its reviews have been read. */
  status?: PrStatus
}

interface ReviewState {
  rights: Rights
  /** The token the rights were answered for; a different account asks again. */
  rightsFor: string | null
  prs: PrListing[] | null
  detail: PrDetail | null
  sounds: ReviewSound[]
  others: OtherFile[]
  /** New realms this PR creates with too few sounds, realm to trigger count. */
  sparseRealms: Record<string, number>
  reviews: ReviewEntry[]
  comments: FileComment[]
  /** Said about the pull request rather than about any one sound. */
  messages: GlobalMessage[]
  loading: string | null
  busy: boolean
  merged: boolean
  closed: boolean
  error: string | null

  checkAccess: (token: string) => Promise<void>
  loadPrs: (token: string) => Promise<void>
  open: (token: string, number: number) => Promise<void>
  close: () => void
  deny: (token: string, path: string, comment: string, myLogin: string) => Promise<void>
  denyAll: (token: string, comment: string, myLogin: string) => Promise<void>
  approveAll: (token: string, myLogin: string) => Promise<void>
  merge: (token: string) => Promise<void>
  /** Turn the request away without merging. `reason` may be empty. */
  turnAway: (token: string, reason: string) => Promise<void>
}

/** Something said about the pull request as a whole, rather than about a file. */
export interface GlobalMessage {
  id: string
  author: string
  body: string
  url: string
  /** A review's verdict, when it came with one. */
  state?: string
}

/**
 * Everything anyone has said, sorted into what is about a file and what is not.
 *
 * Three places carry text: comments attached to files, the conversation, and
 * the bodies of reviews. A denial can end up in any of them, so all three are
 * read and any that names a file, the way the deny fallback writes it, is shown
 * under that sound. What is left over is about the pull request as a whole,
 * which is how the reason behind a Deny all reaches the screen.
 */
async function readEverythingSaid(
  token: string,
  number: number,
  sounds: ReviewSound[],
  reviews: ReviewEntry[],
): Promise<{ comments: FileComment[]; messages: GlobalMessage[] }> {
  const [onFiles, conversation] = await Promise.all([
    listFileComments(token, number).catch(() => []),
    listPrComments(token, number).catch(() => []),
  ])

  const byRef = new Map(sounds.map((sound) => [`${sound.realm}/${sound.name}`, sound.path]))
  const comments: FileComment[] = [...onFiles]
  const messages: GlobalMessage[] = []

  const sort = (
    id: string,
    body: string,
    author: string,
    url: string,
    origin: FileComment['origin'],
    state?: string,
  ) => {
    if (!body.trim()) return
    const parsed = fileRefFromComment(body)
    const path = parsed && byRef.get(parsed.ref)
    if (parsed && path) comments.push({ id, path, body: parsed.text, author, url, origin })
    else messages.push({ id, author, body, url, state })
  }

  for (const comment of conversation) {
    sort(`c${comment.id}`, comment.body, comment.author, comment.url, 'conversation')
  }
  for (const review of reviews) {
    sort(`r${review.id}`, review.body, review.reviewer, review.url, 'review', review.state)
  }

  return { comments, messages }
}

/**
 * Show our own verdict at once, then let the server's answer settle in behind it.
 *
 * Waiting for the round trip made the buttons look stuck: GitHub takes a moment
 * to list a review it has just accepted, and until it did, nothing on screen had
 * changed.
 */
function withMyVerdict(reviews: ReviewEntry[], me: string, state: string): ReviewEntry[] {
  return [
    ...reviews.filter((review) => review.reviewer !== me),
    // A placeholder id: the refresh behind it replaces this with the real one.
    { id: 0, reviewer: me, state, body: '', submittedAt: new Date().toISOString(), url: '' },
  ]
}

export const useReview = create<ReviewState>((set, get) => ({
  rights: 'unknown',
  rightsFor: null,
  prs: null,
  detail: null,
  sounds: [],
  others: [],
  sparseRealms: {},
  reviews: [],
  comments: [],
  messages: [],
  loading: null,
  busy: false,
  merged: false,
  closed: false,
  error: null,

  async checkAccess(token) {
    const { rights, rightsFor } = get()
    // Same account, settled or being settled: nothing to redo. A different
    // token means someone signed out and back in, and their rights are their
    // own, as is what the last account was looking at.
    if (rightsFor === token && rights !== 'unknown') return
    set({
      rights: 'checking',
      rightsFor: token,
      prs: null,
      detail: null,
      sounds: [],
      others: [],
      sparseRealms: {},
      reviews: [],
      comments: [],
      messages: [],
      error: null,
    })
    try {
      set({ rights: (await canPush(token)) ? 'reviewer' : 'onlooker' })
    } catch {
      // Failing to answer is not proof of rights; the safe reading is no.
      set({ rights: 'onlooker' })
    }
  },

  async loadPrs(token) {
    try {
      const prs = await listOpenPrs(token)
      set({ prs, error: null })

      // Each status is its own request, so they are fetched after the list is
      // already on screen and fill in as they land. A pull request with no
      // status yet reads as waiting, which is what it is.
      await Promise.all(
        prs.map(async (pr) => {
          try {
            const status = statusFrom(await listReviews(token, pr.number))
            set((state) => ({
              prs: state.prs?.map((item) =>
                item.number === pr.number ? { ...item, status } : item,
              ) ?? null,
            }))
          } catch {
            /* one missing badge is not worth failing the list over */
          }
        }),
      )
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  async open(token, number) {
    set({
      detail: null,
      sounds: [],
      others: [],
      sparseRealms: {},
      reviews: [],
      comments: [],
      messages: [],
      merged: false,
      closed: false,
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
            pathCheck: checkPath(file.path),
          })
        } else {
          others.push({ path: file.path, status: file.status })
        }
      }

      // Ordering trouble only shows against the siblings, so it comes after.
      const unpadded = unpaddedVariations(sounds.map((sound) => sound.path))
      for (const sound of sounds) {
        if (unpadded.has(sound.path)) sound.pathCheck?.flags.push('unpadded')
      }

      // Attribution needs the sounds, so the comments come after them rather
      // than alongside.
      set({
        detail,
        sounds,
        others,
        reviews,
        merged: detail.merged,
        // It may already have been closed somewhere else, in which case none of
        // the buttons below should look available.
        closed: detail.state === 'closed' && !detail.merged,
      })
      void readEverythingSaid(token, number, sounds, reviews).then((said) => {
        set((state) => (state.detail?.number === number ? said : {}))
      })

      // Realm list comes from cache or one unauthenticated call; a new realm
      // holding only a sound or two usually gets denied, so say so up front.
      void fetchRealms().then((existing) => {
        if (get().detail?.number !== number) return
        const checks = sounds.flatMap((sound) => sound.pathCheck ?? [])
        set({ sparseRealms: Object.fromEntries(sparseNewRealms(checks, existing)) })
      })

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
    set({
      detail: null,
      sounds: [],
      others: [],
      sparseRealms: {},
      reviews: [],
      comments: [],
      messages: [],
      loading: null,
      error: null,
    })
  },

  /**
   * Turn down one sound, with the objection attached to that file.
   *
   * The comment goes on the file rather than into the conversation, so the
   * author reads it next to the sound it is about instead of matching filenames
   * out of a list. The pull request is separately put into changes-requested,
   * but only if this reviewer has not already done so: a second red review on
   * top of a red one says nothing new.
   */
  async deny(token, path, comment, myLogin) {
    const { detail, reviews, sounds } = get()
    const sound = sounds.find((item) => item.path === path)
    if (!detail || !sound) return
    set({ busy: true, error: null })

    try {
      let posted: FileComment | null = null
      try {
        posted = await postFileComment(token, detail.number, detail.headSha, path, comment)
      } catch {
        // A file comment is the point, but losing the objection would be worse
        // than putting it somewhere less convenient, so it falls back to the
        // conversation with the filename spelled out.
        await postPrComment(token, detail.number, `\`${sound.realm}/${sound.name}\`: ${comment}`)
      }

      const mine = reviews.filter((review) => review.reviewer === myLogin)
      const alreadyRed = mine[mine.length - 1]?.state === 'CHANGES_REQUESTED'
      if (!alreadyRed) {
        await submitReview(
          token,
          detail.number,
          'REQUEST_CHANGES',
          'Some of these need another look; see the comments on the files.',
        )
      }

      set((state) => ({
        busy: false,
        sounds: state.sounds.map((item) =>
          item.path === path ? { ...item, denied: true } : item,
        ),
        comments: posted ? [...state.comments, posted] : state.comments,
        reviews: alreadyRed
          ? state.reviews
          : withMyVerdict(state.reviews, myLogin, 'CHANGES_REQUESTED'),
      }))
      void refresh(token, detail.number, set, get().sounds)
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async denyAll(token, comment, myLogin) {
    const { detail } = get()
    if (!detail) return
    set({ busy: true, error: null })
    try {
      await submitReview(token, detail.number, 'REQUEST_CHANGES', comment)
      set((state) => ({
        busy: false,
        sounds: state.sounds.map((item) => ({ ...item, denied: true })),
        reviews: withMyVerdict(state.reviews, myLogin, 'CHANGES_REQUESTED'),
      }))
      void refresh(token, detail.number, set, get().sounds)
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async approveAll(token, myLogin) {
    const { detail } = get()
    if (!detail) return
    set({ busy: true, error: null })
    try {
      await submitReview(token, detail.number, 'APPROVE', '')
      set((state) => ({
        busy: false,
        reviews: withMyVerdict(state.reviews, myLogin, 'APPROVED'),
      }))
      void refresh(token, detail.number, set, get().sounds)
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async turnAway(token, reason) {
    const { detail } = get()
    if (!detail) return
    set({ busy: true, error: null })
    try {
      // The reason goes up first: closing without one leaves the author with a
      // shut door and no explanation, and once it is closed the comment reads
      // as an afterthought.
      if (reason.trim()) await postPrComment(token, detail.number, reason.trim())
      await closePr(token, detail.number)
      set((state) => ({
        busy: false,
        closed: true,
        // Gone from the list as well; it is no longer waiting on anyone.
        prs: state.prs?.filter((pr) => pr.number !== detail.number) ?? null,
      }))
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

/**
 * Reconcile with the server after an optimistic update, quietly.
 *
 * Nothing waits on this and a failure is swallowed: the screen already shows
 * the verdict that GitHub accepted, and an error here would only contradict a
 * change that did land. Also refreshes the row in the list behind the view.
 */
async function refresh(
  token: string,
  number: number,
  set: (partial: (state: ReviewState) => Partial<ReviewState>) => void,
  sounds: ReviewSound[],
): Promise<void> {
  try {
    const reviews = await listReviews(token, number)
    const said = await readEverythingSaid(token, number, sounds, reviews)
    const status = statusFrom(reviews)
    set((state) => ({
      // Only if this pull request is still the one open, or a fast click
      // elsewhere would be overwritten by an answer about the previous one.
      ...(state.detail?.number === number ? { reviews, ...said } : {}),
      prs: state.prs?.map((pr) => (pr.number === number ? { ...pr, status } : pr)) ?? null,
    }))
  } catch {
    /* the optimistic state stands */
  }
}

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
