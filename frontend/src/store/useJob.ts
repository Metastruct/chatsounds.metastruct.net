/**
 * The application state that used to be a server.
 *
 * Everything lives in the tab: the decoded master audio, the envelope, the
 * segments, and the encoded clips. Nothing is uploaded anywhere.
 *
 * Clips are encoded lazily and cached by a key derived from the values that
 * affect the audio -- bounds, gain, quality. Editing a boundary therefore just
 * invalidates one entry, and moving it back reuses the previous render.
 */

import { create } from 'zustand'
import { toBlob } from '../lib/blob'
import { MASTER_SAMPLE_RATE, decodeFile, deriveWork } from '../pipeline/decode'
import { DEFAULT_QUALITY, cutClip } from '../pipeline/encode'
import { type Envelope, peaksFor } from '../pipeline/envelope'
import { fallbackTrigger, safeFileName, sanitizeTrigger } from '../pipeline/naming'
import { snapEdge } from '../pipeline/segmenter'
import { type PackSegment, buildManifest, buildZip, place } from '../pipeline/pack'
import { type Progress, RetryableError, pipeline } from './worker'
import type { AnalyzeOptions } from '../workers/pipeline.worker'

export const DEFAULTS: Required<
  Pick<
    AnalyzeOptions,
    | 'backend'
    | 'vadThreshold'
    | 'vadMinSilenceMs'
    | 'vadMinSpeechMs'
    | 'vadSpeechPadMs'
    | 'maxLineS'
    | 'splitGapMs'
    | 'snapWindowMs'
    | 'maxTriggerLength'
  >
> = {
  backend: 'auto',
  vadThreshold: 0.5,
  vadMinSilenceMs: 300,
  vadMinSpeechMs: 250,
  vadSpeechPadMs: 120,
  maxLineS: 12,
  splitGapMs: 400,
  snapWindowMs: 150,
  maxTriggerLength: 100,
}

/** Never let an edit collapse a clip to nothing. */
export const MIN_DURATION_S = 0.02

export interface Segment {
  id: string
  position: number
  startS: number
  endS: number
  transcript: string
  trigger: string
  triggerEdited: boolean
  enabled: boolean
  gainDb: number
  flags: string[]
}

export type Status = 'idle' | 'decoding' | 'processing' | 'ready' | 'failed'

interface JobState {
  status: Status
  progress: Progress | null
  error: string | null
  /** Something the run had to work around, worth saying out loud once. */
  notice: string | null

  filename: string
  /** What the download is called. Starts as the filename, and is editable. */
  name: string
  durationS: number
  backend: string

  master: Float32Array | null
  envelope: Envelope | null
  segments: Segment[]
  selectedId: string | null

  options: AnalyzeOptions

  start: (file: File, options: AnalyzeOptions) => Promise<void>
  reset: () => void

  select: (id: string | null) => void
  step: (delta: number) => void

  patch: (id: string, patch: Partial<Segment>) => void
  nudge: (id: string, edge: 'start' | 'end', deltaS: number) => void
  snap: (id: string, edge: 'start' | 'end' | 'both') => void
  /** A clip drawn by hand on the timeline. Returns its id, so it can be named. */
  create: (startS: number, endS: number) => string
  split: (id: string, atS: number) => void
  merge: (id: string, direction: 'next' | 'prev') => void
  remove: (id: string) => void
  retranscribe: (id: string) => Promise<void>

  setName: (name: string) => void

  clipFor: (id: string) => Promise<Uint8Array>
  clipUrl: (id: string) => Promise<string>
  buildDownload: () => Promise<Uint8Array>
  manifest: () => ReturnType<typeof buildManifest>
  peaks: () => ReturnType<typeof peaksFor> | null
}

let uid = 0
const nextId = () => `s${++uid}`

/**
 * Run the analysis, and when the worker says the same audio deserves another
 * attempt with different settings, give it a new worker and do exactly that.
 *
 * The new worker is not an optimisation, it is the whole mechanism:
 * transformers.js funnels every session create and every inference through a
 * promise chain it never clears, so one rejection leaves that chain rejected and
 * every later call in that worker returns the same error without running
 * anything. Nothing short of a fresh module can recover, and `dispose` gives us
 * one. The ladder is short and each rung changes something, so it terminates.
 */
