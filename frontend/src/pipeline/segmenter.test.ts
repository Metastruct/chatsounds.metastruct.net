import { describe, expect, it } from 'vitest'
import type { Envelope } from './envelope'
import {
  FLAG_NO_SPEECH,
  FLAG_TOO_LONG,
  FLAG_VERY_SHORT,
  type Word,
  buildLines,
  snapEdge,
  snapLines,
} from './segmenter'

const word = (start: number, end: number, text = 'x'): Word => ({ start, end, text })

function build(
  speech: [number, number][],
  words: Word[],
  options: Partial<{ durationS: number; maxLineS: number; splitGapMs: number }> = {},
) {
  return buildLines(speech, words, { durationS: 100, ...options })
}

describe('word assignment', () => {
  it('puts words in their interval', () => {
    const lines = build(
      [
        [1, 2],
        [5, 6],
      ],
      [word(1.1, 1.4, 'hello'), word(1.5, 1.9, 'there'), word(5.1, 5.8, 'yes')],
    )
    expect(lines.map((l) => l.text)).toEqual(['hello there', 'yes'])
  })

  it('widens an interval to contain a clipped word', () => {
    // Silero cut at 2.0 but the word runs to 2.2; cutting there would chop the
    // syllable, so the boundary moves rather than the audio.
    const lines = build([[1, 2]], [word(1.8, 2.2, 'wait')])
    expect(lines[0].end).toBeCloseTo(2.2)
  })

  it('caps how far a mistimed word can drag a boundary', () => {
    // Word timings drift on small models. Without a cap, one badly placed word
    // stretches its line across the silence and swallows the next one.
    const lines = build([[1, 2]], [word(1.5, 4.0, 'drifted')])
    expect(lines[0].end).toBeLessThanOrEqual(2.25 + 1e-6)
  })

  it('keeps neighbouring lines apart when a word is mistimed', () => {
    // The real failure this guards: "hello" / "there i am a doctor" instead of
    // "hello there" / "i am a doctor".
    const lines = build(
      [
        [1, 2],
        [3, 4],
      ],
      [
        word(1.1, 1.5, 'hello'),
        // "there" belongs to the first line but was timed inside the second.
        word(3.05, 3.3, 'there'),
        word(3.4, 3.9, 'doctor'),
      ],
    )
    expect(lines).toHaveLength(2)
    expect(lines[0].end).toBeLessThan(lines[1].start)
  })

  it('keeps wordless intervals and flags them', () => {
    const lines = build([[1, 2]], [])
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('')
    expect(lines[0].flags).toContain(FLAG_NO_SPEECH)
  })

  it('gives words outside every interval their own line', () => {
    // Whisper heard something silero scored below threshold.
    const lines = build([[1, 2]], [word(1.2, 1.5, 'a'), word(8, 8.4, 'b')])
    expect(lines.map((l) => l.text)).toEqual(['a', 'b'])
    expect(lines[1].start).toBeCloseTo(8)
    expect(lines[1].end).toBeCloseTo(8.4)
  })

  it('groups adjacent orphan words into one line', () => {
    const lines = build([], [word(8, 8.2, 'one'), word(8.3, 8.5, 'two'), word(9.9, 10.1, 'far')], {
      splitGapMs: 400,
    })
    expect(lines.map((l) => l.text)).toEqual(['one two', 'far'])
  })

  it('assigns a word to the interval it overlaps most', () => {
    const lines = build(
      [
        [1, 2],
        [2, 3],
      ],
      [word(1.9, 2.6, 'spanning')],
    )
    expect(lines.filter((l) => l.text === 'spanning')).toHaveLength(1)
  })
})

