import { describe, expect, it } from 'vitest'
import { AUDIT, auditEnvelope, describeAudit } from './audit'

/** An rms envelope at 200 Hz: `pattern` gives per-second loudness. */
function envelopeOf(pattern: { seconds: number; rms: number }[]) {
  const rms: number[] = []
  for (const part of pattern) {
    rms.push(...new Array<number>(Math.round(part.seconds * 200)).fill(part.rms))
  }
  return {
    envelope: { rms: Float32Array.from(rms), sampleRate: 200 },
    durationS: rms.length / 200,
  }
}

const LOUD = 0.2
const QUIET = 0.001 // about -60 dB, well under the -45 dB threshold

describe('auditEnvelope', () => {
  it('leaves a normal sound alone', () => {
    const { envelope, durationS } = envelopeOf([{ seconds: 2, rms: LOUD }])
    expect(auditEnvelope(envelope, durationS).flags).toEqual([])
  })

  it('flags a sound past the length limit', () => {
    const { envelope, durationS } = envelopeOf([{ seconds: 31, rms: LOUD }])
    const audit = auditEnvelope(envelope, durationS)
    expect(audit.flags).toContain('too_long')
  })

  it('measures and flags a trailing tail', () => {
    const { envelope, durationS } = envelopeOf([
      { seconds: 3, rms: LOUD },
      { seconds: 2.5, rms: QUIET },
    ])
    const audit = auditEnvelope(envelope, durationS)
    expect(audit.trailingSilenceS).toBeCloseTo(2.5, 1)
    expect(audit.leadingSilenceS).toBe(0)
    expect(audit.flags).toContain('much_silence')
  })

  it('adds the edges together', () => {
    // 1.2s in front and 1.2s behind: neither alone crosses 2s, together they do.
    const { envelope, durationS } = envelopeOf([
      { seconds: 1.2, rms: QUIET },
      { seconds: 5, rms: LOUD },
      { seconds: 1.2, rms: QUIET },
    ])
    expect(auditEnvelope(envelope, durationS).flags).toContain('much_silence')
  })

  it('flags a sound that is mostly gaps even with clean edges', () => {
    const { envelope, durationS } = envelopeOf([
      { seconds: 0.5, rms: LOUD },
      { seconds: 3, rms: QUIET },
      { seconds: 0.5, rms: LOUD },
    ])
    const audit = auditEnvelope(envelope, durationS)
    expect(audit.silentFraction).toBeGreaterThan(AUDIT.silentFractionMax)
    expect(audit.flags).toContain('much_silence')
  })

  it('does not call quiet speech silence', () => {
    // -35 dB is quiet but audible; it must not count as silence.
    const { envelope, durationS } = envelopeOf([{ seconds: 4, rms: 10 ** (-35 / 20) }])
    expect(auditEnvelope(envelope, durationS).flags).toEqual([])
  })

  it('survives an entirely silent sound', () => {
    const { envelope, durationS } = envelopeOf([{ seconds: 3, rms: QUIET }])
    const audit = auditEnvelope(envelope, durationS)
    expect(audit.silentFraction).toBe(1)
    expect(audit.flags).toContain('much_silence')
  })
})

describe('describeAudit', () => {
  it('says nothing about a clean sound', () => {
    const { envelope, durationS } = envelopeOf([{ seconds: 2, rms: LOUD }])
    expect(describeAudit(auditEnvelope(envelope, durationS))).toBeNull()
  })

  it('names the tail', () => {
    const { envelope, durationS } = envelopeOf([
      { seconds: 3, rms: LOUD },
      { seconds: 2.5, rms: QUIET },
    ])
    expect(describeAudit(auditEnvelope(envelope, durationS))).toContain('at the end')
  })
})
