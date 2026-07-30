/**
 * What a reviewer should be warned about in a sound, measured, not guessed.
 *
 * Two of the checks a human would otherwise do by ear: is it too long for a
 * chatsound, and is a chunk of it silence (a trailing tail from sloppy trimming
 * being the classic). Both come off the 200 Hz RMS envelope the extract
 * pipeline already knows how to compute, so auditing a sound costs one decode
 * and a linear scan.
 */

import type { Envelope } from './envelope'

export const AUDIT = {
  /** A chatsound longer than this is almost always a mistake. */
  maxDurationS: 30,
  /** RMS below this counts as silence. */
  silenceDb: -45,
  /** Leading plus trailing silence past this is worth a flag. */
  edgeSilenceS: 2,
  /** So is a sound that is mostly nothing. */
  silentFractionMax: 1 / 3,
} as const

export interface Audit {
  durationS: number
  leadingSilenceS: number
  trailingSilenceS: number
  /** 0..1, how much of the whole sound sits under the silence threshold. */
  silentFraction: number
  /** 'too_long' and/or 'much_silence'. Empty means nothing to say. */
  flags: string[]
}

export function auditEnvelope(envelope: Pick<Envelope, 'rms' | 'sampleRate'>, durationS: number): Audit {
  const threshold = 10 ** (AUDIT.silenceDb / 20)
  const frames = envelope.rms.length
  const frameS = 1 / envelope.sampleRate

  let leading = 0
  while (leading < frames && envelope.rms[leading] < threshold) leading += 1

  let trailing = 0
  while (trailing < frames - leading && envelope.rms[frames - 1 - trailing] < threshold) {
    trailing += 1
  }

  let silent = 0
  for (let i = 0; i < frames; i += 1) if (envelope.rms[i] < threshold) silent += 1

  const audit: Audit = {
    durationS,
    leadingSilenceS: leading * frameS,
    trailingSilenceS: trailing * frameS,
    silentFraction: frames ? silent / frames : 0,
    flags: [],
  }

  if (durationS > AUDIT.maxDurationS) audit.flags.push('too_long')
  if (
    audit.leadingSilenceS + audit.trailingSilenceS > AUDIT.edgeSilenceS ||
    audit.silentFraction > AUDIT.silentFractionMax
  ) {
    audit.flags.push('much_silence')
  }

  return audit
}

/** One line a reviewer can read instead of the numbers. */
export function describeAudit(audit: Audit): string | null {
  const parts: string[] = []
  if (audit.flags.includes('too_long')) {
    parts.push(`${audit.durationS.toFixed(1)}s long, over the ${AUDIT.maxDurationS}s limit`)
  }
  if (audit.flags.includes('much_silence')) {
    const edges: string[] = []
    if (audit.leadingSilenceS >= 0.5) edges.push(`${audit.leadingSilenceS.toFixed(1)}s of silence at the start`)
    if (audit.trailingSilenceS >= 0.5) edges.push(`${audit.trailingSilenceS.toFixed(1)}s at the end`)
    parts.push(
      edges.length
        ? edges.join(' and ')
        : `${Math.round(audit.silentFraction * 100)}% of it is silence`,
    )
  }
  return parts.length ? parts.join('; ') : null
}
