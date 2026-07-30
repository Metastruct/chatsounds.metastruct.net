/**
 * Transcription with Whisper via transformers.js, at word granularity.
 *
 * Word timestamps are not a nicety here -- the segmenter needs them to decide
 * where a long utterance should be broken, so `return_timestamps: 'word'` is
 * required rather than optional.
 *
 * Whisper's own chunking is left to the library; silero has already given us the
 * boundaries we cut on, and Whisper only has to supply the words and their
 * timings.
 */

import {
  type AutomaticSpeechRecognitionPipeline,
  env,
  pipeline,
} from '@huggingface/transformers'
import { WORK_SAMPLE_RATE } from './decode'
import type { Precision } from './attempts'
import { type Backend, type BackendChoice, gpuStatus, resolveBackend } from './gpu'
import { configureOrt } from './ort'
import type { Word } from './segmenter'

// Models come from the Hugging Face CDN and are cached by the browser after the
// first visit. Point this at your own host to keep everything on your domain.
env.allowLocalModels = false

/**
 * The `_timestamped` exports specifically.
 *
 * Word-level timestamps are derived from Whisper's cross-attentions, and a model
 * has to be exported with `output_attentions=True` for those to be in the graph
 * at all. The plain `whisper-*` ONNX repos are not, and asking them for word
 * timings fails outright -- which would take the segmenter's whole basis for
 * deciding where to split a long line with it.
 */
export const MODELS = [
  {
    id: 'onnx-community/whisper-tiny.en_timestamped',
    label: 'tiny.en',
    size: '~40 MB',
    english: true,
    /** Whether this size is only really practical on a GPU. */
    wantsGpu: false,
  },
  {
    id: 'onnx-community/whisper-base_timestamped',
    label: 'base',
    size: '~80 MB',
    english: false,
    wantsGpu: false,
  },
  {
    id: 'onnx-community/whisper-small_timestamped',
    label: 'small',
    size: '~250 MB',
    english: false,
    wantsGpu: true,
  },
  {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    label: 'large-v3-turbo',
    size: '~800 MB',
    english: false,
    wantsGpu: true,
  },
] as const

export const DEFAULT_MODEL = 'onnx-community/whisper-base_timestamped'

export interface AsrProgress {
  stage: 'download' | 'transcribe'
  fraction: number
  detail?: string
  /** Bytes fetched so far across every file, when downloading. */
  loaded?: number
  /** Bytes expected across every file discovered so far. */
  total?: number
}

/**
 * Turn transformers.js's per-file progress into one running byte total.
 *
 * A model is a dozen files, and the library reports each one's percentage
 * independently, so a bar driven straight off `event.progress` resets to zero a
 * dozen times and reads as a hang. Summing bytes across files gives a number
 * that only moves forward.
 *
 * The denominator does grow as files are discovered, so bytes are the honest
 * thing to show and the percentage is the rough guide.
 */
function trackDownload(onProgress?: (progress: AsrProgress) => void) {
  const files = new Map<string, { loaded: number; total: number }>()

  return (event: {
    status?: string
    file?: string
    progress?: number
    loaded?: number
    total?: number
  }) => {
    if (!onProgress || !event.file) return
    if (event.status !== 'progress' && event.status !== 'done') return

    const known = files.get(event.file)
    const total = event.total ?? known?.total ?? 0
    // A 'done' event carries no byte counts, so settle the file at its size.
    const loaded = event.status === 'done' ? total : (event.loaded ?? known?.loaded ?? 0)
    files.set(event.file, { loaded, total })

    let loadedSum = 0
    let totalSum = 0
    for (const file of files.values()) {
      if (file.total <= 0) continue // metadata files report no size
      loadedSum += file.loaded
      totalSum += file.total
    }

    onProgress({
      stage: 'download',
      fraction: totalSum > 0 ? Math.min(1, loadedSum / totalSum) : 0,
      detail: event.file,
      loaded: loadedSum,
      total: totalSum,
    })
  }
}

export {
  type Backend,
  type BackendChoice,
  type GpuStatus,
  gpuStatus,
  hasWebGpu,
  resolveBackend,
} from './gpu'

const cache = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>()

