import { describe, expect, it } from 'vitest'
import { fakeGitRunner } from '../../src/providers/git/exec.js'
import { localGitProvider, parseStatus, parseWorktrees } from '../../src/providers/git/read.js'

const NOW = new Date('2026-08-14T12:00:00Z')

describe('parsing worktree list', () => {
  it('reads the primary worktree and its branch', () => {
    const out = ['worktree D:/work/mercury', 'HEAD a1b2c3', 'branch refs/heads/main', ''].join('\n')

    expect(parseWorktrees(out)).toEqual([
      { path: 'D:/work/mercury', head: 'a1b2c3', branch: 'main', isPrimary: true, present: true },
    ])
  })

  it('preserves slashes inside a branch name', () => {
    const out = ['worktree D:/work/m', 'HEAD a1', 'branch refs/heads/feature/MERC-1184', ''].join('\n')
    expect(parseWorktrees(out)[0]?.branch).toBe('feature/MERC-1184')
  })

  // A worktree whose directory is gone still appears in the list, marked
  // prunable. That is the "worktree abandoned" state the branch lane renders,
  // so it is carried through rather than filtered out.
  it('marks a prunable worktree as absent rather than dropping it', () => {
    const out = [
      'worktree D:/work/mercury',
      'HEAD a1',
      'branch refs/heads/main',
      '',
      'worktree D:/work/mercury-orbt',
      'HEAD b2',
      'branch refs/heads/orbt-15-ingest',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')

    const parsed = parseWorktrees(out)
    expect(parsed).toHaveLength(2)
    expect(parsed[1]).toMatchObject({ branch: 'orbt-15-ingest', present: false, isPrimary: false })
  })

  it('reports a detached HEAD as having no branch', () => {
    const out = ['worktree D:/work/m', 'HEAD a1b2c3', 'detached', ''].join('\n')
    expect(parseWorktrees(out)[0]?.branch).toBeNull()
  })

  // Constitution XVII. A path with a space is the common case on Windows, and a
  // worktree on another drive is why worktree identity hashes the path rather
  // than assuming a prefix.
  it('handles Windows paths with spaces, non-ASCII, and other drives', () => {
    const out = [
      'worktree C:/Users/jon/My Projects/mercúrio',
      'HEAD a1',
      'branch refs/heads/main',
      '',
      'worktree E:/scratch/wt',
      'HEAD b2',
      'branch refs/heads/spike',
      '',
    ].join('\n')

    const parsed = parseWorktrees(out)
    expect(parsed[0]?.path).toBe('C:/Users/jon/My Projects/mercúrio')
    expect(parsed[1]?.path).toBe('E:/scratch/wt')
  })

  it('returns nothing for empty output rather than throwing', () => {
    expect(parseWorktrees('')).toEqual([])
  })
})

describe('parsing status', () => {
  it('reports a clean tree with an upstream', () => {
    const out = [
      '# branch.oid a1b2c3',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n')

    expect(parseStatus(out)).toEqual({ dirty: false, upstream: 'origin/main' })
  })

  it('detects every kind of uncommitted work', () => {
    const changed = '1 .M N... 100644 100644 100644 a1 a1 src/index.ts'
    const renamed = '2 R. N... 100644 100644 100644 a1 a1 R100 new.ts\told.ts'
    const unmerged = 'u UU N... 100644 100644 100644 100644 a1 a2 a3 conflict.ts'
    const untracked = '? notes.md'

    for (const line of [changed, renamed, unmerged, untracked]) {
      expect(parseStatus(`# branch.head main\n${line}`).dirty, line).toBe(true)
    }
  })

  // v2 rather than v1 precisely for this: the absence of an upstream is how
  // "never pushed" is detected, and v1 gives no reliable way to tell that apart
  // from "up to date".
  it('reports no upstream for a branch that has never been pushed', () => {
    expect(parseStatus('# branch.oid a1\n# branch.head spike').upstream).toBeNull()
  })
})

describe('reading workspaces', () => {
  const runner = () =>
    fakeGitRunner({
      'remote get-url origin': { stdout: 'git@github.com:Acme/Mercury.git\n' },
      'worktree list --porcelain': {
        stdout: ['worktree D:/work/mercury', 'HEAD a1b2c3', 'branch refs/heads/feature/MERC-1184', ''].join(
          '\n',
        ),
      },
      'status --porcelain=v2 --branch': {
        stdout: '# branch.head feature/MERC-1184\n# branch.upstream origin/feature/MERC-1184\n1 .M N... 100644 100644 100644 a1 a1 src/x.ts',
      },
      'rev-list --count @{u}..HEAD': { stdout: '3\n' },
    })

  it('builds a workspace with a canonical key from the remote', async () => {
    const [ws] = await localGitProvider(runner(), () => NOW).readWorkspaces({
      repoPath: 'D:/work/mercury',
    })

    // The SSH remote normalises to the same key an HTTPS checkout would produce,
    // so a note attached from either is visible from both.
    expect(ws?.canonicalRemote).toBe('github.com/acme/mercury')
    expect(ws?.key).toBe('ws:github.com/acme/mercury#feature/MERC-1184@main')
    expect(ws?.hasUncommittedChanges).toBe(true)
    expect(ws?.unpushedCommitCount).toBe(3)
    expect(ws?.upstreamRef).toBe('origin/feature/MERC-1184')
  })

  // Unknown, not zero. The commits exist and have gone nowhere -- reporting 0
  // would say "nothing to push", which is the opposite of the truth.
  it('reports unpushed commits as unknown when there is no upstream', async () => {
    const r = fakeGitRunner({
      'remote get-url origin': { stdout: 'https://github.com/acme/mercury.git' },
      'worktree list --porcelain': {
        stdout: ['worktree D:/work/m', 'HEAD a1', 'branch refs/heads/scratch', ''].join('\n'),
      },
      'status --porcelain=v2 --branch': { stdout: '# branch.head scratch' },
      'rev-list --count @{u}..HEAD': { failed: true, stderr: 'no upstream configured' },
    })

    const [ws] = await localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'D:/work/m' })
    expect(ws?.unpushedCommitCount).toBeNull()
    expect(ws?.upstreamRef).toBeNull()
  })

  it('does not run git status inside a worktree whose directory is gone', async () => {
    const r = fakeGitRunner({
      'remote get-url origin': { stdout: 'https://github.com/acme/mercury' },
      'worktree list --porcelain': {
        stdout: [
          'worktree D:/work/mercury',
          'HEAD a1',
          'branch refs/heads/main',
          '',
          'worktree D:/work/gone',
          'HEAD b2',
          'branch refs/heads/orbt-15',
          'prunable gitdir file points to non-existent location',
          '',
        ].join('\n'),
      },
      'status --porcelain=v2 --branch': { stdout: '# branch.head main' },
      'rev-list --count @{u}..HEAD': { failed: true },
    })

    const workspaces = await localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'D:/work/mercury' })
    const abandoned = workspaces.find((w) => w.branch === 'orbt-15')

    expect(abandoned?.worktreePresent).toBe(false)
    expect(r.calls.filter((c) => c.repoPath === 'D:/work/gone')).toEqual([])
  })

  it('returns nothing rather than throwing when the repo has no origin', async () => {
    // A real checkout with nothing to correlate against a code host. Not a
    // failure, and it must not be reported as one — a red lane on a correctly
    // configured board teaches people to ignore red lanes.
    const r = fakeGitRunner({ 'remote get-url origin': { failed: true, stderr: 'no such remote' } })
    expect(await localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'D:/x' })).toEqual([])
  })

  /**
   * "Nothing there" and "could not look" must not read the same (FR-013).
   *
   * Both of these used to answer with an empty list, because the only question
   * asked was whether `remote get-url origin` succeeded. `syncLocal` then wrote
   * `replaceWorkspaces([])` and recorded a **success**, so an operator whose
   * checkout lived on a drive that was not mounted opened the board to "No open
   * branches" — stated confidently, with a green freshness reading beside it,
   * and their branches deleted from the mirror.
   */
  it('refuses to call an unreachable checkout empty', async () => {
    const r = fakeGitRunner({
      'remote get-url origin': { failed: true, stderr: "cannot change to 'E:/work/m': No such file" },
      'rev-parse --is-inside-work-tree': { failed: true, stderr: 'not a git repository' },
    })

    await expect(
      localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'E:/work/m' }),
    ).rejects.toThrow(/not reachable, or not a git repository/)
  })

  it('refuses to call a directory that is not a repository empty either', async () => {
    const r = fakeGitRunner({
      'remote get-url origin': { failed: true, stderr: 'not a git repository' },
      'rev-parse --is-inside-work-tree': { failed: true, stderr: 'not a git repository' },
    })

    await expect(
      localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'D:/Downloads' }),
    ).rejects.toThrow()
  })

  it('asks about the repository only when the remote lookup failed', async () => {
    // One extra process spawn per checkout per poll, on every healthy machine,
    // would be a real cost for a question whose answer is already known.
    const r = runner()
    await localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'D:/work/mercury' })

    expect(r.calls.filter((c) => c.args[0] === 'rev-parse')).toEqual([])
  })

  // The strongest form of "we never fetch": inspect every command actually run.
  it('runs only read-only, offline commands', async () => {
    const r = runner()
    await localGitProvider(r, () => NOW).readWorkspaces({ repoPath: 'D:/work/mercury' })

    const subcommands = r.calls.map((c) => c.args[0])
    expect(subcommands).not.toContain('fetch')
    expect(subcommands.every((s) => ['remote', 'worktree', 'status', 'rev-list'].includes(s ?? ''))).toBe(
      true,
    )
  })
})
