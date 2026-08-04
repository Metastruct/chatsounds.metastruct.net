/**
 * Every sound in the repo, in one request.
 *
 * The Git trees API takes a `branch:path` ref, so asking for
 * `master:sound/chatsounds/autoadd` recursively returns just that subtree with
 * paths already relative to it: ~38,000 .ogg files, about 2 MB gzipped, in a
 * single call that needs no token. Walking the contents API realm by realm
 * would be 900 calls against a 60-an-hour limit, which is not a page anyone
 * could open twice.
 *
 * That one call is still expensive enough to be worth keeping. The index goes
 * to localStorage as `path\tsha` lines rather than the API's JSON, which is
 * three times the size and would not fit the quota. It is kept for a day
 * (realms.ts keeps its list for an hour, but that one is a 30 KB fetch feeding
 * an autocomplete), and a stale copy beats an empty tree: sounds that landed
 * this morning are worth missing to keep the tab openable offline.
 */

import { REALM_ROOT, UPSTREAM } from './github'

/** One sound, its path relative to `REALM_ROOT`. */
export interface SoundFile {
  path: string
  sha: string
}

export interface SoundIndex {
  files: SoundFile[]
  /** GitHub gave up partway: the tree exceeded its 100k entry / 7 MB ceiling. */
  truncated: boolean
}

const CACHE_KEY = 'chatsounds-sound-index'
const FRESH_MS = 24 * 60 * 60 * 1000

interface Cached {
  at: number
  truncated: boolean
  lines: string
}

/** Tab-separated because a path can contain spaces, but never a tab. */
export function encodeLines(files: SoundFile[]): string {
  return files.map((file) => `${file.path}\t${file.sha}`).join('\n')
}

export function decodeLines(text: string): SoundFile[] {
  if (!text) return []
  const files: SoundFile[] = []
  for (const line of text.split('\n')) {
    const tab = line.lastIndexOf('\t')
    if (tab < 0) continue
    files.push({ path: line.slice(0, tab), sha: line.slice(tab + 1) })
  }
  return files
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Cached
    return typeof parsed.lines === 'string' ? parsed : null
  } catch {
    return null
  }
}

function writeCache(index: SoundIndex): void {
  try {
    const cached: Cached = {
      at: Date.now(),
      truncated: index.truncated,
      lines: encodeLines(index.files),
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached))
  } catch {
    // Private browsing, or the quota. `memo` still covers this session.
  }
}

// Survives a failed cache write, and spares a reopened tab the parse.
let memo: SoundIndex | null = null
let inFlight: Promise<SoundIndex> | null = null

export function fetchSoundIndex(token: string | null): Promise<SoundIndex> {
  if (memo) return Promise.resolve(memo)

  const cached = readCache()
  if (cached && Date.now() - cached.at < FRESH_MS) {
    memo = { files: decodeLines(cached.lines), truncated: cached.truncated }
    return Promise.resolve(memo)
  }

  inFlight ??= (async () => {
    try {
      const ref = encodeURIComponent(`${UPSTREAM.branch}:${REALM_ROOT}`)
      const url = `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/git/trees/${ref}?recursive=1`
      const response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`)

      const body = (await response.json()) as {
        tree: { path: string; type: string; sha: string }[]
        truncated?: boolean
      }
      const index: SoundIndex = {
        files: body.tree
          .filter((entry) => entry.type === 'blob' && entry.path.toLowerCase().endsWith('.ogg'))
          .map((entry) => ({ path: entry.path, sha: entry.sha })),
        truncated: body.truncated === true,
      }
      writeCache(index)
      memo = index
      return index
    } catch (error) {
      if (cached) {
        memo = { files: decodeLines(cached.lines), truncated: cached.truncated }
        return memo
      }
      throw error
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}
