/** Promise-shaped access to the pipeline worker. */

import PipelineWorker from '../workers/pipeline.worker?worker'
import type {
  AnalyzeOptions,
  AnalyzedLine,
  SerializedEnvelope,
  WorkerRequest,
  WorkerResponse,
} from '../workers/pipeline.worker'

export interface Progress {
  stage: string
  fraction: number
  message: string
  /** Byte counts, present only while the speech model is downloading. */
  loaded?: number
  total?: number
}

interface Pending {
  resolve: (value: never) => void
  reject: (error: Error) => void
}

type Retry = NonNullable<Extract<WorkerResponse, { type: 'error' }>['retry']>

/**
 * A failure the same audio could survive, in a worker that has not already had
 * transformers.js poison its promise chains.
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retry: Retry,
  ) {
    super(message)
    this.name = 'RetryableError'
  }
}

class PipelineClient {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private onProgress: ((progress: Progress) => void) | null = null

  setProgressHandler(handler: ((progress: Progress) => void) | null) {
    this.onProgress = handler
  }

  /** Drop the worker, releasing the working audio it holds. */
  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.failAll(new Error('cancelled'))
  }

  private failAll(error: Error) {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }

  private ensure(): Worker {
    if (this.worker) return this.worker

    const worker = new PipelineWorker()
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === 'progress') {
        this.onProgress?.(message)
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.type === 'error') {
        pending.reject(
          message.retry
            ? new RetryableError(message.message, message.retry)
            : new Error(message.message),
        )
      } else pending.resolve(message as never)
    }
    worker.onerror = (event) =>
      this.failAll(new Error(event.message || 'something went wrong working on the audio'))

    this.worker = worker
    return worker
  }

  /**
   * `build` receives the id rather than the request being spread from a partial:
   * `Omit<Union, 'id'>` collapses a discriminated union into its shared keys, so
   * every payload field would be rejected.
   */
  private send<T>(build: (id: number) => WorkerRequest, transfer: Transferable[] = []): Promise<T> {
    const worker = this.ensure()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject })
      worker.postMessage(build(id), transfer)
    })
  }

  analyze(work: Float32Array, durationS: number, options: AnalyzeOptions) {
    // Transferred, not copied: a long recording's working audio is tens to
    // hundreds of megabytes, and the main thread has no further use for it.
    return this.send<{ envelope: SerializedEnvelope; lines: AnalyzedLine[]; backend: string }>(
      (id) => ({ id, type: 'analyze', work, durationS, options }),
      [work.buffer],
    )
  }

  encode(clips: { segmentId: string; pcm: Float32Array }[], quality: number, sampleRate: number) {
    return this.send<{ clips: { segmentId: string; bytes: Uint8Array }[] }>(
      (id) => ({ id, type: 'encode', clips, quality, sampleRate }),
      clips.map((clip) => clip.pcm.buffer),
    )
  }

  retranscribe(startS: number, endS: number, options: AnalyzeOptions) {
    return this.send<{ text: string }>((id) => ({
      id,
      type: 'retranscribe',
      startS,
      endS,
      options,
    }))
  }
}

export const pipeline = new PipelineClient()
