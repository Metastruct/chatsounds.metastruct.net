/// <reference lib="webworker" />
/**
 * Everything expensive, off the main thread.
 *
 * The split is dictated by what each side can actually do. Web Audio is not
 * exposed in workers, so decoding and resampling have to happen on the main
 * thread; onnxruntime and transformers.js both run happily here and would
 * otherwise freeze the UI for the length of the transcription.
 *
 * The 16 kHz working audio is transferred in and *kept* here -- the main thread
 * has no further use for it, and a copy of a long recording is not cheap. The
 * 44.1 kHz master stays on the main thread for playback, and clip PCM is sent
 * over per encode, which is only ever a few seconds of audio at a time.
 */

import { computeEnvelope } from '../pipeline/envelope'
import { transcribe } from '../pipeline/asr'
import { type Attempt, type Precision, nextAttempt } from '../pipeline/attempts'
import { type BackendChoice, resolveBackend } from '../pipeline/gpu'
import { configureOrt } from '../pipeline/ort'
import { buildLines, snapLines } from '../pipeline/segmenter'
import { encodeOgg } from '../pipeline/encode'
import { detectSpeech, loadVad } from '../pipeline/vad'
import { sanitizeTrigger, fallbackTrigger } from '../pipeline/naming'

export interface AnalyzeOptions {
  modelId?: string
  language?: string
  /** `auto` unless the user pinned one; see `pipeline/gpu`. */
  backend?: BackendChoice
  /** `fast` unless a previous attempt in another worker failed to load. */
  precision?: Precision
  vadThreshold?: number
  vadMinSilenceMs?: number
  vadMinSpeechMs?: number
  vadSpeechPadMs?: number
  maxLineS?: number
  splitGapMs?: number
  snapWindowMs?: number
  maxTriggerLength?: number
}

export type WorkerRequest =
  | { id: number; type: 'analyze'; work: Float32Array; durationS: number; options: AnalyzeOptions }
  | {
      id: number
      type: 'encode'
      clips: { segmentId: string; pcm: Float32Array }[]
      quality: number
      sampleRate: number
    }
  | { id: number; type: 'retranscribe'; startS: number; endS: number; options: AnalyzeOptions }

export interface AnalyzedLine {
  startS: number
  endS: number
  transcript: string
  trigger: string
  flags: string[]
}

export interface SerializedEnvelope {
  sampleRate: number
  hop: number
  min: Float32Array
  max: Float32Array
  rms: Float32Array
}

export type WorkerResponse =
  | {
      type: 'progress'
      stage: string
      fraction: number
      message: string
      /** Byte counts, present only while the speech model is downloading. */
      loaded?: number
      total?: number
    }
  | {
      id: number
      type: 'analyzed'
      envelope: SerializedEnvelope
      lines: AnalyzedLine[]
      backend: string
    }
  | { id: number; type: 'encoded'; clips: { segmentId: string; bytes: Uint8Array }[] }
  | { id: number; type: 'retranscribed'; text: string }
  | {
      id: number
      type: 'error'
      message: string
      /**
       * Present when the same audio is worth another attempt with different
       * settings -- and only ever in a *fresh* worker. transformers.js leaves its
       * session and inference chains permanently rejected after one failure, so
       * this worker can no longer run anything at all.
       */
      retry?: Attempt
    }

let work: Float32Array | null = null

/**
 * Which part of `analyze` is running, so a failure can say whether trying again
 * differently would be anything other than a waste of the user's time. Only the
 * speech model has settings to vary; the detector runs on the CPU regardless.
 */
let phase: 'detecting' | 'transcribing' = 'detecting'
let attempted: Attempt | null = null

const post = (message: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

const progress = (
  stage: string,
  fraction: number,
  message: string,
  bytes?: { loaded?: number; total?: number },
) => post({ type: 'progress', stage, fraction, message, ...bytes })

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    switch (request.type) {
      case 'analyze':
        await analyze(request)
        break
      case 'encode':
        await encode(request)
        break
      case 'retranscribe':
        await retranscribe(request)
        break
    }
  } catch (error) {
    post({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(request.type === 'analyze' ? { retry: retryFor() } : {}),
    })
  }
}

/**
 * What the store should try next, if anything.
 *
 * Only the speech model has settings worth varying: the detector runs on the CPU
 * regardless, so a failure before transcription started would fail again
 * identically and the user would just wait twice for it.
 */
function retryFor(): Attempt | undefined {
  if (phase !== 'transcribing' || !attempted) return undefined
  return nextAttempt(attempted) ?? undefined
}