async function analyzeWithFallback(
  work: Float32Array,
  master: Float32Array,
  durationS: number,
  options: AnalyzeOptions,
  say: (message: string) => void,
) {
  let attempt = work
  let current = options

  for (let rung = 0; ; rung += 1) {
    try {
      const result = await pipeline.analyze(attempt, durationS, current)
      return { ...result, used: current }
    } catch (error) {
      if (!(error instanceof RetryableError) || rung >= 2) throw error

      const { backend, precision } = error.retry
      say(
        backend === 'wasm' && current.backend !== 'wasm'
          ? 'the graphics card gave out, so this is starting again on the processor'
          : 'that version of the model would not load, so this is starting again with the bigger one',
      )
      console.warn('retrying analysis', error.retry, 'after:', error.message)

      // The worker owns the only copy of the working audio -- it was transferred,
      // not shared -- so replacing the worker means rebuilding it.
      pipeline.dispose()
      attempt = await deriveWork(master)
      current = { ...current, backend, precision }
    }
  }
}

/** Encoded clips, keyed by the values that affect the audio. */
const clipCache = new Map<string, Uint8Array>()
const urlCache = new Map<string, string>()

function clipKey(segment: Segment): string {
  return `${segment.id}:${segment.startS.toFixed(4)}:${segment.endS.toFixed(4)}:${segment.gainDb.toFixed(2)}`
}

function renumber(segments: Segment[]): Segment[] {
  return segments.map((segment, index) => ({ ...segment, position: index }))
}

function toPackSegments(segments: Segment[]): PackSegment[] {
  return segments.map((segment) => ({
    id: segment.id,
    position: segment.position,
    startS: segment.startS,
    endS: segment.endS,
    trigger: segment.trigger,
    enabled: segment.enabled,
    flags: segment.flags,
  }))
}

