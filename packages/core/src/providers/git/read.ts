import { canonicalRemote, workspaceKey, worktreeId } from '../../domain/keys.js'
import type { LocalWorkspace } from '../../domain/types.js'
import type { LocalGitProvider } from '../seam.js'
import type { GitRunner } from './exec.js'

/**
 * Local git state — and only what local git alone knows.
 *
 * Ahead/behind is conspicuously absent. Obtaining it locally requires a fetch,
 * and this application runs no git network operation at all; the numbers come
 * from the code host, which is already being polled (FR-018, research R3).
 */

export function localGitProvider(runner: GitRunner, now: () => Date = () => new Date()): LocalGitProvider {
  return {
    async readWorkspaces({ repoPath }) {
      const remoteResult = await runner.run(repoPath, ['remote', 'get-url', 'origin'])

      /**
       * `git remote get-url origin` fails for three different reasons, and this
       * used to answer all three with an empty list.
       *
       * Two of them are "I could not look": the path is gone — an external
       * drive, a network share, a repository someone moved — or it is not a git
       * checkout at all. The third is "there is nothing to look at": a real
       * repository with no `origin` remote, which this application genuinely
       * has nothing to correlate.
       *
       * Returning `[]` for all three made them indistinguishable, and
       * `syncLocal` then wrote `replaceWorkspaces([])` and recorded a
       * **success** — so an operator whose checkout was on a drive that was not
       * mounted opened the board to "No open branches", stated confidently,
       * with a green freshness reading beside it. That is the exact sentence
       * FR-013 exists to prevent: "nothing" and "could not look" must not read
       * the same.
       *
       * So the failure path asks one more question before answering.
       */
      if (remoteResult.failed) {
        const isRepo = await runner.run(repoPath, ['rev-parse', '--is-inside-work-tree'])
        if (isRepo.failed) {
          throw new Error(
            `Could not read the checkout at ${repoPath} — it is not reachable, or not a git repository.`,
          )
        }
        // A real repository with no origin. Nothing to correlate against a code
        // host, and nothing wrong either.
        return []
      }

      const remote = canonicalRemote(remoteResult.stdout.trim())
      const worktrees = parseWorktrees((await runner.run(repoPath, ['worktree', 'list', '--porcelain'])).stdout)
      const readAt = now().toISOString()

      const workspaces: LocalWorkspace[] = []

      for (const wt of worktrees) {
        // A worktree whose directory has been deleted still appears in the list.
        // That is drift, not an error -- record it rather than skipping it.
        if (wt.branch === null) continue

        const status = wt.present
          ? parseStatus((await runner.run(wt.path, ['status', '--porcelain=v2', '--branch'])).stdout)
          : { dirty: false, upstream: null }

        const unpushed = wt.present && status.upstream !== null ? await countUnpushed(runner, wt.path) : null

        workspaces.push({
          key: workspaceKey(remote, wt.branch, worktreeId(wt.path, wt.isPrimary)),
          repoPath: wt.path,
          canonicalRemote: remote,
          branch: wt.branch,
          worktreeId: worktreeId(wt.path, wt.isPrimary),
          isPrimaryWorktree: wt.isPrimary,
          worktreePresent: wt.present,
          hasUncommittedChanges: status.dirty,
          unpushedCommitCount: unpushed,
          headSha: wt.head,
          upstreamRef: status.upstream,
          readAt,
        })
      }

      return workspaces
    },
  }
}

async function countUnpushed(runner: GitRunner, repoPath: string): Promise<number | null> {
  const result = await runner.run(repoPath, ['rev-list', '--count', '@{u}..HEAD'])
  // A branch with no upstream fails here. That is "never pushed", which is
  // unknown rather than zero -- the commits exist and have gone nowhere.
  if (result.failed) return null

  const n = Number.parseInt(result.stdout.trim(), 10)
  return Number.isNaN(n) ? null : n
}

export interface ParsedWorktree {
  path: string
  head: string
  branch: string | null
  isPrimary: boolean
  present: boolean
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * The first record is the primary worktree. A `prunable` marker means the
 * directory is gone while the administrative entry survives — exactly the
 * "worktree abandoned" state the branch lane renders, so it is carried through
 * rather than filtered out.
 */
export function parseWorktrees(stdout: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = []
  let current: Partial<ParsedWorktree> & { prunable?: boolean } = {}
  let first = true

  const flush = () => {
    if (current.path === undefined) return
    worktrees.push({
      path: current.path,
      head: current.head ?? '',
      branch: current.branch ?? null,
      isPrimary: first,
      present: current.prunable !== true,
    })
    first = false
    current = {}
  }

  for (const line of stdout.split('\n')) {
    if (line === '') {
      flush()
      continue
    }
    const [field, ...rest] = line.split(' ')
    const value = rest.join(' ')

    if (field === 'worktree') {
      flush()
      current.path = value
    } else if (field === 'HEAD') {
      current.head = value
    } else if (field === 'branch') {
      // `refs/heads/feature/MERC-1184` -> `feature/MERC-1184`. Slashes inside
      // the branch name are preserved; only the ref prefix is removed.
      current.branch = value.replace(/^refs\/heads\//, '')
    } else if (field === 'detached') {
      current.branch = null
    } else if (field === 'prunable') {
      current.prunable = true
    }
  }
  flush()

  return worktrees
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * v2 rather than v1 because it reports the upstream explicitly. Its absence is
 * how "never pushed" is detected, and v1 gives no reliable way to tell that
 * apart from "up to date".
 */
export function parseStatus(stdout: string): { dirty: boolean; upstream: string | null } {
  let dirty = false
  let upstream: string | null = null

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim()
      continue
    }
    // 1 = changed, 2 = renamed, u = unmerged, ? = untracked, each in the first
    // column. Any of them means there is work here that is not committed.
    //
    // The anchor is the whole guard, and it used to have a `startsWith('#')`
    // skip in front of it doing the same job for header lines. Two guards, and
    // no realistic porcelain-v2 line separates them — so neither could be shown
    // to fail, and the anchor could have been dropped with every test still
    // green. Headers fall through this test on their own: `#` is not a record
    // type.
    if (/^[12u?]/.test(line)) dirty = true
  }

  return { dirty, upstream }
}
