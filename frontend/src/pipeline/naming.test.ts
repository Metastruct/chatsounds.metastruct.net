import { describe, expect, it } from 'vitest'
import {
  RESERVED,
  fallbackTrigger,
  neoChatsoundsKey,
  resolvePaths,
  safeFileName,
  sanitizeRealm,
  sanitizeTrigger,
} from './naming'

describe('sanitizeTrigger', () => {
  it('handles plain speech', () => {
    expect(sanitizeTrigger('Hello there!')).toBe('hello there')
  })

  it('closes apostrophes up rather than splitting them', () => {
    // The chat parser strips ' from typed input, so "don't" is typed as "dont" --
    // the filename has to match that, not "don t".
    expect(sanitizeTrigger("Don't you dare")).toBe('dont you dare')
    expect(sanitizeTrigger('it’s fine')).toBe('its fine')
  })

  it('drops quotes', () => {
    expect(sanitizeTrigger('he said "hi"')).toBe('he said hi')
  })

  it('treats other punctuation as a separator', () => {
    // Removing rather than separating would fuse words.
    expect(sanitizeTrigger('hello.world')).toBe('hello world')
    expect(sanitizeTrigger('wait -- what?')).toBe('wait what')
    expect(sanitizeTrigger('50% off, now!')).toBe('50 off now')
  })

  it('turns underscores and hyphens into spaces', () => {
    expect(sanitizeTrigger('bat_strike')).toBe('bat strike')
    expect(sanitizeTrigger('half-life')).toBe('half life')
  })

  it('folds accents to ascii', () => {
    expect(sanitizeTrigger('Café Naïve')).toBe('cafe naive')
  })

  it('discards non-latin text', () => {
    expect(sanitizeTrigger('привет')).toBe('')
    expect(sanitizeTrigger('ok привет ok')).toBe('ok ok')
  })

  it('collapses whitespace', () => {
    expect(sanitizeTrigger('  too   many\n\tspaces  ')).toBe('too many spaces')
  })

  it('keeps digits', () => {
    expect(sanitizeTrigger('Area 51')).toBe('area 51')
  })

  it('returns empty for nothing usable', () => {
    expect(sanitizeTrigger('')).toBe('')
    expect(sanitizeTrigger('...')).toBe('')
    expect(sanitizeTrigger('   ')).toBe('')
  })

  it('always emits lowercase alphanumeric and single spaces', () => {
    // The legacy preprocessor rejects any non-lowercase path outright.
    for (const raw of ['MiXeD CaSe', 'Ünïcôdé', 'tabs\there', 'a!@#$%^&*b']) {
      const out = sanitizeTrigger(raw)
      expect(out).toBe(out.toLowerCase())
      expect(out).toBe(out.trim())
      expect(out).not.toContain('  ')
      expect(/^[a-z0-9 ]*$/.test(out)).toBe(true)
    }
  })
})

describe('truncation', () => {
  it('cuts on a word boundary', () => {
    expect(sanitizeTrigger('one two three four', 11)).toBe('one two')
  })

  it('hard cuts a single long word', () => {
    expect(sanitizeTrigger('a'.repeat(20), 8)).toBe('a'.repeat(8))
  })

  it('leaves no trailing space after a cut', () => {
    const out = sanitizeTrigger('hello there general kenobi', 12)
    expect(out).toBe('hello there')
    expect(out.endsWith(' ')).toBe(false)
  })

  it('leaves short text untouched', () => {
    expect(sanitizeTrigger('short', 100)).toBe('short')
  })
})

describe('reserved names', () => {
  it('escapes sh, the addon stop key', () => {
    expect(sanitizeTrigger('Sh!')).toBe('sh sound')
  })

  it('escapes windows device names', () => {
    // A repo containing con.ogg cannot be checked out on Windows.
    expect(sanitizeTrigger('con')).toBe('con sound')
    expect(sanitizeTrigger('COM1')).toBe('com1 sound')
  })

  it('never leaves a reserved word as the whole trigger', () => {
    for (const name of RESERVED) {
      expect(RESERVED.has(sanitizeTrigger(name))).toBe(false)
    }
  })

  it('leaves a reserved word inside a phrase alone', () => {
    expect(sanitizeTrigger('sh be quiet')).toBe('sh be quiet')
  })
})

describe('round trip through the addon', () => {
  const CASES = [
    'Hello there!',
    "Don't you dare",
    'wait -- what?',
    'Café Naïve',
    '  too   many spaces ',
    '50% off, now!',
    'bat_strike',
  ]

  it('derives a filename back to the same trigger', () => {
    for (const raw of CASES) {
      const trigger = sanitizeTrigger(raw)
      expect(neoChatsoundsKey(`${trigger}.ogg`)).toBe(trigger)
    }
  })

  it('derives a folder name back to the same trigger', () => {
    for (const raw of CASES) {
      const trigger = sanitizeTrigger(raw)
      expect(neoChatsoundsKey(trigger)).toBe(trigger)
    }
  })
})

