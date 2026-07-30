/**
 * Turning VAD intervals plus Whisper words into individual voice lines.
 *
 * Neither source is sufficient alone. Silero knows precisely *where* speech is
 * but nothing about what it says; Whisper knows the words but its own segment
 * boundaries are prosodic guesses that routinely glue two lines together or cut
 * mid-word. So we take silero's intervals as the skeleton, hang Whisper's words
 * on them, and use the word timings only to decide where a long interval should
 * be broken apart.
 */

import type { Envelope } from './envelope'

export const FLAG_NO_SPEECH = 'no_speech'
export const FLAG_TOO_LONG = 'too_long'
export const FLAG_VERY_SHORT = 'very_short'

/** Below this a clip is more likely a click than a word. */
export const VERY_SHORT_S = 0.15

export interface Word {
  start: number
  end: number
  text: string
}

export interface VoiceLine {
  start: number
  end: number
  text: string
  flags: string[]
}

interface Interval {
  start: number
  end: number
  words: Word[]
}

/**
 * How far a single word may push a VAD boundary outwards.
 *
 * VAD boundaries are measured from the waveform; word timings are estimated
 * from Whisper's cross-attentions and drift, badly so on small or heavily
 * quantised models. Letting a word widen its interval without limit means one
 * mistimed word can stretch a line over the silence and swallow the next one --
 * which is exactly how "hello" / "there i am a doctor" happens instead of
 * "hello there" / "i am a doctor". A word may nudge an edge; it may not redraw
 * it.
 */
const MAX_WIDEN_S = 0.25

export interface BuildOptions {
  durationS: number
  maxLineS?: number
  splitGapMs?: number
}

export function buildLines(
  speech: [number, number][],
  words: Word[],
  { durationS, maxLineS = 12, splitGapMs = 400 }: BuildOptions,
): VoiceLine[] {
  let intervals = mergeOverlaps(
    speech
      .slice()
      .sort((a, b) => a[0] - b[0])
      .map(([start, end]) => ({ start, end, words: [] as Word[] })),
  )
  intervals = attachWords(intervals, words, splitGapMs)
  intervals = mergeOverlaps(intervals)

  const lines: VoiceLine[] = []
  for (const interval of intervals) {
    lines.push(...splitLong(interval, maxLineS, splitGapMs / 1000))
  }

  for (const line of lines) {
    line.start = Math.max(0, line.start)
    if (durationS > 0) line.end = Math.min(durationS, line.end)
    applyFlags(line, maxLineS)
  }

  return lines.filter((line) => line.end - line.start > 0)
}

function mergeOverlaps(intervals: Interval[]): Interval[] {
  const merged: Interval[] = []
  for (const interval of intervals.slice().sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1]
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end)
      previous.words.push(...interval.words)
    } else {
      merged.push({ ...interval, words: [...interval.words] })
    }
  }
  for (const interval of merged) interval.words.sort((a, b) => a.start - b.start)
  return merged
}

/**
 * Hang each word on the interval it overlaps most, and rescue the rest.
 *
 * Whisper occasionally hears speech that silero scored below threshold -- a
 * whispered or heavily processed line. Those words would otherwise be dropped
 * silently, so any run of them becomes an interval of its own.
 */
function attachWords(intervals: Interval[], words: Word[], splitGapMs: number): Interval[] {
  const orphans: Word[] = []
  // Match against the bounds silero reported, not the widened ones, so the list
  // stays sorted while we sweep it.
  const bounds = intervals.map((interval) => [interval.start, interval.end] as const)
  let cursor = 0

  for (const word of words.slice().sort((a, b) => a.start - b.start)) {
    while (cursor < bounds.length && bounds[cursor][1] <= word.start) cursor += 1

    let bestIndex = -1
    let bestOverlap = 0
    for (let index = cursor; index < bounds.length && bounds[index][0] < word.end; index += 1) {
      const [start, end] = bounds[index]
      const overlap = Math.min(end, word.end) - Math.max(start, word.start)
      if (overlap > bestOverlap) {
        bestIndex = index
        bestOverlap = overlap
      }
    }

    if (bestIndex < 0) {
      orphans.push(word)
      continue
    }

    const best = intervals[bestIndex]
    const [measuredStart, measuredEnd] = bounds[bestIndex]
    best.words.push(word)
    // A word clipped by the interval edge usually means the edge was slightly
    // early or late, so nudge it -- but only within MAX_WIDEN_S of where the
    // audio said the speech actually was.
    best.start = Math.max(measuredStart - MAX_WIDEN_S, Math.min(best.start, word.start))
    best.end = Math.min(measuredEnd + MAX_WIDEN_S, Math.max(best.end, word.end))
  }

  for (const run of groupRuns(orphans, splitGapMs / 1000)) {
    intervals.push({ start: run[0].start, end: run[run.length - 1].end, words: [...run] })
  }
  return intervals
}

