import { describe, expect, it } from 'vitest'
import {
  BASE_HZ,
  computeEnvelope,
  envelopeDuration,
  peakDb,
  peaksFor,
  windowPeaks,
} from './envelope'

const SAMPLE_RATE = 16000

/** Silence except for a 440 Hz tone inside each span. */
function tone(spans: [number, number][], durationS: number): Float32Array {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * durationS))
  for (let i = 0; i < samples.length; i += 1) {
    const t = i / SAMPLE_RATE
    const loud = spans.some(([start, end]) => t >= start && t < end)
    samples[i] = loud ? 0.5 * Math.sin(2 * Math.PI * 440 * t) : 0
  }
  return samples
}

function frameAt(env: ReturnType<typeof computeEnvelope>, seconds: number) {
  return Math.round(seconds / (env.hop / env.sampleRate))
}

describe('computeEnvelope', () => {
  it('produces frames at the base rate', () => {
    const env = computeEnvelope(tone([[1, 2]], 3), SAMPLE_RATE)
    expect(env.sampleRate).toBe(SAMPLE_RATE)
    expect(env.hop).toBe(SAMPLE_RATE / BASE_HZ)
    expect(envelopeDuration(env)).toBeCloseTo(3, 2)
    expect(env.rms.length).toBeCloseTo(3 * BASE_HZ, -1)
  })

  it('tracks where the speech is', () => {
    const env = computeEnvelope(tone([[1, 2]], 3), SAMPLE_RATE)
    expect(env.rms[frameAt(env, 0.5)]).toBeLessThan(0.01)
    expect(env.rms[frameAt(env, 1.5)]).toBeGreaterThan(0.1)
  })

  it('handles an empty signal', () => {
    const env = computeEnvelope(new Float32Array(0), SAMPLE_RATE)
    expect(env.rms.length).toBe(0)
    expect(envelopeDuration(env)).toBe(0)
  })
})

describe('peaksFor', () => {
  it('keeps full resolution for a short file', () => {
    const peaks = peaksFor(computeEnvelope(tone([[1, 2]], 3), SAMPLE_RATE))
    expect(peaks.pps).toBe(BASE_HZ)
    expect(peaks.min.length).toBe(peaks.max.length)
    expect(peaks.min.length).toBeGreaterThan(0)
  })

  it('downsamples a long file rather than growing the payload', () => {
    // A 20-minute recording at full resolution would be 240k columns.
    const env = computeEnvelope(tone([[1, 2]], 20), SAMPLE_RATE)
    const long = {
      ...env,
      // Pretend the same envelope is 60x longer.
      min: repeat(env.min, 60),
      max: repeat(env.max, 60),
      rms: repeat(env.rms, 60),
    }
    const peaks = peaksFor(long)
    expect(peaks.max.length).toBeLessThanOrEqual(32_000)
    expect(peaks.pps).toBeLessThan(BASE_HZ)
  })

  it('reports a signed range', () => {
    const peaks = peaksFor(computeEnvelope(tone([[0, 1]], 1), SAMPLE_RATE))
    expect(Math.min(...peaks.min)).toBeLessThan(0)
    expect(Math.max(...peaks.max)).toBeGreaterThan(0)
  })
})

function repeat(source: Float32Array, times: number): Float32Array {
  const out = new Float32Array(source.length * times)
  for (let i = 0; i < times; i += 1) out.set(source, i * source.length)
  return out
}

describe('windowPeaks', () => {
  it('returns the requested number of columns', () => {
    const env = computeEnvelope(tone([[1, 2]], 3), SAMPLE_RATE)
    const { min, max } = windowPeaks(env, 0.5, 2.5, 64)
    expect(min.length).toBe(64)
    expect(max.length).toBe(64)
  })

  it('resolves the speech boundary', () => {
    const env = computeEnvelope(tone([[1, 2]], 3), SAMPLE_RATE)
    const { max } = windowPeaks(env, 0, 3, 30)
    // Columns are 100 ms wide; the tone occupies 1..2s, i.e. columns 10..19.
    expect(Math.max(...max.slice(0, 8))).toBeLessThan(0.01)
    expect(Math.max(...max.slice(11, 18))).toBeGreaterThan(0.1)
    expect(Math.max(...max.slice(22, 30))).toBeLessThan(0.01)
  })

  it('reads past the end of the file as silence', () => {
    const env = computeEnvelope(tone([[1, 2]], 3), SAMPLE_RATE)
    const { min, max } = windowPeaks(env, 2.5, 5, 50)
    // Beyond 3 s there is no audio; it must read flat rather than smearing the
    // last frame across the rest of the window.
    expect(max[max.length - 1]).toBe(0)
    expect(min[min.length - 1]).toBe(0)
  })

  it('survives an empty envelope', () => {
    const env = computeEnvelope(new Float32Array(0), SAMPLE_RATE)
    const { max } = windowPeaks(env, 0, 1, 32)
    expect([...max]).toEqual(new Array(32).fill(0))
  })
})

describe('peakDb', () => {
  it('measures a loud region', () => {
    const samples = tone([[0, 1]], 1)
    // 0.5 amplitude is about -6 dBFS.
    expect(peakDb(samples, 0, 1, SAMPLE_RATE)).toBeCloseTo(-6, 0)
  })

  it('reports silence as negative infinity', () => {
    const samples = new Float32Array(SAMPLE_RATE)
    expect(peakDb(samples, 0, 1, SAMPLE_RATE)).toBe(-Infinity)
  })

  it('only measures the requested region', () => {
    const samples = tone([[0, 0.5]], 1)
    expect(peakDb(samples, 0.6, 1, SAMPLE_RATE)).toBe(-Infinity)
    expect(peakDb(samples, 0, 0.4, SAMPLE_RATE)).toBeGreaterThan(-10)
  })
})
