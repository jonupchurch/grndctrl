import { describe, expect, it } from 'vitest'
import {
  branchKey,
  canonicalRemote,
  checkKey,
  pullRequestKey,
  repositoryKey,
  sessionKey,
  subjectKindOf,
  ticketKey,
  workspaceKey,
  worktreeId,
} from '../../src/domain/keys.js'

describe('canonicalRemote', () => {
  // The test this module exists for. A note attached while working from an SSH
  // checkout must be visible from an HTTPS one — otherwise the mirror rebuild
  // guarantee in constitution XIII is technically honoured and practically
  // useless, because the note survives attached to a key nothing produces.
  it('collapses every spelling of the same repository to one key', () => {
    const expected = 'github.com/acme/mercury'
    const spellings = [
      'git@github.com:acme/mercury.git',
      'git@github.com:Acme/Mercury.git',
      'https://github.com/acme/mercury',
      'https://github.com/acme/mercury.git',
      'https://github.com/acme/mercury/',
      'https://www.github.com/acme/mercury',
      'https://user:ghp_secret@github.com/acme/mercury.git',
      'ssh://git@github.com/acme/mercury.git',
      'ssh://git@github.com:22/acme/mercury.git',
      'git://github.com/acme/mercury.git',
      '  https://github.com/acme/mercury.git  ',
    ]

    for (const spelling of spellings) {
      expect(canonicalRemote(spelling), spelling).toBe(expected)
    }
  })

  it('keeps genuinely different repositories apart', () => {
    expect(canonicalRemote('git@github.com:acme/mercury.git')).not.toBe(
      canonicalRemote('git@github.com:acme/mercury-ui.git'),
    )
    expect(canonicalRemote('git@github.com:acme/mercury.git')).not.toBe(
      canonicalRemote('git@gitlab.com:acme/mercury.git'),
    )
  })

  it('handles self-hosted hosts, ports, and nested group paths', () => {
    expect(canonicalRemote('https://git.internal.acme.co:8443/platform/team/mercury.git')).toBe(
      'git.internal.acme.co/platform/team/mercury',
    )
    expect(canonicalRemote('git@git.internal.acme.co:platform/team/mercury.git')).toBe(
      'git.internal.acme.co/platform/team/mercury',
    )
  })

  it('does not mistake a path segment ending in digits for a port', () => {
    expect(canonicalRemote('https://github.com/acme/mercury:2')).toBe('github.com/acme/mercury:2')
  })

  // `.git` is stripped as a suffix of the URL, not as a substring.
  it('leaves a repository legitimately named with git in it alone', () => {
    expect(canonicalRemote('https://github.com/acme/gitignore.git')).toBe('github.com/acme/gitignore')
    expect(canonicalRemote('https://github.com/acme/git-tools')).toBe('github.com/acme/git-tools')
  })
})

describe('branchKey', () => {
  it('preserves branch case and slashes — git is case-sensitive here', () => {
    expect(branchKey('git@github.com:acme/mercury.git', 'feature/MERC-1184')).toBe(
      'repo:github.com/acme/mercury#feature/MERC-1184',
    )
    expect(branchKey('https://github.com/acme/mercury', 'Feature/Merc')).not.toBe(
      branchKey('https://github.com/acme/mercury', 'feature/merc'),
    )
  })

  it('produces the same key from an SSH and an HTTPS remote', () => {
    expect(branchKey('git@github.com:Acme/Mercury.git', 'main')).toBe(
      branchKey('https://github.com/acme/mercury', 'main'),
    )
  })
})

describe('worktreeId', () => {
  it('names the primary worktree main, whatever its path', () => {
    expect(worktreeId('D:\\work\\mercury', true)).toBe('main')
    expect(worktreeId(null, true)).toBe('main')
    expect(worktreeId(null, false)).toBe('main')
  })

  it('keeps two worktrees on the same branch distinct', () => {
    expect(worktreeId('D:\\work\\mercury-a', false)).not.toBe(worktreeId('D:\\work\\mercury-b', false))
  })

  // Constitution XVII: a worktree can sit on another drive, and Windows paths
  // are case-insensitive. Neither may orphan the notes attached to it.
  it('is stable across separator and case differences', () => {
    expect(worktreeId('D:\\work\\Mercury\\', false)).toBe(worktreeId('d:/work/mercury', false))
  })
})

describe('key constructors', () => {
  it('normalizes case where the provider is case-insensitive', () => {
    expect(ticketKey('ACME.atlassian.net', 'merc-1184')).toBe('jira:acme.atlassian.net/MERC-1184')
    expect(repositoryKey('Acme', 'Mercury')).toBe('gh:acme/mercury')
    expect(pullRequestKey('Acme', 'Mercury', 451)).toBe('gh:acme/mercury#451')
  })

  it('builds workspace, session, and check keys', () => {
    expect(workspaceKey('git@github.com:acme/mercury.git', 'merc-1184', 'main')).toBe(
      'ws:github.com/acme/mercury#merc-1184@main',
    )
    expect(sessionKey('Claude-Code', '01J8XY')).toBe('session:claude-code/01J8XY')
    expect(checkKey('acme', 'mercury', 'A1B2C3', 'build')).toBe('check:acme/mercury@a1b2c3/build')
  })
})

describe('subjectKindOf', () => {
  it('reads the prefix without parsing the key', () => {
    expect(subjectKindOf(ticketKey('acme.atlassian.net', 'MERC-1'))).toBe('ticket')
    expect(subjectKindOf(repositoryKey('acme', 'mercury'))).toBe('repository')
    expect(subjectKindOf(pullRequestKey('acme', 'mercury', 451))).toBe('pull-request')
    expect(subjectKindOf(branchKey('git@github.com:acme/mercury.git', 'main'))).toBe('branch')
    expect(subjectKindOf(workspaceKey('git@github.com:acme/mercury.git', 'main', 'main'))).toBe(
      'workspace',
    )
    expect(subjectKindOf(sessionKey('claude-code', 'abc'))).toBe('session')
    expect(subjectKindOf(checkKey('acme', 'mercury', 'sha', 'build'))).toBe('check')
    expect(subjectKindOf('nonsense')).toBeNull()
  })
})