function groupRuns(words: Word[], gapS: number): Word[][] {
  const runs: Word[][] = []
  for (const word of words) {
    const current = runs[runs.length - 1]
    if (current && word.start - current[current.length - 1].end <= gapS) {
      current.push(word)
    } else {
      runs.push([word])
    }
  }
  return runs
}

/** Break an over-long interval at its most balanced internal pause. */
function splitLong(interval: Interval, maxLineS: number, gapS: number): VoiceLine[] {
  if (interval.end - interval.start <= maxLineS || interval.words.length < 2) {
    return [toLine(interval)]
  }

  const middle = (interval.start + interval.end) / 2
  let bestIndex: number | null = null
  let bestDistance = Infinity

  for (let index = 0; index < interval.words.length - 1; index += 1) {
    const left = interval.words[index]
    const right = interval.words[index + 1]
    if (right.start - left.end < gapS) continue
    const distance = Math.abs((left.end + right.start) / 2 - middle)
    if (distance < bestDistance) {
      bestIndex = index
      bestDistance = distance
    }
  }

  if (bestIndex === null) {
    // Continuous speech longer than the limit: nothing to cut on, so leave it
    // whole and let the flag tell the user to split it by hand.
    return [toLine(interval)]
  }

  const cut = (interval.words[bestIndex].end + interval.words[bestIndex + 1].start) / 2
  const head: Interval = {
    start: interval.start,
    end: cut,
    words: interval.words.slice(0, bestIndex + 1),
  }
  const tail: Interval = {
    start: cut,
    end: interval.end,
    words: interval.words.slice(bestIndex + 1),
  }
  return [...splitLong(head, maxLineS, gapS), ...splitLong(tail, maxLineS, gapS)]
}

function toLine(interval: Interval): VoiceLine {
  return {
    start: interval.start,
    end: interval.end,
    text: interval.words
      .map((word) => word.text)
      .join(' ')
      .trim(),
    flags: [],
  }
}

function applyFlags(line: VoiceLine, maxLineS: number): void {
  const flags: string[] = []
  const duration = line.end - line.start
  if (!line.text) flags.push(FLAG_NO_SPEECH)
  if (duration > maxLineS) flags.push(FLAG_TOO_LONG)
  if (duration < VERY_SHORT_S) flags.push(FLAG_VERY_SHORT)
  line.flags = flags
}

// --- boundary snapping ------------------------------------------------------

/**
 * Move one boundary to the quietest point within `windowS` of it.
 *
 * Clamped to `[lowerS, upperS]` so a boundary can never cross into its
 * neighbour. Returns the input unchanged when there is nothing to search.
 */
export function snapEdge(
  envelope: Envelope,
  timeS: number,
  { lowerS, upperS, windowS }: { lowerS: number; upperS: number; windowS: number },
): number {
  if (envelope.rms.length === 0) return timeS

  const low = Math.max(lowerS, timeS - windowS)
  const high = Math.min(upperS, timeS + windowS)
  if (high <= low) return timeS

  const first = Math.max(0, frameAt(envelope, low))
  const last = Math.min(envelope.rms.length, frameAt(envelope, high) + 1)
  if (last <= first) return timeS

  let bestIndex = first
  let bestValue = Infinity
  for (let index = first; index < last; index += 1) {
    if (envelope.rms[index] < bestValue) {
      bestValue = envelope.rms[index]
      bestIndex = index
    }
  }
  return round4(bestIndex * frameSeconds(envelope))
}

/** Snap every boundary, keeping lines ordered and non-overlapping. */
export function snapLines(
  lines: VoiceLine[],
  envelope: Envelope,
  windowMs: number,
  durationS: number,
): VoiceLine[] {
  const windowS = windowMs / 1000
  lines.forEach((line, index) => {
    const previousEnd = index > 0 ? lines[index - 1].end : 0
    const nextStart = index + 1 < lines.length ? lines[index + 1].start : durationS

    const start = snapEdge(envelope, line.start, {
      lowerS: previousEnd,
      upperS: line.end,
      windowS,
    })
    const end = snapEdge(envelope, line.end, {
      lowerS: Math.max(start, line.start),
      upperS: nextStart > 0 ? nextStart : line.end + windowS,
      windowS,
    })
    if (end > start) {
      line.start = start
      line.end = end
    }
  })
  return lines
}

function frameSeconds(envelope: Envelope): number {
  return envelope.hop / envelope.sampleRate
}

function frameAt(envelope: Envelope, seconds: number): number {
  return Math.round(seconds / frameSeconds(envelope))
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}
