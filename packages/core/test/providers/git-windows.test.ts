import { describe, expect, it } from 'vitest'
import { canonicalRemote, workspaceKey, worktreeId } from '../../src/domain/keys.js'
import { fakeGitRunner, gitRunner } from '../../src/providers/git/exec.js'
import { localGitProvider, parseStatus, parseWorktrees } from '../../src/providers/git/read.js'

/**
 * Windows paths, end to end (T056 — XVII, FR-087).
 *
 * This is the platform the product is built for and the only one it is
 * developed on, which is exactly why these cases need writing down: a bug that
 * only appears on `C:\Users\Someone\My Projects\…` is invisible to a suite whose
 * fixtures all say `/repo`. Four things break on Windows and nowhere else —
 * CRLF, spaces, non-ASCII, and two checkouts of one repository on two drives —
 * and all four end in the same place: a **different natural key for the same
 * worktree**, which orphans every note attached to it (XIII, SC-007).
 *
 * `BACKSLASH` is built rather than typed. Backslash-heavy string literals are
 * the single most common way a test in this file ends up asserting on something
 * other than what its author read — `'D:\work\repo'` is `D:` + `w` + a carriage
 * return + `epo`, and it looks completely fine on the screen.
 */

const BACKSLASH = String.fromCharCode(92)
const win = (...parts: string[]): string => parts.join(BACKSLASH)

const REPO = win('D:', 'work', 'mercury')
const SPACED = win('C:', 'Users', 'Jon', 'My Projects', 'mercury')
const ACCENTED = win('D:', 'travail', 'répertoire', 'mercure')
const UNC = win('', '', 'nas', 'team', 'mercury')

const porcelain = (path: string, branch: string, eol: string): string =>
  ['worktree ' + path, 'HEAD 1a2b3c', 'branch refs/heads/' + branch, ''].join(eol)

