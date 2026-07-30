import { describe, expect, it } from 'vitest'
import { REALM_ROOT, fileRefFromComment, prSummary, repoPath, statusFrom } from './github'

const review = (reviewer: string, state: string) => ({
  id: 0,
  reviewer,
  state,
  body: '',
  submittedAt: '',
  url: '',
})

describe('fileRefFromComment', () => {
  it('reads back what the fallback wrote', () => {
    expect(fileRefFromComment('`portal_turret/hello there.ogg`: too loud, it clips')).toEqual({
      ref: 'portal_turret/hello there.ogg',
      text: 'too loud, it clips',
    })
  })

  it('keeps the rest of a multi line objection', () => {
    const parsed = fileRefFromComment('`a/b.ogg`: first line\nsecond line')
    expect(parsed?.text).toBe('first line\nsecond line')
  })

  it('ignores ordinary discussion that merely mentions a file', () => {
    // Attributing these to a sound would put words in someone's mouth.
    expect(fileRefFromComment('I think a/b.ogg is fine')).toBeNull()
    expect(fileRefFromComment('have a look at `a/b.ogg` when you get a chance')).toBeNull()
    expect(fileRefFromComment('`a/b.ogg`')).toBeNull()
    expect(fileRefFromComment('thanks!')).toBeNull()
  })

  it('wants an ogg, not any backticked thing', () => {
    expect(fileRefFromComment('`some code`: do this instead')).toBeNull()
  })
})

describe('statusFrom', () => {
  it('is waiting when nobody has ruled', () => {
    expect(statusFrom([])).toBe('waiting')
    // A plain comment is not a verdict.
    expect(statusFrom([review('a', 'COMMENTED')])).toBe('waiting')
  })

  it('reads an approval and a request for changes', () => {
    expect(statusFrom([review('a', 'APPROVED')])).toBe('approved')
    expect(statusFrom([review('a', 'CHANGES_REQUESTED')])).toBe('changes')
  })

  it('takes only the newest verdict from each reviewer', () => {
    // Asked for changes, then satisfied: approved.
    expect(statusFrom([review('a', 'CHANGES_REQUESTED'), review('a', 'APPROVED')])).toBe(
      'approved',
    )
    // And the other way round.
    expect(statusFrom([review('a', 'APPROVED'), review('a', 'CHANGES_REQUESTED')])).toBe('changes')
  })

  it('lets one request for changes outweigh approvals', () => {
    expect(
      statusFrom([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')]),
    ).toBe('changes')
  })

  it('ignores comments between verdicts', () => {
    expect(
      statusFrom([review('a', 'APPROVED'), review('a', 'COMMENTED')]),
    ).toBe('approved')
  })
})

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
