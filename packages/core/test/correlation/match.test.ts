import { describe, expect, it } from 'vitest'
import {
  compileKeyPattern,
  defaultKeyPattern,
  matchBranch,
  matchPullRequest,
} from '../../src/correlation/match.js'
import { project } from './builders.js'

const MERC = project()
const ATLS = project({
  id: 'p-atls',
  code: 'ATLS',
  jiraProjectKey: 'ATLS',
  ticketKeyPattern: '(ATLS-\\d+)',
  repoOwner: 'acme',
  repoName: 'atlas',
})

describe('matching a branch', () => {
  it('finds the key wherever it sits in the name', () => {
    for (const name of ['MERC-1184', 'feature/MERC-1184', 'feature/MERC-1184-worktrees', 'fix_MERC-1184']) {
      expect(matchBranch(name, [MERC]).match?.issueKey, name).toBe('MERC-1184')
    }
  })

  it('is case-insensitive on the key but normalises it', () => {
    expect(matchBranch('feature/merc-1184', [MERC]).match?.issueKey).toBe('MERC-1184')
  })

  it('finds nothing in a branch with no key', () => {
    expect(matchBranch('spike/try-something', [MERC]).match).toBeNull()
  })

  it('does not match another project’s key', () => {
    expect(matchBranch('feature/ATLS-402', [MERC]).match).toBeNull()
  })

  // Two projects bound to the same repo, both patterns matching. Attributing
  // silently would put the work in a lane the user is not looking at.
  it('reports ambiguity when two projects both claim a branch', () => {
    const loose = project({ id: 'p-loose', code: 'AAAA', ticketKeyPattern: '([A-Z]+-\\d+)' })
    const result = matchBranch('feature/MERC-1184', [MERC, loose])

    expect(result.ambiguous).toBe(true)
    expect(result.match).not.toBeNull()
  })

  it('resolves an ambiguous match the same way every run', () => {
    const loose = project({ id: 'p-loose', code: 'AAAA', ticketKeyPattern: '([A-Z]+-\\d+)' })
    const forward = matchBranch('feature/MERC-1184', [MERC, loose]).match
    const reversed = matchBranch('feature/MERC-1184', [loose, MERC]).match

    expect(forward?.projectId).toBe(reversed?.projectId)
  })
})

describe('matching a pull request', () => {
  const pr = (over: Partial<{ headBranch: string; title: string; body: string }> = {}) => ({
    headBranch: 'feature/MERC-1184',
    title: 'fix: reconcile worktrees',
    body: '',
    ...over,
  })

  // FR-021's precedence. A branch name is chosen once and deliberately; a title
  // is edited; a body can quote half a dozen tickets in a checklist.
  it('prefers the branch over the title', () => {
    const result = matchPullRequest(
      pr({ headBranch: 'feature/MERC-1184', title: 'part of ATLS-402' }),
      [MERC, ATLS],
    )

    expect(result.match?.issueKey).toBe('MERC-1184')
    expect(result.match?.source).toBe('branch')
  })

  it('falls back to the title when the branch has no key', () => {
    const result = matchPullRequest(pr({ headBranch: 'spike/x', title: 'fixes MERC-1184' }), [MERC])

    expect(result.match?.issueKey).toBe('MERC-1184')
    expect(result.match?.source).toBe('pr-title')
  })

  it('falls back to the body last', () => {
    const result = matchPullRequest(
      pr({ headBranch: 'spike/x', title: 'cleanup', body: 'closes MERC-1184' }),
      [MERC],
    )

    expect(result.match?.issueKey).toBe('MERC-1184')
    expect(result.match?.source).toBe('pr-body')
  })

  // The reason precedence exists at all: a body full of links must not win.
  it('does not let a checklist in the body override the branch', () => {
    const result = matchPullRequest(
      pr({
        headBranch: 'feature/MERC-1184',
        title: 'cleanup',
        body: '- [ ] MERC-9000\n- [ ] MERC-9001\n- [ ] MERC-9002',
      }),
      [MERC],
    )

    expect(result.match?.issueKey).toBe('MERC-1184')
  })

  it('finds nothing when no field carries a key', () => {
    expect(matchPullRequest(pr({ headBranch: 'spike/x', title: 'cleanup' }), [MERC]).match).toBeNull()
  })
})

describe('key patterns', () => {
  it('builds a default from the bound project key', () => {
    expect(defaultKeyPattern('MERC')).toBe('(MERC-\\d+)')
    expect(matchBranch('feature/MERC-1', [project({ ticketKeyPattern: defaultKeyPattern('MERC') })]).match)
      .not.toBeNull()
  })

  it('escapes a project key containing regex characters', () => {
    const pattern = defaultKeyPattern('A.B')
    expect(matchBranch('feature/A.B-1', [project({ ticketKeyPattern: pattern })]).match?.issueKey).toBe(
      'A.B-1',
    )
    // Would match if the dot were left as a wildcard.
    expect(matchBranch('feature/AXB-1', [project({ ticketKeyPattern: pattern })]).match).toBeNull()
  })

  // A malformed pattern is a configuration error, not a crash. One bad project
  // must not take the whole correlation pass down with it.
  it('yields a matcher that matches nothing for an uncompilable pattern', () => {
    const broken = project({ ticketKeyPattern: '([unclosed' })
    expect(compileKeyPattern(broken)).toBeNull()
    expect(matchBranch('feature/MERC-1184', [broken]).match).toBeNull()
  })

  it('keeps working for other projects when one pattern is broken', () => {
    const broken = project({ id: 'p-broken', code: 'AAAA', ticketKeyPattern: '([unclosed' })
    expect(matchBranch('feature/MERC-1184', [broken, MERC]).match?.issueKey).toBe('MERC-1184')
  })
})
