/**
 * Voice activity detection with silero-vad, running on onnxruntime-web.
 *
 * The frame loop and the hysteresis below are a port of silero's own
 * `get_speech_timestamps`, so the parameters mean the same thing they do in the
 * Python version: a high threshold to enter speech, a lower one to leave it, a
 * minimum silence before a segment is allowed to close, and a little padding on
 * each side so consonants at the edges survive.
 */

// The `/webgpu` entry point rather than the default one, so this shares a single
// runtime -- and a single wasm binary -- with transformers.js. See ./ort.
import * as ort from 'onnxruntime-web/webgpu'
import { configureOrt } from './ort'

const SAMPLE_RATE = 16000
/** silero v5 consumes exactly 512 samples (32 ms) per step at 16 kHz. */
const WINDOW = 512
const CONTEXT = 64
const STATE_SHAPE = [2, 1, 128]

export interface VadOptions {
  threshold?: number
  minSpeechMs?: number
  minSilenceMs?: number
  speechPadMs?: number
  maxSpeechS?: number
  onProgress?: (fraction: number) => void
}

let sessionPromise: Promise<ort.InferenceSession> | null = null

export function loadVad(modelUrl = '/models/silero_vad.onnx') {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await configureOrt()
      try {
        // silero is 2 MB and runs a 32 ms window at a time; the GPU round trip
        // would cost more than the arithmetic saves.
        return await ort.InferenceSession.create(modelUrl, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        })
      } catch (error) {
        // onnxruntime reports every startup failure as "no available backend
        // found", which reads as a missing browser feature when it is nearly
        // always a file it could not fetch. Say so, and keep its own words.
        throw new Error(
          `The part that finds voices could not start. Some of its files did not ` +
            `load, which a reload usually sorts out. (${String(error).slice(0, 200)})`,
        )
      }
    })()
    // A failed load must not be cached, or every retry returns the same error.
    sessionPromise.catch(() => {
      sessionPromise = null
    })
  }
  return sessionPromise
}

/** Probability of speech for every 32 ms step of `samples`. */
async function speechProbabilities(
  samples: Float32Array,
  onProgress?: (fraction: number) => void,
): Promise<Float32Array> {
  const session = await loadVad()
  const steps = Math.floor(samples.length / WINDOW)
  const out = new Float32Array(steps)

  let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), STATE_SHAPE)
  // The model wants the tail of the previous window prepended, so it has
  // continuity across steps rather than seeing each one cold.
  let context = new Float32Array(CONTEXT)
  const input = new Float32Array(CONTEXT + WINDOW)
  const rate = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1])

  for (let step = 0; step < steps; step += 1) {
    input.set(context, 0)
    input.set(samples.subarray(step * WINDOW, step * WINDOW + WINDOW), CONTEXT)

    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('float32', input.slice(), [1, input.length]),
      state,
      sr: rate,
    }
    const result = await session.run(feeds)

    out[step] = (result.output.data as Float32Array)[0]
    state = result.stateN as ort.Tensor
    context = input.slice(input.length - CONTEXT)

    if (onProgress && step % 200 === 0) onProgress(step / steps)
  }

  onProgress?.(1)
  return out
}

/**
 * Turn per-step probabilities into `[start, end]` pairs in seconds.
 *
 * Straight port of silero's state machine: enter on `threshold`, leave on
 * `threshold - 0.15`, require `minSilenceMs` of quiet before closing, drop
 * anything shorter than `minSpeechMs`, and force a break at `maxSpeechS`.
 */
export function timestampsFrom(
  probabilities: Float32Array,
  totalSamples: number,
  {
    threshold = 0.5,
    minSpeechMs = 250,
    minSilenceMs = 300,
    speechPadMs = 120,
    maxSpeechS = 15,
  }: VadOptions = {},
): [number, number][] {
  const negativeThreshold = Math.max(threshold - 0.15, 0.01)
  const minSpeech = (minSpeechMs / 1000) * SAMPLE_RATE
  const minSilence = (minSilenceMs / 1000) * SAMPLE_RATE
  const pad = (speechPadMs / 1000) * SAMPLE_RATE
  const maxSpeech =
    maxSpeechS > 0 ? maxSpeechS * SAMPLE_RATE - WINDOW - 2 * pad : Infinity

  const segments: { start: number; end: number }[] = []
  let triggered = false
  let current = { start: 0, end: 0 }
  let tempEnd = 0
  let previousEnd = 0
  let nextStart = 0

  for (let step = 0; step < probabilities.length; step += 1) {
    const probability = probabilities[step]
    const at = WINDOW * step

    if (probability >= threshold && tempEnd) {
      tempEnd = 0
      if (nextStart < previousEnd) nextStart = at
    }

    if (probability >= threshold && !triggered) {
      triggered = true
      current = { start: at, end: 0 }
      continue
    }

    if (triggered && at - current.start > maxSpeech) {
      // Too long with no pause: close at the last dip if there was one,
      // otherwise cut here and carry straight on.
      if (previousEnd) {
        current.end = previousEnd
        segments.push(current)
        current = { start: nextStart > previousEnd ? nextStart : at, end: 0 }
        previousEnd = 0
        nextStart = 0
        tempEnd = 0
      } else {
        current.end = at
        segments.push(current)
        current = { start: at, end: 0 }
        previousEnd = 0
        nextStart = 0
        tempEnd = 0
        triggered = false
      }
      continue
    }

    if (probability < negativeThreshold && triggered) {
      if (!tempEnd) tempEnd = at
      if (at - tempEnd > maxSpeech / 2) previousEnd = tempEnd
      if (at - tempEnd < minSilence) continue
      current.end = tempEnd
      if (current.end - current.start > minSpeech) segments.push(current)
      current = { start: 0, end: 0 }
      previousEnd = 0
      nextStart = 0
      tempEnd = 0
      triggered = false
    }
  }

  if (triggered && totalSamples - current.start > minSpeech) {
    current.end = totalSamples
    segments.push(current)
  }

  // Pad each side, sharing the available gap with the neighbour rather than
  // letting two padded segments overlap.
  return segments.map((segment, index) => {
    let start = segment.start
    let end = segment.end
    if (index === 0) {
      start = Math.max(0, start - pad)
    } else {
      const gap = segment.start - segments[index - 1].end
      start = Math.max(0, start - Math.min(pad, gap / 2))
    }
    if (index === segments.length - 1) {
      end = Math.min(totalSamples, end + pad)
    } else {
      const gap = segments[index + 1].start - segment.end
      end = Math.min(totalSamples, end + Math.min(pad, gap / 2))
    }
    return [start / SAMPLE_RATE, end / SAMPLE_RATE] as [number, number]
  })
}

export async function detectSpeech(
  work: Float32Array,
  options: VadOptions = {},
): Promise<[number, number][]> {
  const probabilities = await speechProbabilities(work, options.onProgress)
  return timestampsFrom(probabilities, work.length, options)
}
