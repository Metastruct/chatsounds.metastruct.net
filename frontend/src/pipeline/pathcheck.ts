/**
 * What a reviewer should be warned about in a file's *path*, before hearing a
 * single sample.
 *
 * The game derives the trigger from the path (see the header of naming.ts for
 * the exact chain), so a file in the wrong place loads fine and then does the
 * wrong thing: `realm/1.ogg` registers the trigger "1" instead of being a
 * variation, `realm/what?.ogg` registers a trigger nobody can type. These
 * checks replay the addon's derivation on each changed path and flag the
 * outcomes a human would want to veto.
 */

import { REALM_ROOT } from '../lib/github'
import { neoChatsoundsKey, RESERVED } from './naming'

export type PathFlag =
  | 'no_realm'
  | 'uppercase'
  | 'reserved'
  | 'numeric_key'
  | 'empty_key'
  | 'unreachable'
  | 'deep_nesting'
  | 'unpadded'
  | 'bang_override'

export type PathSeverity = 'danger' | 'warning' | 'info'

export const PATH_FLAG_SEVERITY: Record<PathFlag, PathSeverity> = {
  no_realm: 'danger',
  uppercase: 'danger',
  reserved: 'danger',
  numeric_key: 'danger',
  empty_key: 'warning',
  unreachable: 'warning',
  deep_nesting: 'warning',
  unpadded: 'warning',
  bang_override: 'info',
}

/** Short tag text, in the register of the existing 'long' and 'silence' tags. */
export const PATH_FLAG_LABEL: Record<PathFlag, string> = {
  no_realm: 'no realm',
  uppercase: 'uppercase',
  reserved: 'reserved',
  numeric_key: 'numeric name',
  empty_key: 'no trigger',
  unreachable: 'untypeable',
  deep_nesting: 'nested',
  unpadded: 'unpadded',
  bang_override: '! name',
}

export interface PathCheck {
  /** First folder under autoadd/, '' when the file sits at the root. */
  realm: string
  /** The trigger the game will derive, '' when nothing survives. */
  key: string
  /** Characters in the key the chat parser cannot produce. */
  badChars: string[]
  flags: PathFlag[]
}

/** Windows device names break checkout wherever they appear, not just as keys. */
const DEVICES = new Set([...RESERVED].filter((name) => name !== 'sh'))

export function checkPath(path: string): PathCheck {
  const flags: PathFlag[] = []
  if (/[A-Z]/.test(path)) flags.push('uppercase')

  // Everything below describes what the game does after the case is fixed.
  const lower = path.toLowerCase()
  const relative = lower.startsWith(`${REALM_ROOT}/`) ? lower.slice(REALM_ROOT.length + 1) : lower
  const chunks = relative.split('/')
  const filename = chunks[chunks.length - 1]

  if (chunks.length === 1) {
    flags.push('no_realm')
    return { realm: '', key: neoChatsoundsKey(filename), badChars: [], flags }
  }

  const realm = chunks[0]

  // The addon's derivation: the second chunk names the trigger, whether it is
  // the file itself or a folder of variations. Deeper than that and the file's
  // parent folder wins; a `!` filename beats both.
  let key: string
  if (filename.startsWith('!')) {
    key = neoChatsoundsKey(filename.slice(1))
    flags.push('bang_override')
  } else if (chunks.length > 3) {
    key = neoChatsoundsKey(chunks[chunks.length - 2])
    flags.push('deep_nesting')
  } else {
    key = neoChatsoundsKey(chunks[1])
  }

  let badChars: string[] = []
  if (!key) {
    flags.push('empty_key')
  } else {
    if (/^\d+$/.test(key)) flags.push('numeric_key')
    badChars = [...new Set(key.replace(/[a-z0-9 ]/g, ''))]
    if (badChars.length > 0) flags.push('unreachable')
  }

  if (key === 'sh' || chunks.some((chunk) => DEVICES.has(chunk.replace(/\.ogg$/, '')))) {
    flags.push('reserved')
  }

  return { realm, key, badChars, flags }
}

/**
 * Numbered variations the addon will play out of order: it sorts by URL as
 * text, so 1, 10, 2. Only looks at siblings within the given paths, the rest
 * of the repo is not visible here.
 */
export function unpaddedVariations(paths: string[]): Set<string> {
  const groups = new Map<string, string[]>()
  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    if (slash < 0) continue
    const stem = path.slice(slash + 1).toLowerCase().replace(/\.ogg$/, '')
    if (!/^\d+$/.test(stem)) continue
    const group = groups.get(path.slice(0, slash)) ?? []
    group.push(path)
    groups.set(path.slice(0, slash), group)
  }

  const flagged = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const widths = new Set(
      group.map((path) => path.slice(path.lastIndexOf('/') + 1).replace(/\.ogg$/i, '').length),
    )
    if (widths.size > 1) for (const path of group) flagged.add(path)
  }
  return flagged
}

/** One sentence a reviewer can act on, shown as the tag tooltip. */
export function describePathFlag(check: PathCheck, flag: PathFlag): string {
  switch (flag) {
    case 'no_realm':
      return 'an .ogg directly under autoadd/ has no realm folder and crashes the game loader, move it into a realm'
    case 'uppercase':
      return 'the repo is all lowercase and CI rejects paths with uppercase characters'
    case 'reserved':
      return check.key === 'sh'
        ? '"sh" is the stop-sound command, a sound with this trigger can never play'
        : 'con, prn, aux, nul, comN and lptN are Windows device names, a repo containing one cannot be checked out on Windows'
    case 'numeric_key':
      return `the game registers this as the trigger "${check.key}", a bare number is almost always a misplaced variation that belongs in ${check.realm || '<realm>'}/<sound name>/${check.key}.ogg`
    case 'empty_key':
      return 'the name normalizes to nothing, the game silently skips this file'
    case 'unreachable':
      return `the trigger "${check.key}" contains ${check.badChars.join(' ')} which cannot be typed in chat, so this sound can never be played`
    case 'deep_nesting':
      return `folders between the realm and "${check.key}" are ignored, the trigger is just "${check.key}"`
    case 'bang_override':
      return `the ! makes the filename the trigger ("${check.key}"), only neo-chatsounds understands this, the legacy preprocessor does not`
    case 'unpadded':
      return 'variations sort by name as text (1, 10, 2), zero-padding (01, 02, 10) keeps :select(n) stable'
  }
}
