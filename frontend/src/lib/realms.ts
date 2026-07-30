/**
 * The list of realms that already exist, straight from the repo.
 *
 * One GitHub contents API call returns every directory under
 * `sound/chatsounds/autoadd`, which is the whole realm list (~900 names). The
 * API allows 60 unauthenticated calls an hour per IP, so the answer is kept in
 * localStorage for an hour and a stale copy is better than none: the list only
 * feeds an autocomplete, and a name that landed in the repo minutes ago costs
 * nothing by being absent. With no network and no cache the list is empty and
 * typing still works, there are just no suggestions.
 */

const API_URL =
  'https://api.github.com/repos/Metastruct/garrysmod-chatsounds/contents/sound/chatsounds/autoadd'

const CACHE_KEY = 'chatsounds-realms'
const FRESH_MS = 60 * 60 * 1000

interface Cached {
  at: number
  realms: string[]
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Cached
    return Array.isArray(parsed.realms) ? parsed : null
  } catch {
    return null
  }
}

function writeCache(realms: string[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), realms }))
  } catch {
    // Private browsing, or the quota. The fetch just happens again next visit.
  }
}

let inFlight: Promise<string[]> | null = null

export function fetchRealms(): Promise<string[]> {
  const cached = readCache()
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.realms)

  inFlight ??= (async () => {
    try {
      const response = await fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json' },
      })
      // 403 is the rate limit talking; anything else non-OK is equally not
      // worth distinguishing to an autocomplete.
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
      const entries = (await response.json()) as { name: string; type: string }[]
      const realms = entries
        .filter((entry) => entry.type === 'dir')
        .map((entry) => entry.name)
        .sort()
      writeCache(realms)
      return realms
    } catch {
      return cached?.realms ?? []
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}