async function analyze(request: Extract<WorkerRequest, { type: 'analyze' }>) {
  const { options, durationS } = request
  work = request.work
  phase = 'detecting'
  attempted = null

  progress('analyzing', 0.02, 'measuring the waveform')
  const envelope = computeEnvelope(work, 16000)

  // Settled here, before anything creates a session: it decides which of
  // onnxruntime's two wasm binaries is fetched, and that cannot be changed
  // afterwards. The VAD runs on the CPU either way.
  const backend = await resolveBackend(options.backend)
  const precision = options.precision ?? 'fast'
  await configureOrt(backend)

  // Starting the detector means fetching onnxruntime's own WebAssembly, which is
  // 13-24 MB depending on the backend. Silence here read as a hang.
  progress('detecting', 0.05, 'starting the voice detector')
  await loadVad()

  progress('detecting', 0.08, 'finding voice lines')
  const speech = await detectSpeech(work, {
    threshold: options.vadThreshold,
    minSpeechMs: options.vadMinSpeechMs,
    minSilenceMs: options.vadMinSilenceMs,
    speechPadMs: options.vadSpeechPadMs,
    onProgress: (fraction) =>
      progress('detecting', 0.08 + 0.17 * fraction, 'finding voice lines'),
  })
  progress('detecting', 0.26, `found ${speech.length} candidate lines`)

  // Downloading is its own reported stage: on a cold cache it is the longest
  // part of the whole run by far, and folding it into "transcribing" made a
  // 300 MB fetch look like a hang.
  progress('downloading', 0.28, 'looking for the speech model')
  phase = 'transcribing'
  attempted = { backend, precision }
  const transcription = await transcribe(work, {
    modelId: options.modelId,
    language: options.language,
    backend,
    precision,
    onProgress: ({ stage, fraction, detail, loaded, total }) =>
      stage === 'download'
        ? progress(
            'downloading',
            0.28 + 0.22 * fraction,
            detail ? `fetching ${detail}` : 'fetching the speech model',
            { loaded, total },
          )
        : // `detail` carries the one thing worth interrupting the bar for: that
          // the GPU gave out and this is starting again on the CPU.
          progress('transcribing', 0.5 + 0.4 * fraction, detail ?? 'transcribing'),
  })

  progress('segmenting', 0.92, 'cutting voice lines')
  let lines = buildLines(speech, transcription.words, {
    durationS,
    maxLineS: options.maxLineS,
    splitGapMs: options.splitGapMs,
  })
  lines = snapLines(lines, envelope, options.snapWindowMs ?? 150, durationS)

  const analyzed: AnalyzedLine[] = lines.map((line, position) => ({
    startS: round4(line.start),
    endS: round4(line.end),
    transcript: line.text,
    trigger:
      sanitizeTrigger(line.text, options.maxTriggerLength ?? 100) || fallbackTrigger(position),
    flags: line.flags,
  }))

  post(
    {
      id: request.id,
      type: 'analyzed',
      envelope: {
        sampleRate: envelope.sampleRate,
        hop: envelope.hop,
        min: envelope.min,
        max: envelope.max,
        rms: envelope.rms,
      },
      lines: analyzed,
      backend: transcription.backend,
    },
    [envelope.min.buffer, envelope.max.buffer, envelope.rms.buffer],
  )
}

async function encode(request: Extract<WorkerRequest, { type: 'encode' }>) {
  const out: { segmentId: string; bytes: Uint8Array }[] = []
  const total = request.clips.length || 1

  for (const [index, clip] of request.clips.entries()) {
    const bytes = await encodeOgg(clip.pcm, {
      quality: request.quality,
      sampleRate: request.sampleRate,
    })
    out.push({ segmentId: clip.segmentId, bytes })
    if (index % 10 === 0 || index === total - 1) {
      progress('encoding', (index + 1) / total, `encoding ${index + 1}/${total}`)
    }
  }

  post({ id: request.id, type: 'encoded', clips: out }, out.map((clip) => clip.bytes.buffer))
}

async function retranscribe(request: Extract<WorkerRequest, { type: 'retranscribe' }>) {
  if (!work) throw new Error('the audio is no longer loaded, open the file again')
  const from = Math.max(0, Math.floor(request.startS * 16000))
  const to = Math.min(work.length, Math.ceil(request.endS * 16000))
  if (to <= from) {
    post({ id: request.id, type: 'retranscribed', text: '' })
    return
  }
  const { words } = await transcribe(work.slice(from, to), {
    modelId: request.options.modelId,
    language: request.options.language,
    backend: request.options.backend,
    precision: request.options.precision,
  })
  post({
    id: request.id,
    type: 'retranscribed',
    text: words
      .map((word) => word.text)
      .join(' ')
      .trim(),
  })
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}