describe('splitting', () => {
  it('splits a long interval at a pause', () => {
    const words = [word(0, 1), word(1, 2), word(9, 10), word(10, 11)]
    const lines = build([[0, 11]], words, { maxLineS: 6, splitGapMs: 400 })
    expect(lines).toHaveLength(2)
    expect(lines[0].end).toBeCloseTo(5.5) // midpoint of the 2..9 gap
    expect(lines[1].start).toBeCloseTo(5.5)
  })

  it('prefers the most balanced pause', () => {
    const words = [word(0, 0.5), word(1, 5), word(5.6, 10)]
    const lines = build([[0, 10]], words, { maxLineS: 7, splitGapMs: 400 })
    expect(lines).toHaveLength(2)
    expect(lines[0].end).toBeCloseTo(5.3)
  })

  it('recurses until every part fits', () => {
    const words = Array.from({ length: 8 }, (_, i) => word(i * 3, i * 3 + 1))
    const lines = build([[0, 23]], words, { maxLineS: 6, splitGapMs: 400 })
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.every((l) => l.end - l.start <= 6)).toBe(true)
  })

  it('keeps continuous speech whole and flags it', () => {
    const words = Array.from({ length: 40 }, (_, i) => word(i * 0.5, i * 0.5 + 0.5))
    const lines = build([[0, 20]], words, { maxLineS: 6, splitGapMs: 400 })
    expect(lines).toHaveLength(1)
    expect(lines[0].flags).toContain(FLAG_TOO_LONG)
  })

  it('does not split on a short gap', () => {
    const lines = build([[0, 8]], [word(0, 3), word(3.1, 8)], { maxLineS: 5, splitGapMs: 400 })
    expect(lines).toHaveLength(1)
  })
})

describe('bounds and flags', () => {
  it('clamps lines to the file', () => {
    const lines = build(
      [
        [-1, 2],
        [9, 20],
      ],
      [],
      { durationS: 10 },
    )
    expect(lines[0].start).toBe(0)
    expect(lines[lines.length - 1].end).toBe(10)
  })

  it('merges overlapping intervals', () => {
    const lines = build(
      [
        [1, 3],
        [2, 4],
      ],
      [],
    )
    expect(lines).toHaveLength(1)
    expect([lines[0].start, lines[0].end]).toEqual([1, 4])
  })

  it('flags very short lines instead of dropping them', () => {
    const lines = build([[1, 1.05]], [])
    expect(lines).toHaveLength(1)
    expect(lines[0].flags).toContain(FLAG_VERY_SHORT)
  })

  it('handles empty input', () => {
    expect(build([], [])).toEqual([])
  })

  it('returns ordered, non-overlapping lines', () => {
    const lines = build(
      [
        [5, 6],
        [1, 2],
        [3, 4],
      ],
      [],
    )
    const starts = lines.map((l) => l.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    for (let i = 0; i < lines.length - 1; i += 1) {
      expect(lines[i].end).toBeLessThanOrEqual(lines[i + 1].start)
    }
  })
})

function envelopeFrom(values: number[], frameS = 0.005): Envelope {
  const rms = Float32Array.from(values)
  return {
    sampleRate: Math.round(1 / frameS),
    hop: 1,
    min: rms.map((v) => -v),
    max: rms,
    rms,
  }
}

describe('snapping', () => {
  it('moves an edge to the quietest nearby frame', () => {
    // Frame 3 is the dip; at 5 ms frames that is t=0.015.
    const env = envelopeFrom([1, 0.8, 0.5, 0.1, 0.6, 0.9, 1])
    expect(snapEdge(env, 0.025, { lowerS: 0, upperS: 0.03, windowS: 0.02 })).toBeCloseTo(0.015)
  })

  it('bounds the search by the window', () => {
    const env = envelopeFrom([0.01, 1, 1, 1, 0.9, 1, 1])
    // The global minimum at frame 0 is outside a 10 ms window from t=0.025.
    expect(snapEdge(env, 0.025, { lowerS: 0, upperS: 0.035, windowS: 0.01 })).toBeCloseTo(0.02)
  })

  it('never crosses a neighbour', () => {
    const env = envelopeFrom(new Array(20).fill(0))
    const snapped = snapEdge(env, 0.05, { lowerS: 0.04, upperS: 0.06, windowS: 0.5 })
    expect(snapped).toBeGreaterThanOrEqual(0.04)
    expect(snapped).toBeLessThanOrEqual(0.06)
  })

  it('is a no-op on an empty envelope', () => {
    const env = envelopeFrom([])
    expect(snapEdge(env, 1, { lowerS: 0, upperS: 2, windowS: 0.1 })).toBe(1)
  })

  it('keeps lines from overlapping', () => {
    const env = envelopeFrom(new Array(400).fill(0)) // entirely flat: every frame ties
    const lines = build(
      [
        [0.5, 0.7],
        [0.75, 0.95],
      ],
      [],
      { durationS: 2 },
    )
    const snapped = snapLines(lines, env, 200, 2)
    expect(snapped[0].end).toBeLessThanOrEqual(snapped[1].start)
    expect(snapped.every((l) => l.end > l.start)).toBe(true)
  })
})
