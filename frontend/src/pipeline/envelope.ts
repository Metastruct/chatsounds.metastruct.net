/**
 * One reduction of the decoded audio that feeds both the UI and the segmenter.
 *
 * The file is reduced to a fixed 200 Hz envelope (min / max / rms per 5 ms
 * frame). The overview waveform is derived from that, and the segmenter snaps
 * its boundaries against the same rms curve -- which keeps what you see and what
 * the cut does in agreement.
 */

/** Resolution of the base envelope. Everything else is derived from it. */
export const BASE_HZ = 200

/**
 * The overview is a fixed-width canvas, so past a point more columns only cost
 * draw time. Long files get a coarser envelope instead.
 */
const TARGET_BUCKETS = 32_000
const MAX_PPS = 200
const MIN_PPS = 5
const MIN_GROUP = Math.round(BASE_HZ / MAX_PPS)
const MAX_GROUP = Math.round(BASE_HZ / MIN_PPS)

export interface Envelope {
  sampleRate: number
  /** Samples per frame. */
  hop: number
  min: Float32Array
  max: Float32Array
  rms: Float32Array
}

export function computeEnvelope(samples: Float32Array, sampleRate: number): Envelope {
  const hop = Math.max(1, Math.round(sampleRate / BASE_HZ))
  const frames = Math.floor(samples.length / hop)

  const min = new Float32Array(frames)
  const max = new Float32Array(frames)
  const rms = new Float32Array(frames)

  for (let frame = 0; frame < frames; frame += 1) {
    const from = frame * hop
    let lo = Infinity
    let hi = -Infinity
    let sum = 0
    for (let i = from; i < from + hop; i += 1) {
      const value = samples[i]
      if (value < lo) lo = value
      if (value > hi) hi = value
      sum += value * value
    }
    min[frame] = lo
    max[frame] = hi
    rms[frame] = Math.sqrt(sum / hop)
  }

  return { sampleRate, hop, min, max, rms }
}

export function envelopeDuration(envelope: Envelope): number {
  return (envelope.rms.length * envelope.hop) / envelope.sampleRate
}

export interface Peaks {
  duration: number
  pps: number
  min: Float32Array
  max: Float32Array
}

/** Downsample the envelope to something the overview can draw directly. */
export function peaksFor(envelope: Envelope): Peaks {
  const duration = envelopeDuration(envelope)
  // Derive the grouping straight from the bucket target. Going via a rounded
  // pps and then rounding again lets the column count overshoot the cap --
  // 1200 s once landed on 34285 columns against a 32000 target.
  const group = Math.min(
    MAX_GROUP,
    Math.max(MIN_GROUP, Math.ceil(envelope.rms.length / TARGET_BUCKETS)),
  )
  const count = Math.floor(envelope.rms.length / group)

  const min = new Float32Array(count)
  const max = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    const from = index * group
    let lo = Infinity
    let hi = -Infinity
    for (let i = from; i < from + group; i += 1) {
      if (envelope.min[i] < lo) lo = envelope.min[i]
      if (envelope.max[i] > hi) hi = envelope.max[i]
    }
    min[index] = lo === Infinity ? 0 : lo
    max[index] = hi === -Infinity ? 0 : hi
  }

  return { duration, pps: BASE_HZ / group, min, max }
}

/**
 * Min/max pairs across `[startS, endS)`, resampled to `buckets` columns.
 *
 * The window is clipped to the file, and columns that fall outside it come back
 * as zeroes so the client can draw the edge of the recording honestly rather
 * than stretching the last sample across it.
 */
export function windowPeaks(
  envelope: Envelope,
  startS: number,
  endS: number,
  buckets: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets)
  const max = new Float32Array(buckets)
  const total = envelope.rms.length
  if (total === 0) return { min, max }

  const frameS = envelope.hop / envelope.sampleRate
  const span = endS - startS

  for (let index = 0; index < buckets; index += 1) {
    const from = Math.floor(((startS + (span * index) / buckets) / frameS) | 0)
    const toRaw = Math.ceil((startS + (span * (index + 1)) / buckets) / frameS)
    const a = Math.min(Math.max(from, 0), total)
    if (a >= total) continue
    const b = Math.min(Math.max(toRaw, a + 1), total)

    let lo = Infinity
    let hi = -Infinity
    for (let i = a; i < b; i += 1) {
      if (envelope.min[i] < lo) lo = envelope.min[i]
      if (envelope.max[i] > hi) hi = envelope.max[i]
    }
    min[index] = lo === Infinity ? 0 : lo
    max[index] = hi === -Infinity ? 0 : hi
  }

  return { min, max }
}

/** Peak level of one region in dBFS. Used by the "normalise" bulk action. */
export function peakDb(samples: Float32Array, startS: number, endS: number, sampleRate: number): number {
  const from = Math.max(0, Math.floor(startS * sampleRate))
  const to = Math.min(samples.length, Math.ceil(endS * sampleRate))
  let peak = 0
  for (let i = from; i < to; i += 1) {
    const value = Math.abs(samples[i])
    if (value > peak) peak = value
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity
}
