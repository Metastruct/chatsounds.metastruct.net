import { describe, expect, it } from 'vitest'
import {
  PATH_FLAG_LABEL,
  PATH_FLAG_SEVERITY,
  type PathFlag,
  checkPath,
  describePathFlag,
  unpaddedVariations,
} from './pathcheck'

const at = (rest: string) => `sound/chatsounds/autoadd/${rest}`

describe('checkPath', () => {
  it('accepts the two normal shapes', () => {
    expect(checkPath(at('realm/key.ogg'))).toEqual({
      realm: 'realm',
      key: 'key',
      badChars: [],
      flags: [],
    })
    expect(checkPath(at('realm/key/01.ogg')).flags).toEqual([])
    expect(checkPath(at('realm/key/01.ogg')).key).toBe('key')
  })

  it('folds underscores and hyphens like the addon', () => {
    expect(checkPath(at('let_it_ride/let-it-ride.ogg')).key).toBe('let it ride')
  })

  it('treats three chunks as realm plus variation folder, not nesting', () => {
    // valorant/sage/hello.ogg is a variation of "sage".
    const check = checkPath(at('valorant/sage/hello.ogg'))
    expect(check.key).toBe('sage')
    expect(check.flags).toEqual([])
  })

  it('flags the PR 566 shape, a numbered file directly under the realm', () => {
    const check = checkPath(at('let_it_ride/1.ogg'))
    expect(check.key).toBe('1')
    expect(check.flags).toContain('numeric_key')
    // The same file one level down is what the uploader would have produced.
    expect(checkPath(at('let_it_ride/let it ride/1.ogg')).flags).toEqual([])
  })

  it('flags a numeric variation folder too', () => {
    expect(checkPath(at('realm/12/a.ogg')).flags).toContain('numeric_key')
  })

  it('flags an ogg with no realm at all', () => {
    const check = checkPath(at('oops.ogg'))
    expect(check.realm).toBe('')
    expect(check.flags).toContain('no_realm')
  })

  it('flags uppercase without disturbing the other checks', () => {
    expect(checkPath(at('Realm/Key.ogg')).flags).toEqual(['uppercase'])
    expect(checkPath(at('Realm/1.ogg')).flags).toEqual(['uppercase', 'numeric_key'])
  })

  it('flags reserved names as keys and as folders', () => {
    expect(checkPath(at('realm/sh.ogg')).flags).toContain('reserved')
    expect(checkPath(at('realm/con.ogg')).flags).toContain('reserved')
    expect(checkPath(at('realm/con/1.ogg')).flags).toContain('reserved')
    // "sh" is only special as the derived trigger, not as a folder name.
    expect(checkPath(at('sh/fine.ogg')).flags).toEqual([])
  })

  it('flags punctuation the chat parser cannot produce', () => {
    const check = checkPath(at('realm/what?.ogg'))
    expect(check.flags).toContain('unreachable')
    expect(check.badChars).toEqual(['?'])
    // Apostrophes are stripped from typed chat, so the key never matches.
    expect(checkPath(at("realm/don't.ogg")).flags).toContain('unreachable')
  })

  it('flags names that normalize to nothing', () => {
    expect(checkPath(at('realm/-.ogg')).flags).toContain('empty_key')
    expect(checkPath(at('realm/__.ogg')).flags).toContain('empty_key')
  })

  it('takes the parent folder as key when nested deeper', () => {
    const check = checkPath(at('realm/sub/key/file.ogg'))
    expect(check.key).toBe('key')
    expect(check.flags).toContain('deep_nesting')
    expect(checkPath(at('realm/a/b/key/file.ogg')).key).toBe('key')
  })

  it('lets a ! filename override the folder', () => {
    const check = checkPath(at('valorant/sage/!goodbye old friend.ogg'))
    expect(check.key).toBe('goodbye old friend')
    expect(check.flags).toEqual(['bang_override'])
    // The override wins over the nesting rule, same as in the addon.
    const nested = checkPath(at('realm/sub/key/!solo.ogg'))
    expect(nested.key).toBe('solo')
    expect(nested.flags).not.toContain('deep_nesting')
  })

  it('flags a ! filename with nothing after it', () => {
    const check = checkPath(at('realm/!.ogg'))
    expect(check.flags).toContain('bang_override')
    expect(check.flags).toContain('empty_key')
  })
})

describe('unpaddedVariations', () => {
  it('flags a group whose numbers sort wrong as text', () => {
    const paths = [at('r/k/1.ogg'), at('r/k/2.ogg'), at('r/k/10.ogg')]
    expect(unpaddedVariations(paths)).toEqual(new Set(paths))
  })

  it('accepts zero-padded groups and lone files', () => {
    expect(unpaddedVariations([at('r/k/01.ogg'), at('r/k/02.ogg'), at('r/k/10.ogg')]).size).toBe(0)
    expect(unpaddedVariations([at('r/k/1.ogg')]).size).toBe(0)
  })

  it('ignores non-numeric siblings and other folders', () => {
    const paths = [at('r/k/1.ogg'), at('r/k/take two.ogg'), at('r/other/10.ogg')]
    expect(unpaddedVariations(paths).size).toBe(0)
  })
})

describe('describePathFlag', () => {
  it('has a label, severity and sentence for every flag', () => {
    const check = checkPath(at('realm/1.ogg'))
    for (const flag of Object.keys(PATH_FLAG_LABEL) as PathFlag[]) {
      expect(PATH_FLAG_LABEL[flag]).toBeTruthy()
      expect(PATH_FLAG_SEVERITY[flag]).toBeTruthy()
      expect(describePathFlag(check, flag)).toBeTruthy()
    }
  })
})
