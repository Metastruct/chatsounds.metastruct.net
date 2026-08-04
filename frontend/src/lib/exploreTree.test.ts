import { describe, expect, it } from 'vitest'
import {
  NO_REALM,
  REALM_H,
  REALM_PAD,
  ROW_H,
  buildExploreTree,
  countSounds,
  filterExploreTree,
  flattenRows,
} from './exploreTree'
import { soundSharePath, soundStreamPath } from './github'
import { decodeLines, encodeLines } from './soundIndex'

const file = (path: string) => ({ path, sha: `sha-${path}` })

describe('buildExploreTree', () => {
  it('makes a flat file its own trigger', () => {
    const [realm] = buildExploreTree([file('portal/hello.ogg')])
    expect(realm.name).toBe('portal')
    expect(realm.soundCount).toBe(1)
    expect(realm.triggers).toEqual([
      { key: 'hello', sounds: [{ path: 'portal/hello.ogg', sha: 'sha-portal/hello.ogg', name: 'hello' }] },
    ])
  })

  it('groups a variation folder under one trigger', () => {
    const [realm] = buildExploreTree([file('portal/hello/01.ogg'), file('portal/hello/02.ogg')])
    expect(realm.triggers).toHaveLength(1)
    expect(realm.triggers[0].key).toBe('hello')
    expect(realm.triggers[0].sounds.map((s) => s.name)).toEqual(['01', '02'])
  })

  it('merges a flat file with a folder of the same name, as the game does', () => {
    const [realm] = buildExploreTree([file('portal/hello.ogg'), file('portal/hello/02.ogg')])
    expect(realm.triggers).toHaveLength(1)
    expect(realm.triggers[0].sounds).toHaveLength(2)
  })

  it('sorts variations as text, the order the addon plays them', () => {
    const [realm] = buildExploreTree([
      file('portal/hi/2.ogg'),
      file('portal/hi/10.ogg'),
      file('portal/hi/1.ogg'),
    ])
    expect(realm.triggers[0].sounds.map((s) => s.name)).toEqual(['1', '10', '2'])
  })

  it('derives keys the way the addon does', () => {
    const [realm] = buildExploreTree([
      file('portal/my_sound.ogg'),
      file('portal/folder/!bang.ogg'),
      file('portal/a/b/c.ogg'),
    ])
    expect(realm.triggers.map((t) => t.key)).toEqual(['b', 'bang', 'my sound'])
  })

  it('puts realmless files in their own bucket, last', () => {
    const realms = buildExploreTree([file('stray.ogg'), file('portal/hello.ogg')])
    expect(realms.map((r) => r.name)).toEqual(['portal', NO_REALM])
  })

  it('falls back to the filename when nothing normalizes to a key', () => {
    const [realm] = buildExploreTree([file('portal/___.ogg')])
    expect(realm.triggers[0].key).toBe('___')
  })

  it('sorts realms and triggers alphabetically', () => {
    const realms = buildExploreTree([file('zeta/b.ogg'), file('zeta/a.ogg'), file('alpha/c.ogg')])
    expect(realms.map((r) => r.name)).toEqual(['alpha', 'zeta'])
    expect(realms[1].triggers.map((t) => t.key)).toEqual(['a', 'b'])
  })
})

describe('filterExploreTree', () => {
  const tree = buildExploreTree([
    file('portal/hello.ogg'),
    file('portal/go home and die.ogg'),
    file('valorant/sage/01.ogg'),
    file('valorant/sage/02.ogg'),
  ])

  it('returns everything for an empty query', () => {
    expect(filterExploreTree(tree, '   ')).toBe(tree)
  })

  it('keeps a whole realm when its name matches', () => {
    const kept = filterExploreTree(tree, 'portal')
    expect(kept).toHaveLength(1)
    expect(kept[0].triggers).toHaveLength(2)
  })

  it('trims a realm to its matching triggers', () => {
    const kept = filterExploreTree(tree, 'hello')
    expect(kept).toHaveLength(1)
    expect(kept[0].triggers.map((t) => t.key)).toEqual(['hello'])
    expect(kept[0].soundCount).toBe(1)
  })

  it('matches the query as one substring, spaces and all', () => {
    const kept = filterExploreTree(tree, 'Home And')
    expect(kept[0].triggers.map((t) => t.key)).toEqual(['go home and die'])
  })

  it('keeps every variation of a matching trigger', () => {
    const kept = filterExploreTree(tree, 'sage')
    expect(kept[0].triggers[0].sounds).toHaveLength(2)
  })

  it('returns nothing when nothing matches', () => {
    expect(filterExploreTree(tree, 'nothing here')).toEqual([])
  })
})