export const useJob = create<JobState>((set, get) => ({
  status: 'idle',
  progress: null,
  error: null,
  notice: null,
  filename: '',
  name: 'clips',
  durationS: 0,
  backend: '',
  master: null,
  envelope: null,
  segments: [],
  selectedId: null,
  options: { ...DEFAULTS },

  async start(file, options) {
    get().reset()
    const merged = { ...DEFAULTS, ...options }
    set({
      status: 'decoding',
      filename: file.name,
      // The recording's own name, without its extension, is the best guess at
      // what this set of clips should be called.
      name: safeFileName(file.name.replace(/\.[^.]+$/, '')),
      options: merged,
      notice: null,
      progress: { stage: 'decoding', fraction: 0.01, message: 'reading the file' },
    })

    pipeline.setProgressHandler((progress) => set({ progress }))

    try {
      const decoded = await decodeFile(file, file.name)
      set({
        status: 'processing',
        master: decoded.master,
        durationS: decoded.durationS,
        progress: { stage: 'analyzing', fraction: 0.05, message: 'starting up' },
      })

      const { envelope, lines, backend, used } = await analyzeWithFallback(
        decoded.work,
        decoded.master,
        decoded.durationS,
        merged,
        // Starting over is honest about it: the stage list rewinds to the top,
        // because the new worker really does re-measure and re-detect.
        (message) =>
          set({
            notice: message,
            progress: { stage: 'analyzing', fraction: 0.05, message },
          }),
      )
      // Whatever combination actually worked is what the editor's per-clip
      // retranscribe should use, rather than walking the ladder again per clip.
      set({ options: used })

      const segments: Segment[] = lines.map((line, position) => ({
        id: nextId(),
        position,
        startS: line.startS,
        endS: line.endS,
        transcript: line.transcript,
        trigger: line.trigger,
        triggerEdited: false,
        enabled: true,
        gainDb: 0,
        flags: line.flags,
      }))

      set({
        status: 'ready',
        backend,
        envelope: {
          sampleRate: envelope.sampleRate,
          hop: envelope.hop,
          min: envelope.min,
          max: envelope.max,
          rms: envelope.rms,
        },
        segments,
        selectedId: segments[0]?.id ?? null,
        progress: null,
      })

    } catch (error) {
      set({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        progress: null,
      })
    }
  },

  reset() {
    pipeline.dispose()
    pipeline.setProgressHandler(null)
    for (const url of urlCache.values()) URL.revokeObjectURL(url)
    urlCache.clear()
    clipCache.clear()
    set({
      status: 'idle',
      progress: null,
      error: null,
      notice: null,
      filename: '',
      durationS: 0,
      backend: '',
      master: null,
      envelope: null,
      segments: [],
      selectedId: null,
    })
  },

  select(id) {
    set({ selectedId: id })
  },

  step(delta) {
    const { segments, selectedId } = get()
    if (!segments.length) return
    const index = segments.findIndex((segment) => segment.id === selectedId)
    const next = Math.min(Math.max(index + delta, 0), segments.length - 1)
    set({ selectedId: segments[next].id })
  },

  patch(id, patch) {
    const { durationS } = get()
    set((state) => ({
      segments: state.segments.map((segment) => {
        if (segment.id !== id) return segment
        const next = { ...segment, ...patch }

        if (patch.startS !== undefined || patch.endS !== undefined) {
          // Deliberately not clamped against neighbours: extending a clip into
          // the silence beside it -- or over the next line -- is a legitimate
          // thing to want, and each clip is cut independently anyway.
          let start = Math.max(0, Math.min(next.startS, durationS))
          let end = Math.max(0, Math.min(next.endS, durationS))
          if (end - start < MIN_DURATION_S) {
            end = Math.min(durationS, start + MIN_DURATION_S)
            if (end - start < MIN_DURATION_S) start = Math.max(0, end - MIN_DURATION_S)
          }
          next.startS = round4(start)
          next.endS = round4(end)
        }

        if (patch.trigger !== undefined) {
          next.trigger =
            sanitizeTrigger(patch.trigger, state.options.maxTriggerLength) ||
            fallbackTrigger(segment.position)
          next.triggerEdited = true
        }

        return next
      }),
    }))
  },

  nudge(id, edge, deltaS) {
    const segment = get().segments.find((item) => item.id === id)
    if (!segment) return
    get().patch(
      id,
      edge === 'start' ? { startS: segment.startS + deltaS } : { endS: segment.endS + deltaS },
    )
  },

  snap(id, edge) {
    const { segments, envelope, durationS, options } = get()
    if (!envelope) return
    const segment = segments.find((item) => item.id === id)
    if (!segment) return

    const windowS = (options.snapWindowMs ?? DEFAULTS.snapWindowMs) / 1000
    let start = segment.startS
    let end = segment.endS

    if (edge === 'start' || edge === 'both') {
      start = snapEdge(envelope, start, {
        lowerS: 0,
        upperS: end - MIN_DURATION_S,
        windowS,
      })
    }
    if (edge === 'end' || edge === 'both') {
      end = snapEdge(envelope, end, {
        lowerS: start + MIN_DURATION_S,
        upperS: durationS || end + windowS,
        windowS,
      })
    }
    get().patch(id, { startS: start, endS: end })
  },

  create(startS, endS) {
    const { durationS } = get()
    const limit = durationS || endS
    let start = Math.max(0, Math.min(startS, limit))
    let end = Math.max(0, Math.min(endS, limit))
    if (end < start) [start, end] = [end, start]
    if (end - start < MIN_DURATION_S) end = Math.min(limit, start + MIN_DURATION_S)

    const segment: Segment = {
      id: nextId(),
      position: 0,
      startS: round4(start),
      endS: round4(end),
      // A hand-drawn clip has no words behind it yet; the editor asks for them
      // straight away, and until they arrive the name is a placeholder.
      transcript: '',
      trigger: '',
      triggerEdited: false,
      enabled: true,
      gainDb: 0,
      flags: [],
    }

    set((state) => {
      const segments = renumber(
        [...state.segments, segment].sort((a, b) => a.startS - b.startS),
      )
      // Named for where it landed, not for the order it was drawn in.
      const placed = segments.find((item) => item.id === segment.id)
      if (placed) placed.trigger = fallbackTrigger(placed.position)
      return { segments, selectedId: segment.id }
    })
    // Drawn by hand means the edges are wherever the pointer happened to be, so
    // they are pulled to the nearest quiet point the same way the segmenter's own
    // boundaries are.
    get().snap(segment.id, 'both')
    return segment.id
  },

  split(id, atS) {
    set((state) => {
      const index = state.segments.findIndex((segment) => segment.id === id)
      if (index < 0) return state
      const segment = state.segments[index]
      if (atS < segment.startS + MIN_DURATION_S || atS > segment.endS - MIN_DURATION_S) {
        return state
      }

      const at = round4(atS)
      const head: Segment = { ...segment, endS: at }
      const tail: Segment = {
        ...segment,
        id: nextId(),
        startS: at,
        // There is no word-level timing left at this point, so the second half
        // starts unnamed; retranscribe fills it in on demand.
        transcript: '',
        trigger: fallbackTrigger(segment.position + 1),
        triggerEdited: false,
        flags: [],
      }

      const segments = renumber([
        ...state.segments.slice(0, index),
        head,
        tail,
        ...state.segments.slice(index + 1),
      ])
      return { segments, selectedId: tail.id }
    })
  },

  merge(id, direction) {
    set((state) => {
      const index = state.segments.findIndex((segment) => segment.id === id)
      const otherIndex = direction === 'next' ? index + 1 : index - 1
      if (index < 0 || otherIndex < 0 || otherIndex >= state.segments.length) return state

      const a = state.segments[Math.min(index, otherIndex)]
      const b = state.segments[Math.max(index, otherIndex)]
      const merged: Segment = {
        ...a,
        startS: Math.min(a.startS, b.startS),
        endS: Math.max(a.endS, b.endS),
        transcript: [a.transcript, b.transcript].filter(Boolean).join(' ').trim(),
        flags: [...new Set([...(a.flags ?? []), ...(b.flags ?? [])])].sort(),
        triggerEdited: a.triggerEdited || b.triggerEdited,
      }
      if (!merged.triggerEdited) {
        merged.trigger =
          sanitizeTrigger(merged.transcript, state.options.maxTriggerLength) ||
          fallbackTrigger(a.position)
      }

      const segments = renumber(
        state.segments.filter((segment) => segment !== a && segment !== b).concat(merged),
      ).sort((x, y) => x.startS - y.startS)
      return { segments: renumber(segments), selectedId: merged.id }
    })
  },

  remove(id) {
    set((state) => {
      const index = state.segments.findIndex((segment) => segment.id === id)
      const segments = renumber(state.segments.filter((segment) => segment.id !== id))
      return {
        segments,
        selectedId: segments[Math.min(index, segments.length - 1)]?.id ?? null,
      }
    })
  },

  async retranscribe(id) {
    const segment = get().segments.find((item) => item.id === id)
    if (!segment) return
    const { text } = await pipeline.retranscribe(segment.startS, segment.endS, get().options)
    set((state) => ({
      segments: state.segments.map((item) =>
        item.id === id
          ? {
              ...item,
              transcript: text,
              triggerEdited: false,
              trigger:
                sanitizeTrigger(text, state.options.maxTriggerLength) ||
                fallbackTrigger(item.position),
              flags: text
                ? item.flags.filter((flag) => flag !== 'no_speech')
                : [...new Set([...item.flags, 'no_speech'])],
            }
          : item,
      ),
    }))
  },

  setName(name) {
    set({ name: safeFileName(name, get().name) })
  },

  async clipFor(id) {
    const { master, segments } = get()
    const segment = segments.find((item) => item.id === id)
    if (!master || !segment) throw new Error('that clip is not available')

    const key = clipKey(segment)
    const cached = clipCache.get(key)
    if (cached) return cached

    const pcm = cutClip(master, segment.startS, segment.endS, {
      gainDb: segment.gainDb,
      sampleRate: MASTER_SAMPLE_RATE,
    })
    const { clips } = await pipeline.encode([{ segmentId: id, pcm }], DEFAULT_QUALITY, MASTER_SAMPLE_RATE)
    const bytes = clips[0].bytes
    clipCache.set(key, bytes)
    return bytes
  },

  async clipUrl(id) {
    const segment = get().segments.find((item) => item.id === id)
    if (!segment) throw new Error('that clip is not available')
    const key = clipKey(segment)
    const existing = urlCache.get(key)
    if (existing) return existing

    const bytes = await get().clipFor(id)
    const url = URL.createObjectURL(toBlob(bytes, 'audio/ogg'))
    urlCache.set(key, url)
    return url
  },

  async buildDownload() {
    const { master, segments } = get()
    if (!master) throw new Error('there is no audio loaded')

    const included = segments.filter((segment) => segment.enabled)
    if (!included.length) throw new Error('every clip is left out, so there is nothing to save')

    // Encode whatever is not already cached, in one trip to the worker.
    const missing = included.filter((segment) => !clipCache.has(clipKey(segment)))
    if (missing.length) {
      const { clips } = await pipeline.encode(
        missing.map((segment) => ({
          segmentId: segment.id,
          pcm: cutClip(master, segment.startS, segment.endS, {
            gainDb: segment.gainDb,
            sampleRate: MASTER_SAMPLE_RATE,
          }),
        })),
        DEFAULT_QUALITY,
        MASTER_SAMPLE_RATE,
      )
      clips.forEach((clip, index) => clipCache.set(clipKey(missing[index]), clip.bytes))
    }

    const byId = new Map<string, Uint8Array>()
    for (const segment of included) {
      const bytes = clipCache.get(clipKey(segment))
      if (bytes) byId.set(segment.id, bytes)
    }

    return buildZip(toPackSegments(segments), byId)
  },

  manifest() {
    return buildManifest(toPackSegments(get().segments))
  },

  peaks() {
    const { envelope } = get()
    return envelope ? peaksFor(envelope) : null
  },
}))

/** Where each enabled clip lands, keyed by segment id. */
export function relativePaths(segments: Segment[]): Map<string, string> {
  return new Map(
    place(toPackSegments(segments)).map(([segment, placed]) => [
      segment.id,
      placed.relativePath,
    ]),
  )
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4
}