describe('paths that only exist on Windows', () => {
  it('treats one worktree written three ways as one worktree', () => {
    // The three spellings a Windows path arrives in: as the OS reports it, as a
    // config file was typed, and with the trailing separator a shell completion
    // adds. XVII says these are one path; the natural key has to agree, because
    // it is what a note is attached to.
    const canonical = worktreeId(win('D:', 'work', 'mercury'), false)

    expect(worktreeId('d:/work/mercury', false)).toBe(canonical)
    expect(worktreeId('D:/WORK/Mercury/', false)).toBe(canonical)
    expect(worktreeId(win('d:', 'work', 'MERCURY') + '/', false)).toBe(canonical)
  })

  it('keeps two drives apart, and says so out loud', () => {
    // Deliberate, and the opposite of the rule above. A secondary worktree is
    // identified by where it is — that is the only thing distinguishing two
    // worktrees of the same branch — so the drive letter is part of its
    // identity and moving it does orphan its notes.
    expect(worktreeId(win('C:', 'work', 'mercury'), false)).not.toBe(
      worktreeId(win('D:', 'work', 'mercury'), false),
    )

    // The primary worktree is exempt, which is what makes the common case safe:
    // the checkout people actually move is the one whose id does not depend on
    // where it is.
    expect(worktreeId(win('C:', 'work', 'mercury'), true)).toBe(
      worktreeId(win('E:', 'somewhere', 'else'), true),
    )
  })

  it('survives spaces, non-ASCII and UNC shares', () => {
    for (const path of [SPACED, ACCENTED, UNC]) {
      const id = worktreeId(path, false)
      // Readable and separator-free: this is concatenated into a workspace key,
      // and a space or a backslash inside it would make the key ambiguous.
      expect(id).toMatch(/^wt-[0-9a-f]{8}$/)
      expect(worktreeId(path.toUpperCase().replace(/\//g, BACKSLASH), false)).toBe(id)
    }
  })

  it('does not read a drive letter as an SSH host', () => {
    // `D:\mirrors\mercury.git` is a legitimate remote — a clone from a local
    // mirror or a mapped drive. The scp-style pattern `git@host:path` matched
    // it with `D` as the host, and the key came out `d/\mirrors\mercury`. The
    // forward-slash spelling was already excluded; on Windows both are written.
    expect(canonicalRemote(win('D:', 'mirrors', 'mercury.git'))).toBe(
      win('d:', 'mirrors', 'mercury'),
    )
    expect(canonicalRemote('D:/mirrors/mercury.git')).toBe('d:/mirrors/mercury')

    // And the case it must not break while fixing that one.
    expect(canonicalRemote('git@github.com:acme/mercury.git')).toBe('github.com/acme/mercury')
    expect(canonicalRemote('ssh://git@github.com:22/acme/mercury.git')).toBe(
      'github.com/acme/mercury',
    )
  })
})

describe('CRLF', () => {
  it('is stripped by the runner itself, at the process boundary', async () => {
    // Against the *real* `gitRunner`, with only the child process faked. The
    // version of this test that went through `fakeGitRunner` proved nothing
    // about it: the double carries its own copy of `normalize`, so deleting the
    // runner's changed no test result anywhere. Two guards, and neither one
    // provable while the other stood.
    const runner = gitRunner({
      exec: async () => ({
        stdout: 'first\r\nsecond\r\n',
        stderr: 'warning: something\r\n',
      }),
    })

    const result = await runner.run('D:', ['remote', 'get-url', 'origin'])

    expect(result.stdout).toBe('first\nsecond\n')
    expect(result.stderr).toBe('warning: something\n')
  })

  it('is stripped on the failure path too', async () => {
    // Where it matters more, not less: the failure text is what the branches
    // lane shows an operator, and a stray `\r` in the middle of it renders as a
    // truncated line in some terminals and as a glyph in others.
    const runner = gitRunner({
      exec: async () => {
        throw Object.assign(new Error('git failed'), {
          stdout: 'partial\r\n',
          stderr: 'fatal: not a git repository\r\n',
        })
      },
    })

    const result = await runner.run('D:', ['remote', 'get-url', 'origin'])

    expect(result.failed).toBe(true)
    expect(result.stdout).toBe('partial\n')
    expect(result.stderr).toBe('fatal: not a git repository\n')
  })

  it('never reaches a parser', async () => {
    // The parsers assume `\n` — `parseWorktrees` splits on it — so a `\r`
    // surviving the runner would ride into the worktree path, the branch name
    // and the head sha at once: three fields of one natural key, each silently
    // different from the same worktree read on a machine that reported LF.
    const runner = fakeGitRunner({
      'remote get-url origin': { stdout: 'git@github.com:acme/mercury.git\r\n' },
      'worktree list --porcelain': { stdout: porcelain(REPO, 'feature/MERC-1184', '\r\n') },
      status: { stdout: ['# branch.upstream origin/feature/MERC-1184', ''].join('\r\n') },
      'rev-list': { stdout: '2\r\n' },
    })

    const [workspace] = await localGitProvider(runner).readWorkspaces({ repoPath: REPO })

    expect(workspace?.repoPath).toBe(REPO)
    expect(workspace?.branch).toBe('feature/MERC-1184')
    expect(workspace?.headSha).toBe('1a2b3c')
    expect(workspace?.upstreamRef).toBe('origin/feature/MERC-1184')
    expect(workspace?.unpushedCommitCount).toBe(2)
  })

  it('produces the same key CRLF or LF', async () => {
    const read = async (eol: string) => {
      const runner = fakeGitRunner({
        'remote get-url origin': { stdout: 'git@github.com:acme/mercury.git' + eol },
        'worktree list --porcelain': { stdout: porcelain(REPO, 'feature/MERC-1184', eol) },
        status: { stdout: '' },
      })
      const [workspace] = await localGitProvider(runner).readWorkspaces({ repoPath: REPO })
      return workspace?.key
    }

    // The assertion the whole file is really about. Two machines, or one
    // machine before and after a `core.autocrlf` change, must not disagree
    // about which worktree this is.
    expect(await read('\r\n')).toBe(await read('\n'))
    expect(await read('\n')).toBe(workspaceKey('git@github.com:acme/mercury.git', 'feature/MERC-1184', 'main'))
  })
})

describe('worktree output with awkward paths', () => {
  it('keeps a path with spaces whole', () => {
    // `worktree list --porcelain` is space-delimited and the path is the rest
    // of the line, so a naive `split(' ')[1]` would truncate at "My".
    const [wt] = parseWorktrees(porcelain(SPACED, 'main', '\n'))
    expect(wt?.path).toBe(SPACED)
  })

  it('keeps non-ASCII in a path and in a branch name', () => {
    const [wt] = parseWorktrees(porcelain(ACCENTED, 'feature/café-über', '\n'))
    expect(wt?.path).toBe(ACCENTED)
    expect(wt?.branch).toBe('feature/café-über')
  })

  it('keeps a UNC share whole', () => {
    const [wt] = parseWorktrees(porcelain(UNC, 'main', '\n'))
    expect(wt?.path).toBe(UNC)
  })

  it('reads a second worktree on another drive as a second workspace', async () => {
    const secondary = win('E:', 'hotfix', 'mercury')
    const runner = fakeGitRunner({
      'remote get-url origin': { stdout: 'git@github.com:acme/mercury.git' },
      'worktree list --porcelain': {
        stdout: [
          porcelain(REPO, 'main', '\n'),
          porcelain(secondary, 'hotfix/MERC-1200', '\n'),
        ].join(''),
      },
      status: { stdout: '' },
    })

    const workspaces = await localGitProvider(runner).readWorkspaces({ repoPath: REPO })

    // Cross-drive worktrees are the case this repository is actually laid out
    // for — a checkout on the fast drive and a hotfix tree wherever there was
    // room. They are two workspaces, on two branches, with two keys.
    expect(workspaces).toHaveLength(2)
    expect(workspaces[0]?.worktreeId).toBe('main')
    expect(workspaces[1]?.worktreeId).toMatch(/^wt-/)
    expect(workspaces[0]?.key).not.toBe(workspaces[1]?.key)
  })
})

describe('status on a path with a space', () => {
  // Git quotes a path containing a space or a non-ASCII byte in porcelain v2
  // when `core.quotePath` is on, which it is by default — so on Windows this is
  // the normal case rather than the exotic one. Dirtiness is read from the
  // record type at the start of the line, which is what makes the quoting
  // irrelevant; these pin that it stays that way for every record type.
  const line = (record: string) =>
    record + ' "My Projects/caf\\303\\251.ts"'

  it('sees a modified file', () => {
    const status = parseStatus(
      ['# branch.upstream origin/main', line('1 .M N... 100644 100644 100644 aaa bbb'), ''].join(
        '\n',
      ),
    )

    expect(status.dirty).toBe(true)
    expect(status.upstream).toBe('origin/main')
  })

  it('sees an untracked file', () => {
    // The record type that is easiest to leave out, and the one that matters
    // most here: a branch whose only uncommitted work is a new file reads as
    // clean without it, and the branches lane then says there is nothing to
    // lose before a checkout is thrown away.
    expect(parseStatus(line('?')).dirty).toBe(true)
  })

  it('sees an unmerged file', () => {
    expect(parseStatus(line('u UU N...')).dirty).toBe(true)
  })

  it('does not mistake a header for a change', () => {
    // Every header starts with `#`, including `# branch.head 1-fix`, whose
    // value can begin with a digit. Reading the *line* rather than the record
    // type would call a clean tree dirty on any branch named that way.
    const status = parseStatus(
      ['# branch.oid 1a2b3c', '# branch.head 1-hotfix', '# branch.upstream origin/1-hotfix', ''].join(
        '\n',
      ),
    )

    expect(status.dirty).toBe(false)
    expect(status.upstream).toBe('origin/1-hotfix')
  })
})
