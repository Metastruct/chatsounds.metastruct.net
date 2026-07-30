import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { cutClip } from './encode'
import { type PackSegment, buildManifest, buildZip, place } from './pack'

function segment(position: number, trigger: string, extra: Partial<PackSegment> = {}): PackSegment {
  return {
    id: `s${position}`,
    position,
    startS: position,
    endS: position + 1,
    trigger,
    enabled: true,
    flags: [],
    ...extra,
  }
}

describe('buildManifest', () => {
  it('names a clip after its trigger, at the top level', () => {
    // Flat on purpose: where these end up in a repository is not decided here.
    const manifest = buildManifest([segment(0, 'hello there')])
    expect(manifest.entries[0].relativePath).toBe('hello there.ogg')
  })

  it('excludes disabled clips', () => {
    const manifest = buildManifest([
      segment(0, 'kept'),
      segment(1, 'dropped', { enabled: false }),
    ])
    expect(manifest.entries.map((e) => e.trigger)).toEqual(['kept'])
  })

  it('turns duplicates into a variation group', () => {
    const manifest = buildManifest([segment(0, 'yes'), segment(1, 'yes')])
    expect(manifest.variationGroups).toEqual({ yes: 2 })
    expect(manifest.entries.map((e) => e.relativePath)).toEqual(['yes/01.ogg', 'yes/02.ogg'])
  })

  it('re-sanitises a stored trigger on the way out', () => {
    // Nothing should be able to put punctuation into the tree, even if a value
    // was written by an older version or edited out of band.
    const manifest = buildManifest([segment(0, 'Hello, There!')])
    expect(manifest.entries[0].relativePath).toBe('hello there.ogg')
  })

  it('falls back to a position name for an empty trigger', () => {
    const manifest = buildManifest([segment(3, '...')])
    expect(manifest.entries[0].trigger).toBe('line 004')
  })

  it('warns when nothing is enabled', () => {
    const manifest = buildManifest([segment(0, 'x', { enabled: false })])
    expect(manifest.entries).toEqual([])
    expect(manifest.warnings.some((w) => w.includes('Nothing to save'))).toBe(true)
  })

  it('covers every enabled clip exactly once', () => {
    const segments = Array.from({ length: 5 }, (_, i) => segment(i, `line ${i}`))
    const pairs = place(segments)
    expect(pairs).toHaveLength(5)
    expect(new Set(pairs.map(([, p]) => p.relativePath)).size).toBe(5)
  })
})

describe('the names are safe to publish', () => {
  it('is lowercase, ascii, and ogg-only', () => {
    // Whatever publishes these keeps the names as they are, so they have to
    // already satisfy the addon: the legacy preprocessor skips any path that is
    // not lowercase, and the modern loader only looks at .ogg.
    const manifest = buildManifest([
      segment(0, 'Hello THERE'),
      segment(1, 'Café'),
      segment(2, 'yes'),
      segment(3, 'yes'),
    ])
    for (const entry of manifest.entries) {
      expect(entry.relativePath).toBe(entry.relativePath.toLowerCase())
      expect(entry.relativePath.endsWith('.ogg')).toBe(true)
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(entry.relativePath)).toBe(true)
    }
  })
})

describe('buildZip', () => {
  const clips = new Map<string, Uint8Array>([
    ['s0', new Uint8Array([1, 2, 3])],
    ['s1', new Uint8Array([4, 5, 6])],
    ['s2', new Uint8Array([7, 8, 9])],
  ])

  it('puts clips at the top level, with no folder to sit under', () => {
    const zip = unzipSync(
      buildZip([segment(0, 'hello there'), segment(1, 'yes'), segment(2, 'yes')], clips),
    )
    // Two clips called "yes" cannot both be `yes.ogg`, so they become numbered
    // variations of one name, which is what the addon picks between at random.
    expect(Object.keys(zip).sort()).toEqual([
      'hello there.ogg',
      'yes/01.ogg',
      'yes/02.ogg',
    ])
  })

  it('stores the clip bytes untouched', () => {
    const zip = unzipSync(buildZip([segment(0, 'a')], clips))
    expect([...zip['a.ogg']]).toEqual([1, 2, 3])
  })

  it('skips clips that have not been rendered', () => {
    const zip = unzipSync(buildZip([segment(0, 'a'), segment(9, 'missing')], clips))
    expect(Object.keys(zip)).toEqual(['a.ogg'])
  })
})

describe('cutClip', () => {
  const sampleRate = 1000
  const flat = () => Float32Array.from({ length: sampleRate }, () => 1)

  it('copies the requested range', () => {
    const clip = cutClip(flat(), 0.2, 0.5, { sampleRate })
    expect(clip.length).toBe(300)
  })

  it('fades both edges to zero', () => {
    // A hard cut leaves a step in the waveform, which is an audible click.
    const clip = cutClip(flat(), 0, 1, { sampleRate })
    expect(clip[0]).toBeCloseTo(0)
    expect(clip[clip.length - 1]).toBeCloseTo(0, 1)
    expect(clip[Math.floor(clip.length / 2)]).toBeCloseTo(1)
  })

  it('applies gain in decibels', () => {
    const clip = cutClip(Float32Array.from({ length: sampleRate }, () => 0.25), 0, 1, {
      sampleRate,
      gainDb: 6,
    })
    // +6 dB is roughly a doubling.
    expect(clip[Math.floor(clip.length / 2)]).toBeCloseTo(0.5, 1)
  })

  it('clamps rather than wrapping when gain overshoots', () => {
    const clip = cutClip(flat(), 0, 1, { sampleRate, gainDb: 20 })
    expect(Math.max(...clip)).toBeLessThanOrEqual(1)
    expect(Math.min(...clip)).toBeGreaterThanOrEqual(-1)
  })

  it('clamps the range to the available audio', () => {
    const clip = cutClip(flat(), 0.8, 5, { sampleRate })
    expect(clip.length).toBe(200)
  })

  it('returns nothing for an inverted or empty range', () => {
    expect(cutClip(flat(), 0.5, 0.5, { sampleRate }).length).toBe(0)
    expect(cutClip(flat(), 0.6, 0.2, { sampleRate }).length).toBe(0)
  })
})
