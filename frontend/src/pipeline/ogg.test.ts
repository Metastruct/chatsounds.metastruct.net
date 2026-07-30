import { describe, expect, it } from 'vitest'
import { describeOggProblem, identifyOgg } from './ogg'

/**
 * Build the first Ogg page of a stream whose lone packet is `packet`.
 * Header checksum and granule position are zeroed; the parser reads neither.
 */
function oggPage(packet: number[]): Uint8Array {
  const header = [
    0x4f, 0x67, 0x67, 0x53, // 'OggS'
    0, // stream structure version
    0x02, // beginning of stream
    ...new Array<number>(20).fill(0), // granule, serial, sequence, checksum
    1, // one segment
    packet.length, // its length
  ]
  return Uint8Array.from([...header, ...packet])
}

function vorbisIdPacket(sampleRate: number, channels: number): number[] {
  const bytes = [
    1, ...[...'vorbis'].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0, // version
    channels,
    sampleRate & 0xff, (sampleRate >> 8) & 0xff, (sampleRate >> 16) & 0xff, (sampleRate >> 24) & 0xff,
    ...new Array<number>(14).fill(0), // bitrates (12), blocksizes, framing
  ]
  return bytes
}

describe('identifyOgg', () => {
  it('reads rate and channels out of a vorbis stream', () => {
    expect(identifyOgg(oggPage(vorbisIdPacket(44100, 1)))).toEqual({
      kind: 'vorbis',
      sampleRate: 44100,
      channels: 1,
    })
    expect(identifyOgg(oggPage(vorbisIdPacket(48000, 2)))).toEqual({
      kind: 'vorbis',
      sampleRate: 48000,
      channels: 2,
    })
  })

  it('recognises opus, which shares the container', () => {
    const packet = [...'OpusHead'].map((c) => c.charCodeAt(0)).concat(new Array(22).fill(0))
    expect(identifyOgg(oggPage(packet))).toEqual({ kind: 'opus' })
  })

  it('rejects what is not ogg at all', () => {
    expect(identifyOgg(new Uint8Array([1, 2, 3]))).toEqual({ kind: 'not-ogg' })
    // RIFF/WAVE renamed to .ogg is the classic case.
    const wav = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat(new Array(60).fill(0)))
    expect(identifyOgg(wav)).toEqual({ kind: 'not-ogg' })
  })

  it('rejects a page too short to hold an id header', () => {
    expect(identifyOgg(oggPage([1, 2, 3]))).toEqual({ kind: 'not-ogg' })
  })

  it('shrugs at an ogg holding something else entirely', () => {
    const packet = [...'\x80theora'].map((c) => c.charCodeAt(0)).concat(new Array(23).fill(0))
    expect(identifyOgg(oggPage(packet))).toEqual({ kind: 'unknown-codec' })
  })
})

describe('describeOggProblem', () => {
  it('accepts 44.1 kHz vorbis, mono or stereo', () => {
    expect(describeOggProblem('a.ogg', { kind: 'vorbis', sampleRate: 44100, channels: 1 })).toBeNull()
    expect(describeOggProblem('a.ogg', { kind: 'vorbis', sampleRate: 44100, channels: 2 })).toBeNull()
  })

  it('names the wrong rate and the fix', () => {
    const reason = describeOggProblem('a.ogg', { kind: 'vorbis', sampleRate: 48000, channels: 2 })
    expect(reason).toContain('44.1 kHz')
    expect(reason).toContain('ffmpeg')
    expect(reason).toContain('-ar 44100')
  })

  it('rejects surround sound', () => {
    expect(
      describeOggProblem('a.ogg', { kind: 'vorbis', sampleRate: 44100, channels: 6 }),
    ).toContain('mono or stereo')
  })

  it('tells opus apart from not-ogg', () => {
    expect(describeOggProblem('a.ogg', { kind: 'opus' })).toContain('Opus')
    expect(describeOggProblem('a.wav', { kind: 'not-ogg' })).toContain('not an ogg file')
  })
})