describe('sanitizeRealm', () => {
  it('keeps snake_case, which is the repo convention', () => {
    expect(sanitizeRealm('2000s_memes')).toBe('2000s_memes')
  })

  it('folds a typed name into it', () => {
    expect(sanitizeRealm('Portal Turret!')).toBe('portal_turret')
    // The accent goes, the letter under it stays.
    expect(sanitizeRealm('Café Sounds')).toBe('cafe_sounds')
  })

  it('returns nothing rather than inventing a name', () => {
    expect(sanitizeRealm('!!!')).toBe('')
    expect(sanitizeRealm('')).toBe('')
    // `sh` is reserved by the addon for stopping playback.
    expect(sanitizeRealm('sh')).toBe('')
  })
})

describe('safeFileName', () => {
  it('leaves an ordinary name alone, case and spaces included', () => {
    // This names a download, not a sound, so none of the trigger rules apply.
    expect(safeFileName('Turret voice lines')).toBe('Turret voice lines')
  })

  it('refuses to be read as a path', () => {
    // Separators become spaces and the leading dots go, so what is left cannot
    // climb out of wherever the browser puts downloads.
    expect(safeFileName('../../etc/passwd')).toBe('.. etc passwd')
    expect(safeFileName('C:\\clips')).toBe('C clips')
  })

  it('drops what a filesystem would refuse', () => {
    expect(safeFileName('why? "this" *thing*')).toBe('why this thing')
    expect(safeFileName('a\u0000b')).toBe('a b')
  })

  it('cannot produce a hidden file or a trailing dot', () => {
    // Windows lets you create "clips." and then cannot open it.
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('clips.')).toBe('clips')
  })

  it('falls back when nothing usable survives', () => {
    expect(safeFileName('')).toBe('clips')
    expect(safeFileName('///')).toBe('clips')
    expect(safeFileName('   ', 'my recording')).toBe('my recording')
  })

  it('caps the length', () => {
    expect(safeFileName('x'.repeat(200)).length).toBe(80)
  })
})

describe('resolvePaths', () => {
  it('keeps unique triggers flat', () => {
    const placed = resolvePaths([
      ['a', 'hello there'],
      ['b', 'general kenobi'],
    ])
    expect(placed.map((p) => p.relativePath)).toEqual([
      'hello there.ogg',
      'general kenobi.ogg',
    ])
    expect(placed.every((p) => p.variation === 0)).toBe(true)
  })

  it('turns duplicates into a variation folder', () => {
    const placed = resolvePaths([
      ['a', 'yes'],
      ['b', 'no'],
      ['c', 'yes'],
    ])
    expect(placed.map((p) => p.relativePath)).toEqual([
      'yes/01.ogg',
      'no.ogg',
      'yes/02.ogg',
    ])
    expect(placed.map((p) => p.variation)).toEqual([1, 0, 2])
  })

  it('zero-pads so alphabetical order is numeric order', () => {
    // The addon orders variations by URL, alphabetically. Unpadded names would
    // give 1, 10, 11, 2, ... and shuffle every :select(n) index.
    const placed = resolvePaths(
      Array.from({ length: 12 }, (_, i) => [String(i), 'same'] as [string, string]),
    )
    const names = placed.map((p) => p.relativePath)
    expect(names[0]).toBe('same/01.ogg')
    expect(names[9]).toBe('same/10.ogg')
    expect([...names].sort()).toEqual(names)
  })

  it('widens padding past ninety-nine', () => {
    const placed = resolvePaths(
      Array.from({ length: 100 }, (_, i) => [String(i), 'many'] as [string, string]),
    )
    const names = placed.map((p) => p.relativePath)
    expect(names[0]).toBe('many/001.ogg')
    expect([...names].sort()).toEqual(names)
  })

  it('preserves input order', () => {
    const placed = resolvePaths([
      ['a', 'x'],
      ['b', 'y'],
      ['c', 'x'],
      ['d', 'z'],
    ])
    expect(placed.map((p) => p.segmentId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles empty input', () => {
    expect(resolvePaths([])).toEqual([])
  })
})

describe('fallbackTrigger', () => {
  it('is stable and already sanitised', () => {
    expect(fallbackTrigger(0)).toBe('line 001')
    expect(fallbackTrigger(41)).toBe('line 042')
    expect(sanitizeTrigger(fallbackTrigger(7))).toBe(fallbackTrigger(7))
  })
})
