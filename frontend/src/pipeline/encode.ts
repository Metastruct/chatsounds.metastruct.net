/**
 * Cutting a clip out of the master and encoding it as Ogg Vorbis.
 *
 * Vorbis specifically: the addon's docs ask for ogg, and GMod plays chatsounds
 * through BASS, which handles Vorbis natively but needs a plugin for Opus. That
 * rules out everything the browser can encode on its own -- `MediaRecorder` only
 * offers Opus -- so libvorbis is compiled to WASM instead. It is 158 KiB gzipped,
 * which is a fair price for producing files the addon will actually play.
 */

import { createEncoder } from 'wasm-media-encoders'
// Vite emits the wasm as an asset and hands us its URL. The library's own
// convenience helper tries to resolve the binary itself and fails under a
// bundler, so it is passed explicitly.
import oggWasmUrl from 'wasm-media-encoders/wasm/ogg.wasm?url'
import { MASTER_SAMPLE_RATE } from './decode'

/** libvorbis VBR quality is -0.1..1.0; ffmpeg's `-q:a 3` is 0.3. */
export const DEFAULT_QUALITY = 0.3

/** Cutting at an arbitrary sample leaves a step in the waveform, which clicks. */
const FADE_MS = 8

export interface EncodeOptions {
  quality?: number
  gainDb?: number
  sampleRate?: number
}

type OggEncoder = Awaited<ReturnType<typeof createEncoder<'audio/ogg'>>>

let encoderPromise: Promise<OggEncoder> | null = null

function getEncoder(): Promise<OggEncoder> {
  if (!encoderPromise) {
    encoderPromise = createEncoder('audio/ogg', oggWasmUrl)
  }
  return encoderPromise
}

/**
 * Copy `[startS, endS)` out of `master`, apply gain, and fade the edges.
 *
 * The fade is a few milliseconds -- enough to kill the click, short enough not to
 * eat into the speech.
 */
export function cutClip(
  master: Float32Array,
  startS: number,
  endS: number,
  { gainDb = 0, sampleRate = MASTER_SAMPLE_RATE }: EncodeOptions = {},
): Float32Array {
  const from = Math.max(0, Math.round(startS * sampleRate))
  const to = Math.min(master.length, Math.round(endS * sampleRate))
  if (to <= from) return new Float32Array(0)

  const clip = master.slice(from, to)
  const gain = gainDb === 0 ? 1 : 10 ** (gainDb / 20)
  const fade = Math.min(Math.round((FADE_MS / 1000) * sampleRate), Math.floor(clip.length / 4))

  for (let i = 0; i < clip.length; i += 1) {
    let value = clip[i] * gain
    if (fade > 0) {
      if (i < fade) value *= i / fade
      else if (i >= clip.length - fade) value *= (clip.length - 1 - i) / fade
    }
    // Gain can push a clip past full scale; clamp rather than letting the
    // encoder wrap it into a crackle.
    clip[i] = value > 1 ? 1 : value < -1 ? -1 : value
  }
  return clip
}

/** Encode mono PCM as an Ogg Vorbis file. */
export async function encodeOgg(
  samples: Float32Array,
  { quality = DEFAULT_QUALITY, sampleRate = MASTER_SAMPLE_RATE }: EncodeOptions = {},
): Promise<Uint8Array> {
  const encoder = await getEncoder()
  encoder.configure({ sampleRate, channels: 1, vbrQuality: quality })

  const chunks: Uint8Array[] = []
  // The encoder reuses its output buffer between calls, so each chunk has to be
  // copied out before the next one overwrites it.
  chunks.push(encoder.encode([samples]).slice())
  chunks.push(encoder.finalize().slice())

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export async function renderClip(
  master: Float32Array,
  startS: number,
  endS: number,
  options: EncodeOptions = {},
): Promise<Uint8Array> {
  return encodeOgg(cutClip(master, startS, endS, options), options)
}
