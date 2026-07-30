/**
 * Turning a transcript into a chatsounds trigger, and triggers into file paths.
 *
 * The rules here are not arbitrary -- they mirror what the addon actually does
 * at load time. `neo-chatsounds` (lua/neo-chatsounds/data.lua) derives the
 * trigger from the path with this chain:
 *
 *     key = chunk:lower()
 *                :gsub("%.ogg$", "")
 *                :gsub("[%_%-]", " ")
 *                :gsub("[%s\t\n\r]+", " ")
 *                :Trim()
 *
 * and the chat-side parser only strips `"` and `'` from what the user typed. So
 * a trigger containing any other punctuation is simply unreachable -- the
 * filename keeps the character, the typed message loses it, and they never
 * match. We strip punctuation up front so that never happens.
 *
 * Two more constraints come from the legacy preprocessor and the loader:
 *   - paths must be all lowercase (non-lowercase paths are rejected outright);
 *   - variations inside a trigger folder are ordered by URL, alphabetically, so
 *     1/2/.../10 sorts as 1, 10, 2 -- zero-padding keeps :select(n) stable.
 */

/**
 * Quote-like characters vanish rather than becoming a space, so "don't" reads as
 * "dont" and not "don t". Everything else non-alphanumeric becomes a separator.
 */
const QUOTES = /['‘’ʼ`´"“”]/g
const NON_TRIGGER = /[^a-z0-9]+/g

/**
 * "sh" is claimed by the addon for stopping playback, so a sound named "sh" can
 * never be triggered. The rest are Windows reserved device names: a repo
 * containing `con.ogg` cannot be checked out on Windows at all.
 */
export const RESERVED = new Set([
  'sh',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

export const DEFAULT_MAX_LENGTH = 100

/**
 * Normalise arbitrary transcript text into a usable chatsounds trigger.
 *
 * Returns an empty string when nothing usable survives; callers decide on the
 * fallback so it can be position-aware.
 */
export function sanitizeTrigger(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
  if (!text) return ''

  // Fold accents and compatibility forms down to ASCII: "café" -> "cafe",
  // "—" -> dropped. Anything with no ASCII equivalent is discarded.
  const folded = text
    .normalize('NFKD')
    .replace(QUOTES, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, '')

  let cleaned = folded.toLowerCase().replace(NON_TRIGGER, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''

  cleaned = truncateOnWord(cleaned, maxLength)
  return RESERVED.has(cleaned) ? `${cleaned} sound` : cleaned
}

function truncateOnWord(text: string, maxLength: number): string {
  if (maxLength <= 0 || text.length <= maxLength) return text
  const head = text.slice(0, maxLength)
  if (head.includes(' ')) {
    // Prefer cutting at the last whole word, unless that leaves almost nothing
    // (a single very long word at the front).
    const trimmed = head.slice(0, head.lastIndexOf(' ')).trimEnd()
    if (trimmed) return trimmed
  }
  return head.trimEnd()
}

/** Name for a segment whose transcript was empty or all punctuation. */
export function fallbackTrigger(position: number): string {
  return `line ${String(position + 1).padStart(3, '0')}`
}

/**
 * Normalise a newly typed realm name to the repo's convention.
 *
 * A realm is a folder in the chatsounds repo, and unlike triggers it is only
 * lowercased at load time -- no underscore-to-space step -- so snake_case is both
 * allowed and the established convention (`2000s_memes`, `portal_turret`). A few
 * grandfathered folders contain spaces, which is why names picked from the
 * existing list are taken verbatim and only *new* ones come through here.
 *
 * Returns '' rather than inventing a fallback: an unusable realm name is the
 * caller's problem to surface, not to paper over.
 */
export function sanitizeRealm(name: string): string {
  const folded = (name || '')
    .normalize('NFKD')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
  const cleaned = folded
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
    .replace(/_+$/, '')
  if (!cleaned || RESERVED.has(cleaned)) return ''
  return cleaned
}

/**
 * Make a name safe to hand to a download.
 *
 * Nothing like as strict as `sanitizeTrigger`: this names the zip, not a sound, so
 * the addon never reads it and case and spaces can stay as typed. What has to go
 * is anything a filesystem would refuse or read as a path -- the Windows-illegal
 * set, separators, control characters -- and the leading dot that would make the
 * file hidden.
 */
export function safeFileName(name: string, fallback = 'clips'): string {
  const cleaned = (name || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    // Trailing dots and spaces are legal to create on Windows and then
    // impossible to open.
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 80).trim() || fallback
}

/**
 * Reimplementation of the addon's own derivation, for verification.
 *
 * `name` is a single path chunk -- either `<trigger>.ogg` or a folder name.
 * Round-tripping our output through this must be a no-op; the tests assert it.
 */
export function neoChatsoundsKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.ogg$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/[\s\t\n\r]+/g, ' ')
    .trim()
}

/** Where one segment ends up inside the pack folder. */
export interface PlacedSegment {
  segmentId: string
  trigger: string
  /** Path relative to the pack folder, e.g. "hello there.ogg" or "yes/01.ogg". */
  relativePath: string
  /** Index within a variation group, 1-based. 0 when the file stands alone. */
  variation: number
}

/**
 * Lay out `[segmentId, trigger]` pairs as chatsounds files.
 *
 * A trigger used once stays a flat `<trigger>.ogg`. The moment it is used more
 * than once, every file carrying it moves into a `<trigger>/` folder as a
 * numbered variation -- which is exactly how the addon models "pick one of these
 * at random".
 *
 * Input order is preserved, and variations are numbered in that order.
 */
export function resolvePaths(segments: [string, string][]): PlacedSegment[] {
  const counts = new Map<string, number>()
  for (const [, trigger] of segments) {
    counts.set(trigger, (counts.get(trigger) ?? 0) + 1)
  }

  // Zero-pad wide enough that alphabetical order matches numeric order, since
  // the addon sorts variations by URL.
  const widths = new Map<string, number>()
  for (const [trigger, count] of counts) {
    widths.set(trigger, Math.max(2, String(count).length))
  }

  const seen = new Map<string, number>()
  return segments.map(([segmentId, trigger]) => {
    if (counts.get(trigger) === 1) {
      return { segmentId, trigger, relativePath: `${trigger}.ogg`, variation: 0 }
    }
    const index = (seen.get(trigger) ?? 0) + 1
    seen.set(trigger, index)
    const name = String(index).padStart(widths.get(trigger)!, '0')
    return { segmentId, trigger, relativePath: `${trigger}/${name}.ogg`, variation: index }
  })
}