describe('flattenRows', () => {
  it('gives a lone sound one row and a variation group a header', () => {
    const rows = flattenRows(
      buildExploreTree([
        file('portal/hello.ogg'),
        file('portal/sage/01.ogg'),
        file('portal/sage/02.ogg'),
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual(['realm', 'sound', 'group', 'sound', 'sound'])
    expect(rows[1]).toMatchObject({ label: 'hello', depth: 1 })
    expect(rows[2]).toMatchObject({ label: 'sage', count: 2 })
    expect(rows[3]).toMatchObject({ label: '01', depth: 2 })
  })

  it('pads a realm equally at both ends', () => {
    const rows = flattenRows(buildExploreTree([file('a/x.ogg'), file('a/y.ogg'), file('a/z.ogg')]))
    const [, first, middle, last] = rows
    expect(first).toMatchObject({ pad: { top: true, bottom: false }, height: ROW_H + REALM_PAD })
    expect(middle).toMatchObject({ pad: { top: false, bottom: false }, height: ROW_H })
    expect(last).toMatchObject({ pad: { top: false, bottom: true }, height: ROW_H + REALM_PAD })
  })

  it('gives a realm of one sound both halves of the padding', () => {
    const [, only] = flattenRows(buildExploreTree([file('a/x.ogg')]))
    expect(only).toMatchObject({ pad: { top: true, bottom: true }, height: ROW_H + REALM_PAD * 2 })
  })

  it('opens only the realms named, and closes the rest to one header row', () => {
    const tree = buildExploreTree([file('a/x.ogg'), file('a/y.ogg'), file('b/z.ogg')])
    const rows = flattenRows(tree, new Set(['b']))
    expect(rows.map((row) => row.kind)).toEqual(['realm', 'realm', 'sound'])
    expect(rows[0]).toMatchObject({ name: 'a', collapsed: true, height: REALM_H })
    expect(rows[1]).toMatchObject({ name: 'b', collapsed: false })
  })

  it('closes everything when nothing is named, which is how the tab opens', () => {
    const tree = buildExploreTree([file('a/x.ogg'), file('b/y.ogg')])
    const rows = flattenRows(tree, new Set())
    expect(rows.map((row) => row.kind)).toEqual(['realm', 'realm'])
    expect(rows.every((row) => row.kind === 'realm' && row.collapsed)).toBe(true)
  })

  it('keeps counting a closed realm, so the header still says what is inside', () => {
    const tree = buildExploreTree([file('a/x.ogg'), file('a/y.ogg')])
    const [header] = flattenRows(tree, new Set())
    expect(header).toMatchObject({ soundCount: 2, triggerCount: 2 })
  })

  it('every row states a height, which is what the scroll arithmetic sums', () => {
    const rows = flattenRows(buildExploreTree([file('a/x.ogg'), file('b/y/01.ogg'), file('b/y/02.ogg')]))
    expect(rows.every((row) => row.height > 0)).toBe(true)
  })

  it('keys every row uniquely, so windowing can reuse them', () => {
    const rows = flattenRows(
      buildExploreTree([file('a/x.ogg'), file('b/x.ogg'), file('b/y/01.ogg'), file('b/y/02.ogg')]),
    )
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })
})

describe('countSounds', () => {
  it('totals across realms', () => {
    expect(countSounds(buildExploreTree([file('a/x.ogg'), file('b/y/01.ogg')]))).toBe(2)
  })
})

describe('the share and stream paths', () => {
  it('sit on this origin, under the routes nginx answers', () => {
    expect(soundSharePath('camobunny/hiptofuckbees.ogg')).toBe('/s/camobunny/hiptofuckbees.ogg')
    expect(soundStreamPath('camobunny/hiptofuckbees.ogg')).toBe(
      '/stream/camobunny/hiptofuckbees.ogg',
    )
  })

  it('encodes each segment but keeps the slashes', () => {
    expect(soundSharePath('memes/bees make honey.ogg')).toBe('/s/memes/bees%20make%20honey.ogg')
    expect(soundSharePath('realm/deep/01.ogg')).toBe('/s/realm/deep/01.ogg')
  })

  it('encodes what would otherwise end the path early', () => {
    expect(soundSharePath('realm/a #1 sound.ogg')).toBe('/s/realm/a%20%231%20sound.ogg')
    expect(soundSharePath('realm/q?.ogg')).toBe('/s/realm/q%3F.ogg')
  })
})

describe('the cache encoding', () => {
  it('round-trips paths containing spaces', () => {
    const files = [file('portal/go home and die.ogg'), file('valorant/sage/01.ogg')]
    expect(decodeLines(encodeLines(files))).toEqual(files)
  })

  it('decodes an empty index', () => {
    expect(decodeLines('')).toEqual([])
  })
})