/**
 * Which weights to fetch.
 *
 * The encoder and decoder are quantised separately because they tolerate it
 * differently: the decoder is the bulk of the weights and survives 4-bit well,
 * while the encoder is what the word timings come out of and is left heavier.
 *
 * Half precision is a GPU-only option, and only on an adapter that advertises
 * `shader-f16` -- without the feature the weights are rejected rather than
 * widened, which is why the flag is read off the adapter rather than assumed.
 *
 * `full` exists because onnxruntime's WASM backend rejects some q8 decoder
 * graphs outright -- "Missing required scale ... MatMulNBits" -- and which builds
 * are affected varies. It is not tried in the same worker as a failed `fast`
 * attempt, though; see `Precision` at the call site in the worker.
 */
function dtypesFor(backend: Backend, f16: boolean, precision: Precision) {
  if (precision === 'full') return { encoder_model: 'fp32', decoder_model_merged: 'fp32' } as const
  return backend === 'webgpu'
    ? ({ encoder_model: f16 ? 'fp16' : 'fp32', decoder_model_merged: 'q4' } as const)
    : ({ encoder_model: 'q8', decoder_model_merged: 'q4' } as const)
}

async function getPipeline(
  modelId: string,
  backend: Backend,
  precision: Precision,
  onProgress?: (progress: AsrProgress) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  // Which wasm binary onnxruntime loads depends on the answer, so this has to
  // be settled before the first session is created.
  await configureOrt(backend)
  const gpu = await gpuStatus()
  const key = `${modelId}:${backend}:${precision}`

  const existing = cache.get(key)
  if (existing) return existing

  const attempt = pipeline('automatic-speech-recognition', modelId, {
    device: backend,
    dtype: { ...dtypesFor(backend, gpu.available && gpu.f16, precision) },
    progress_callback: trackDownload(onProgress),
  }) as Promise<AutomaticSpeechRecognitionPipeline>

  cache.set(key, attempt)
  // A failed load must not be cached, or every retry returns the same rejection.
  attempt.catch(() => cache.delete(key))
  return attempt
}

export interface TranscribeOptions {
  modelId?: string
  language?: string
  /** Defaults to `auto`; see `resolveBackend`. */
  backend?: BackendChoice
  /** Defaults to `fast`. */
  precision?: Precision
  onProgress?: (progress: AsrProgress) => void
}

export interface Transcription {
  words: Word[]
  language: string
  backend: 'webgpu' | 'wasm'
}

export async function transcribe(
  work: Float32Array,
  {
    modelId = DEFAULT_MODEL,
    language,
    backend,
    precision = 'fast',
    onProgress,
  }: TranscribeOptions = {},
): Promise<Transcription> {
  const resolved = await resolveBackend(backend)
  const transcriber = await getPipeline(modelId, resolved, precision, onProgress)

  onProgress?.({ stage: 'transcribe', fraction: 0 })

  // English-only checkpoints reject `task` and `language` outright. Read the
  // flag off the model table rather than sniffing the id -- the `_timestamped`
  // suffix means these no longer simply end in ".en".
  const isEnglishOnly =
    MODELS.find((model) => model.id === modelId)?.english ?? /\.en(\b|_)/.test(modelId)
  const output = (await transcriber(work, {
    // 30 s is Whisper's native window; striding keeps word times continuous
    // across chunk seams instead of restarting at each one.
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: 'word',
    language: isEnglishOnly ? undefined : language || undefined,
    task: isEnglishOnly ? undefined : 'transcribe',
    // Voice-line dumps are unrelated one-liners, not prose. Conditioning on
    // previous text makes Whisper invent continuations and loop on repeats.
    condition_on_previous_text: false,
  })) as { text: string; chunks?: { text: string; timestamp: [number, number] }[] }

  onProgress?.({ stage: 'transcribe', fraction: 1 })

  const words: Word[] = []
  for (const chunk of output.chunks ?? []) {
    const text = (chunk.text ?? '').trim()
    const [start, end] = chunk.timestamp ?? []
    if (!text || start == null) continue
    words.push({
      start,
      // The final word of a chunk sometimes comes back open-ended; give it a
      // nominal length rather than dropping it.
      end: end == null ? start + 0.2 : end,
      text,
    })
  }

  return { words, language: language || 'auto', backend: resolved }
}

/** Transcribe one clip, for the editor's per-clip retranscribe action. */
export async function transcribeRange(
  work: Float32Array,
  startS: number,
  endS: number,
  options: TranscribeOptions = {},
): Promise<string> {
  const from = Math.max(0, Math.floor(startS * WORK_SAMPLE_RATE))
  const to = Math.min(work.length, Math.ceil(endS * WORK_SAMPLE_RATE))
  if (to <= from) return ''
  const { words } = await transcribe(work.slice(from, to), options)
  return words
    .map((word) => word.text)
    .join(' ')
    .trim()
}
