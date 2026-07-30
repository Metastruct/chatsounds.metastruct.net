/**
 * Getting PCM out of whatever the user dropped in.
 *
 * `decodeAudioData` handles every audio container the browser knows, and
 * `OfflineAudioContext` resamples with the browser's own resampler -- so there is
 * no ffmpeg, no WASM, and no 30 MB download in this path.
 *
 * The gap is video: mkv and avi are not decodable by any browser this way, and
 * mp4/m4a/mov depend on the build shipping AAC (Chrome and Edge do; Chromium
 * builds without proprietary codecs do not). Rather than pull in ffmpeg.wasm for
 * that tail, we detect the failure and say what to do about it.
 */

/** What the VAD and Whisper both expect. */
export const WORK_SAMPLE_RATE = 16000

/** What chatsounds wants on the way out. */
export const MASTER_SAMPLE_RATE = 44100

const ALWAYS_DECODABLE = ['.wav', '.mp3', '.ogg', '.oga', '.flac', '.opus', '.webm']
const NEEDS_CODEC_SUPPORT = ['.mp4', '.m4a', '.aac', '.mov']
const NOT_DECODABLE = ['.mkv', '.avi', '.wmv', '.flv', '.ts', '.m4v']

export const ACCEPTED_EXTENSIONS = [
  ...ALWAYS_DECODABLE,
  ...NEEDS_CODEC_SUPPORT,
  ...NOT_DECODABLE,
]

export class DecodeError extends Error {}

export interface DecodedAudio {
  /** 44.1 kHz mono, the source every exported clip is cut from. */
  master: Float32Array
  /** 16 kHz mono, the input to VAD and ASR. */
  work: Float32Array
  durationS: number
  /** What the file actually contained, for display. */
  sourceSampleRate: number
  sourceChannels: number
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at).toLowerCase()
}

export function describeUnsupported(filename: string): string | null {
  const extension = extensionOf(filename)
  if (NOT_DECODABLE.includes(extension)) {
    return (
      `No browser can read ${extension} files. Convert it first, which keeps the ` +
      `audio exactly as it is:  ffmpeg -i "${filename}" -vn -c:a copy out.m4a`
    )
  }
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return `${extension || 'That kind of file'} is not something this can open.`
  }
  return null
}

/** Average all channels down to one. */
function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  if (channels === 1) return buffer.getChannelData(0).slice()

  const out = new Float32Array(buffer.length)
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < out.length; i += 1) out[i] += data[i]
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= channels
  return out
}

async function resampleMono(
  buffer: AudioBuffer,
  sampleRate: number,
): Promise<Float32Array> {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0).slice()
  }
  const frames = Math.max(1, Math.ceil(buffer.duration * sampleRate))
  const context = new OfflineAudioContext(1, frames, sampleRate)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  const rendered = await context.startRendering()
  return rendered.getChannelData(0).slice()
}

export async function decodeFile(file: File | Blob, filename: string): Promise<DecodedAudio> {
  const unsupported = describeUnsupported(filename)
  if (unsupported) throw new DecodeError(unsupported)

  const bytes = await file.arrayBuffer()

  // A short-lived context purely for decoding; its own rate does not affect the
  // decoded buffer, which keeps the file's native rate.
  const decodeContext = new OfflineAudioContext(1, 128, MASTER_SAMPLE_RATE)
  let decoded: AudioBuffer
  try {
    decoded = await decodeContext.decodeAudioData(bytes)
  } catch (error) {
    const extension = extensionOf(filename)
    if (NEEDS_CODEC_SUPPORT.includes(extension)) {
      throw new DecodeError(
        `This browser could not read the audio in ${extension}. Not every browser ` +
          `can, and it depends on the machine. Convert it once and try again:  ` +
          `ffmpeg -i "${filename}" -vn -c:a libvorbis out.ogg`,
      )
    }
    throw new DecodeError(
      `The audio in this file could not be read (${String(error).slice(0, 120)}).`,
    )
  }

  if (decoded.length === 0) throw new DecodeError('There is no audio in this file.')

  const [master, work] = await Promise.all([
    resampleMono(decoded, MASTER_SAMPLE_RATE),
    resampleMono(decoded, WORK_SAMPLE_RATE),
  ])

  return {
    master,
    work,
    durationS: decoded.duration,
    sourceSampleRate: decoded.sampleRate,
    sourceChannels: decoded.numberOfChannels,
  }
}

/**
 * Rebuild the 16 kHz working copy from the master.
 *
 * The working audio is *transferred* into the worker rather than copied, since a
 * long recording is tens of megabytes and the main thread has no further use for
 * it. That is the right trade until the worker has to be replaced -- which is how
 * a failed transcription is retried -- and then the copy has to come back from
 * somewhere. Resampling the master again costs a second or two and no memory
 * that is not immediately handed away again, where keeping a spare copy of every
 * job would cost a third of the recording for the entire session.
 */
export async function deriveWork(master: Float32Array): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil((master.length / MASTER_SAMPLE_RATE) * WORK_SAMPLE_RATE))
  const context = new OfflineAudioContext(1, frames, WORK_SAMPLE_RATE)
  // An AudioBuffer carries its own rate, so this is the master at 44.1 kHz being
  // played into a 16 kHz context -- the browser's resampler does the work.
  const buffer = context.createBuffer(1, master.length, MASTER_SAMPLE_RATE)
  buffer.getChannelData(0).set(master)
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  source.start()
  return (await context.startRendering()).getChannelData(0).slice()
}

/** Mono is what the addon asks for on speech, so the mixdown happens up front. */
export { toMono }
