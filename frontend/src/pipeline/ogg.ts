/**
 * What is actually inside an .ogg file, read from its first page.
 *
 * The Upload form has to reject anything the addon cannot play, and the
 * extension says almost nothing: an .ogg is a container, and these days it
 * usually holds Opus, which GMod's BASS needs a plugin for. Decoding the audio
 * just to learn this would read the whole file through the Web Audio stack; the
 * identification header carries the channel count and sample rate in its first
 * dozen bytes, so the first kilobyte is enough.
 *
 * Layout, per RFC 3533 and the Vorbis I spec: an Ogg page starts `OggS`, byte 26
 * holds the segment count, the segment table follows, and the first packet
 * starts right after it. For Vorbis that packet begins `\x01vorbis`, then
 * version (u32), channels (u8 at offset 11), sample rate (u32 LE at offset 12).
 * Opus announces itself with `OpusHead` in the same position.
 */

export type OggInfo =
  | { kind: 'vorbis'; sampleRate: number; channels: number }
  | { kind: 'opus' }
  | { kind: 'not-ogg' }
  | { kind: 'unknown-codec' }

export function identifyOgg(bytes: Uint8Array): OggInfo {
  // 'OggS', version 0. Byte 5 is the page type; the first page of a stream is
  // marked beginning-of-stream (0x02), but that is not worth rejecting over.
  if (
    bytes.length < 28 ||
    bytes[0] !== 0x4f ||
    bytes[1] !== 0x67 ||
    bytes[2] !== 0x67 ||
    bytes[3] !== 0x53 ||
    bytes[4] !== 0
  ) {
    return { kind: 'not-ogg' }
  }

  const segments = bytes[26]
  const packet = 27 + segments
  // The id header is 30 bytes; a first page too short to hold one is not a
  // stream any decoder would accept either.
  if (bytes.length < packet + 30) return { kind: 'not-ogg' }

  const startsWith = (at: number, text: string) =>
    [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0))

  if (bytes[packet] === 1 && startsWith(packet + 1, 'vorbis')) {
    const at = packet + 7 + 4 // past '\x01vorbis' and the version field
    return {
      kind: 'vorbis',
      channels: bytes[at],
      sampleRate:
        bytes[at + 1] | (bytes[at + 2] << 8) | (bytes[at + 3] << 16) | ((bytes[at + 4] << 24) >>> 0),
    }
  }

  if (startsWith(packet, 'OpusHead')) return { kind: 'opus' }

  return { kind: 'unknown-codec' }
}

/** How many bytes `identifyOgg` needs. One slice, no full read. */
export const OGG_PROBE_BYTES = 1024

/**
 * Why a file cannot go in, or null when it can.
 *
 * The reasons are exact on purpose: every one of these is fixable with one
 * ffmpeg line, and naming that line is the only useful thing to say.
 */
export function describeOggProblem(name: string, info: OggInfo): string | null {
  const fix = (args: string) => `ffmpeg -i "${name}" ${args} out.ogg`

  switch (info.kind) {
    case 'not-ogg':
      return (
        `${name} is not an ogg file. Convert it first:  ` +
        fix('-c:a libvorbis -ar 44100 -ac 1')
      )
    case 'opus':
      return (
        `${name} holds Opus, and the game can only play Vorbis. Convert it:  ` +
        fix('-c:a libvorbis -ar 44100')
      )
    case 'unknown-codec':
      return `${name} is an ogg file, but not Vorbis. Convert it:  ${fix('-c:a libvorbis -ar 44100')}`
    case 'vorbis':
      if (info.sampleRate !== 44100) {
        return (
          `${name} is ${(info.sampleRate / 1000).toLocaleString()} kHz, and the game wants ` +
          `44.1 kHz. Convert it:  ${fix('-ar 44100')}`
        )
      }
      if (info.channels < 1 || info.channels > 2) {
        return (
          `${name} has ${info.channels} channels, and the game plays mono or stereo. ` +
          `Convert it:  ${fix('-ac 2')}`
        )
      }
      return null
  }
}
