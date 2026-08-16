import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitResult, GitRunner } from '../../src/providers/git/exec.js'

/**
 * Recording and replaying local git (T040).
 *
 * The HTTP recorder in `record.ts` cannot help here: local git is a child
 * process, not a fetch, and its output is plain text rather than JSON. The
 * seam is the same shape though — `GitRunner.run(repoPath, args)` — so this
 * wraps it the same way.
 *
 * ## What a recording is worth over the hand-written porcelain
 *
 * `git-windows.test.ts` (T056) already covers CRLF, paths with spaces, and
 * non-ASCII, and it found three real defects. So what is left is narrower and
 * worth naming rather than overselling: **the shapes nobody thought to write
 * down.** Porcelain v2 emits header lines this project has never seen, `?` and
 * `u` records in orders no fixture reproduces, and a `worktree list` on a repo
 * with a detached head or a locked worktree looks nothing like the two-entry
 * example every test uses.
 *
 * ## Scrubbing, and why it is different here
 *
 * A git recording is mostly *paths* — the operator's checkout locations — and
 * remote URLs, which name an employer directly. `scrub` in `record.ts` walks
 * JSON by key and has nothing to grip here, so this replaces at the text level
 * against an explicit list, longest first so a nested path cannot be half
 * replaced by its own parent.
 *
 * Like the HTTP fixtures these are **gitignored**. That is the backstop, not
 * the plan.
 */

export interface GitRecordOptions {
  /** The live runner to record through. */
  runner: GitRunner
  dir: string
  /**
   * Literal strings to replace, and what to replace them with.
   *
   * Ordered longest-first internally: replacing `D:\work` before
   * `D:\work\alpha` would leave `<root>\alpha` for one path and `<root2>` for
   * another, and the two would no longer join.
   */
  replacements?: Readonly<Record<string, string>>
}

/** A filesystem-safe, stable name for one git invocation. */
export function gitFixtureName(args: readonly string[]): string {
  const joined = args.join('-').replace(/[^A-Za-z0-9@{}.=-]+/g, '-')
  return `git-${joined}`.replace(/-+/g, '-').slice(0, 120)
}

export function redact(text: string, replacements: Readonly<Record<string, string>>): string {
  // Longest first. See the note on `replacements` above — this ordering is the
  // difference between a coherent recording and one whose paths disagree.
  const pairs = Object.entries(replacements).sort(([a], [b]) => b.length - a.length)

  let out = text
  for (const [from, to] of pairs) {
    if (from === '') continue
    out = out.split(from).join(to)
    // Windows paths arrive both ways depending on which command printed them:
    // `git` reports forward slashes, the caller passes backslashes.
    const alternate = from.split(String.fromCharCode(92)).join('/')
    if (alternate !== from) out = out.split(alternate).join(to)
  }
  return out
}

/** A `GitRunner` that passes calls through and writes what git said. */
export function recordingGitRunner(options: GitRecordOptions): GitRunner {
  mkdirSync(options.dir, { recursive: true })
  const replacements = options.replacements ?? {}

  return {
    async run(repoPath, args) {
      const result = await options.runner.run(repoPath, args)

      const record = {
        request: { args: [...args] },
        stdout: redact(result.stdout, replacements),
        stderr: redact(result.stderr, replacements),
        failed: result.failed,
      }

      writeFileSync(
        join(options.dir, `${gitFixtureName(args)}.json`),
        JSON.stringify(record, null, 2) + '\n',
        'utf8',
      )

      return result
    },
  }
}

/**
 * A `GitRunner` that answers from a recorded directory.
 *
 * Keyed on the arguments alone, not on the repository path — the path is the
 * thing that was scrubbed, and a replay that had to match it would be a replay
 * that only works on the machine that recorded it.
 */
export function replayGitRunner(dir: string): GitRunner {
  const recorded = new Map<string, GitResult>()

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      request: { args: string[] }
      stdout: string
      stderr: string
      failed: boolean
    }
    recorded.set(parsed.request.args.join(' '), {
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      failed: parsed.failed,
    })
  }

  return {
    async run(_repoPath, args) {
      const hit = recorded.get(args.join(' '))

      if (hit === undefined) {
        // Loudly, for the same reason as the HTTP replayer: answering an empty
        // stdout for an unrecorded command is how a parser test ends up passing
        // against output nobody ever produced.
        throw new Error(
          `No recorded git fixture for '${args.join(' ')}' in ${dir}. ` +
            `Recorded: ${[...recorded.keys()].join(' | ')}`,
        )
      }

      return hit
    },
  }
}
