/**
 * Turning segments into named files, and those into a zip.
 *
 * The tree is flat: one `.ogg` per clip, at the top level. Where the clips are
 * meant to end up in a repository is not decided here -- that is the job of
 * whatever publishes them -- so nothing in this file knows about a folder to sit
 * under. The one exception is clips that share a name, which cannot share a
 * filename either, so they group into a numbered folder. That grouping is not a
 * workaround: it is exactly what the addon reads as "pick one of these".
 */

import { zipSync } from 'fflate'
import {
  type PlacedSegment,
  fallbackTrigger,
  resolvePaths,
  sanitizeTrigger,
} from './naming'

export interface PackSegment {
  id: string
  position: number
  startS: number
  endS: number
  trigger: string
  enabled: boolean
  flags: string[]
}

export interface ManifestEntry extends PlacedSegment {
  durationS: number
  flags: string[]
}

export interface Manifest {
  entries: ManifestEntry[]
  /** Triggers that ended up with more than one file. */
  variationGroups: Record<string, number>
  warnings: string[]
}

/** Pair each included segment with the path it will occupy. */
export function place(segments: PackSegment[]): [PackSegment, PlacedSegment][] {
  const included = segments.filter((segment) => segment.enabled)
  const placed = resolvePaths(
    included.map(
      (segment) =>
        [
          segment.id,
          sanitizeTrigger(segment.trigger) || fallbackTrigger(segment.position),
        ] as [string, string],
    ),
  )
  return included.map((segment, index) => [segment, placed[index]])
}

export function buildManifest(segments: PackSegment[]): Manifest {
  const pairs = place(segments)

  const counts = new Map<string, number>()
  for (const [, placement] of pairs) {
    counts.set(placement.trigger, (counts.get(placement.trigger) ?? 0) + 1)
  }

  const entries: ManifestEntry[] = pairs.map(([segment, placement]) => ({
    ...placement,
    durationS: round3(segment.endS - segment.startS),
    flags: [...(segment.flags ?? [])],
  }))

  const warnings: string[] = []
  if (entries.length === 0) {
    warnings.push('Nothing to save: every clip has been left out.')
  }

  const silent = pairs.filter(([segment]) => segment.flags?.includes('no_speech')).length
  if (silent) {
    warnings.push(
      silent === 1
        ? '1 clip still has a placeholder name, because nothing was heard in it.'
        : `${silent} clips still have placeholder names, because nothing was heard in them.`,
    )
  }

  const long = pairs.filter(([segment]) => segment.flags?.includes('too_long')).length
  if (long) {
    warnings.push(
      long === 1
        ? '1 clip is quite long. It will play fine, but it may hold more than one line.'
        : `${long} clips are quite long. They will play fine, but they may hold more than one line.`,
    )
  }

  const variationGroups: Record<string, number> = {}
  for (const [trigger, count] of counts) {
    if (count > 1) variationGroups[trigger] = count
  }
  const groupCount = Object.keys(variationGroups).length
  if (groupCount) {
    warnings.push(
      groupCount === 1
        ? '1 name is shared by several clips, so the game will pick one of them at random.'
        : `${groupCount} names are shared by several clips, so the game picks one at random.`,
    )
  }

  return { entries, variationGroups, warnings }
}

/**
 * Zip the clips.
 *
 * `clips` maps segment id to its already-encoded ogg. Vorbis is compressed
 * already, so everything is stored rather than deflated -- it saves a full pass
 * over what can be thousands of files and costs nothing in size.
 */
export function buildZip(
  segments: PackSegment[],
  clips: Map<string, Uint8Array>,
): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0 }]> = {}

  for (const [segment, placement] of place(segments)) {
    const clip = clips.get(segment.id)
    if (clip) files[placement.relativePath] = [clip, { level: 0 }]
  }

  return zipSync(files)
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
