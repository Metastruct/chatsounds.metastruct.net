/**
 * The sound index, shaped the way the game sees it.
 *
 * A path is not the trigger: `realm/oh_no.ogg` and `realm/oh_no/01.ogg` both
 * register "oh no", underscores become spaces, a leading `!` overrides the
 * folder, and folders between the realm and the file are ignored. Showing the
 * raw directory listing would therefore show something nobody can type, so the
 * tree is built by running every path through `checkPath` -- the same
 * derivation the review tab warns against -- and grouping realm, trigger,
 * variations.
 *
 * Everything here is pure and works on the whole 38,000-file index at once, so
 * it stays out of React: the tab builds once, filters on every keystroke, and
 * hands a flat row array to a component that only knows how to draw rows.
 */

import { checkPath } from '../pipeline/pathcheck'
import type { SoundFile } from './soundIndex'

/** Files that never made it into a realm, kept visible rather than dropped. */
export const NO_REALM = '(no realm)'

export interface ExploreSound {
  /** Relative to `REALM_ROOT`, and the identity used for playback state. */
  path: string
  sha: string
  /** The filename without its extension, which is what a variation is called. */
  name: string
}

export interface ExploreTrigger {
  key: string
  sounds: ExploreSound[]
}

export interface ExploreRealm {
  name: string
  triggers: ExploreTrigger[]
  soundCount: number
}

function stem(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.ogg$/i, '')
}

export function buildExploreTree(files: SoundFile[]): ExploreRealm[] {
  const byRealm = new Map<string, Map<string, ExploreSound[]>>()

  for (const file of files) {
    const { realm, key } = checkPath(file.path)
    const realmName = realm || NO_REALM
    // A file whose name normalizes to nothing has no trigger to sit under, so
    // it is listed by filename instead of vanishing from the tree.
    const triggerKey = key || stem(file.path)

    let triggers = byRealm.get(realmName)
    if (!triggers) {
      triggers = new Map()
      byRealm.set(realmName, triggers)
    }
    const sounds = triggers.get(triggerKey)
    const sound: ExploreSound = { path: file.path, sha: file.sha, name: stem(file.path) }
    if (sounds) sounds.push(sound)
    else triggers.set(triggerKey, [sound])
  }

  const realms: ExploreRealm[] = []
  for (const [name, triggers] of byRealm) {
    let soundCount = 0
    const built: ExploreTrigger[] = []
    for (const [key, sounds] of triggers) {
      // Textual, not numeric: the addon sorts variations by URL as text and
      // plays them 1, 10, 2. The tree shows what happens, not what was meant.
      sounds.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      soundCount += sounds.length
      built.push({ key, sounds })
    }
    built.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    realms.push({ name, triggers: built, soundCount })
  }

  realms.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  // Last rather than first: it is a bug list, not a realm anyone browses to.
  const orphans = realms.findIndex((realm) => realm.name === NO_REALM)
  if (orphans >= 0) realms.push(...realms.splice(orphans, 1))
  return realms
}

/**
 * Realms and triggers matching the query, in the same order as the full tree.
 *
 * The query is one substring, not words: trigger keys contain spaces, so
 * "go home" has to match "go home and die" rather than being split. Matching a
 * realm's name keeps everything in it, which is how someone browses a realm
 * they already know the name of.
 */
export function filterExploreTree(realms: ExploreRealm[], query: string): ExploreRealm[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return realms

  const kept: ExploreRealm[] = []
  for (const realm of realms) {
    if (realm.name.includes(needle)) {
      kept.push(realm)
      continue
    }
    const triggers = realm.triggers.filter((trigger) => trigger.key.includes(needle))
    if (triggers.length === 0) continue
    let soundCount = 0
    for (const trigger of triggers) soundCount += trigger.sounds.length
    kept.push({ name: realm.name, triggers, soundCount })
  }
  return kept
}

/**
 * The tree as a flat list of rows, one per visible line.
 *
 * Flat because a fully expanded tree is 42,000 rows long, and the only way to
 * draw that at speed is to window a slice of an array. Nesting lives in
 * `depth`, which is a left padding and nothing more.
 *
 * Every row states its own height, and a realm's first and last rows carry
 * equal padding so the block is evenly spaced top and bottom. That is the whole
 * reason heights vary: the alternative, a blank row after each realm, can only
 * put space at one end.
 */

/** The header of a realm, and the rows under it. */
export const REALM_H = 34
export const ROW_H = 28
/** Above a realm's first row and below its last, in equal measure. */
export const REALM_PAD = 7

export type ExploreRow =
  | {
      kind: 'realm'
      key: string
      name: string
      soundCount: number
      triggerCount: number
      collapsed: boolean
      height: number
    }
  | { kind: 'group'; key: string; label: string; count: number; height: number; pad: Pad }
  | {
      kind: 'sound'
      key: string
      label: string
      sound: ExploreSound
      depth: 1 | 2
      height: number
      pad: Pad
    }

export interface Pad {
  top: boolean
  bottom: boolean
}

const NO_PAD: Pad = { top: false, bottom: false }

/**
 * `expanded` names the realms to show the contents of; every other realm is
 * one header row. Omitting it opens everything, which is what the tests and
 * any caller with nothing to fold want.
 */
export function flattenRows(realms: ExploreRealm[], expanded?: ReadonlySet<string>): ExploreRow[] {
  const rows: ExploreRow[] = []
  for (const realm of realms) {
    const isOpen = expanded === undefined || expanded.has(realm.name)
    rows.push({
      kind: 'realm',
      key: `r:${realm.name}`,
      name: realm.name,
      soundCount: realm.soundCount,
      triggerCount: realm.triggers.length,
      collapsed: !isOpen,
      height: REALM_H,
    })
    if (!isOpen) continue

    const first = rows.length
    for (const trigger of realm.triggers) {
      // A lone sound is its own trigger: a "1 variation" folder row above it
      // would say nothing the row below does not already say.
      if (trigger.sounds.length === 1) {
        rows.push({
          kind: 'sound',
          key: trigger.sounds[0].path,
          label: trigger.key,
          sound: trigger.sounds[0],
          depth: 1,
          height: ROW_H,
          pad: NO_PAD,
        })
        continue
      }
      rows.push({
        kind: 'group',
        key: `g:${realm.name}/${trigger.key}`,
        label: trigger.key,
        count: trigger.sounds.length,
        height: ROW_H,
        pad: NO_PAD,
      })
      for (const sound of trigger.sounds) {
        rows.push({
          kind: 'sound',
          key: sound.path,
          label: sound.name,
          sound,
          depth: 2,
          height: ROW_H,
          pad: NO_PAD,
        })
      }
    }
    // One row can be both the first and the last, and then it takes both.
    padRow(rows[first], 'top')
    padRow(rows[rows.length - 1], 'bottom')
  }
  return rows
}

function padRow(row: ExploreRow | undefined, edge: 'top' | 'bottom'): void {
  if (!row || row.kind === 'realm') return
  row.pad = { ...row.pad, [edge]: true }
  row.height += REALM_PAD
}

/** Totals for the line under the search bar. */
export function countSounds(realms: ExploreRealm[]): number {
  let total = 0
  for (const realm of realms) total += realm.soundCount
  return total
}
