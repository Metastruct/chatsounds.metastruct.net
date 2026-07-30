import { describe, expect, it } from 'vitest'
import { REALM_ROOT, prSummary, repoPath } from './github'

describe('repoPath', () => {
  it('puts a sound under its realm in autoadd', () => {
    expect(repoPath('portal_turret', 'hello there.ogg')).toBe(
      `${REALM_ROOT}/portal_turret/hello there.ogg`,
    )
  })
})

describe('prSummary', () => {
  it('names the one realm when there is one', () => {
    const { title, body } = prSummary([
      { realm: 'portal_turret', filenames: ['hello.ogg', 'goodbye.ogg'] },
    ])
    expect(title).toBe('Add 2 sounds to portal_turret')
    expect(body).toContain('**portal_turret**')
    expect(body).toContain('- `hello.ogg`')
  })

  it('counts across realms when there are several', () => {
    const { title } = prSummary([
      { realm: 'a', filenames: ['1.ogg'] },
      { realm: 'b', filenames: ['2.ogg', '3.ogg'] },
    ])
    expect(title).toBe('Add 3 sounds to 2 realms')
  })

  it('speaks singular for a single sound', () => {
    expect(prSummary([{ realm: 'a', filenames: ['1.ogg'] }]).title).toBe('Add 1 sound to a')
  })
})
