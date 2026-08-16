import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { assertAllowed } from './allowlist.js'

const execFileAsync = promisify(execFile)

/**
 * The only place in the codebase that runs git.
 *
 * Windows specifics are not incidental here (constitution XVII):
 *
 *   - Arguments are always an **array**, never interpolated into a shell
 *     string. A repository path with a space is the common case on Windows, and
 *     a shell string turns it into two arguments — or, with the wrong
 *     character, into something worse.
 *   - `-C <path>` rather than changing directory, so concurrent reads of
 *     different checkouts cannot interfere.
 *   - `shell: false`, so no cmd.exe parsing happens at all.
 *   - Output arrives with CRLF, and **this file is the only place that is
 *     dealt with**. `normalize` runs on the way out of `run`, so every parser
 *     downstream may assume `\n` — which they do: `parseWorktrees` splits on
 *     `'\n'` and would otherwise carry a `\r` into a worktree path, a branch
 *     name and a head sha, giving a different natural key for the same
 *     worktree and orphaning every note on it. Fixing it in the parsers as
 *     well would be a second guard that hides the first when either is removed.
 */

export interface GitRunner {
  run(repoPath: string, args: readonly string[]): Promise<GitResult>
}

export interface GitResult {
  stdout: string
  stderr: string
  /** `true` when git exited non-zero. Not every non-zero exit is an error. */
  failed: boolean
}

export interface GitRunnerOptions {
  /** Path to the git binary. The user's own git, not a bundled one. */
  gitPath?: string
  timeoutMs?: number
  maxBufferBytes?: number
  /**
   * How a child process is actually run. Production uses `execFile`.
   *
   * Injected only so the CRLF contract below can be tested against the *real*
   * runner rather than against the test double's copy of it. That distinction
   * is not academic: with `normalize` written out twice — once here and once in
   * `fakeGitRunner` — deleting this one broke nothing that any test could see,
   * because every test went through the other.
   */
  exec?: (
    file: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>
}

export function gitRunner(options: GitRunnerOptions = {}): GitRunner {
  const gitPath = options.gitPath ?? 'git'
  const timeout = options.timeoutMs ?? 15_000
  // A large monorepo's porcelain output can be megabytes; the default 1MB
  // truncates it and the parse then silently reports a clean tree.
  const maxBuffer = options.maxBufferBytes ?? 32 * 1024 * 1024
  const exec = options.exec ?? execFileAsync

  return {
    async run(repoPath, args) {
      assertAllowed(args)

      try {
        const { stdout, stderr } = await exec(gitPath, ['-C', repoPath, ...args], {
          timeout,
          maxBuffer,
          windowsHide: true,
          shell: false,
          encoding: 'utf8',
          // Force stable, parseable output regardless of the user's config.
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: '0', // never take an index lock -- read-only means read-only
            GIT_TERMINAL_PROMPT: '0', // never block waiting for credentials
            LC_ALL: 'C',
          },
        })
        return { stdout: normalize(stdout), stderr: normalize(stderr), failed: false }
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string }
        return {
          stdout: normalize(err.stdout ?? ''),
          stderr: normalize(err.stderr ?? err.message ?? ''),
          failed: true,
        }
      }
    },
  }
}

/** CRLF from git on Windows, and a trailing newline that would become an empty field. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '')
}

/**
 * In-memory runner for tests: canned output per command, and a call log.
 *
 * It runs the same `normalize` the real one does. Without that, a test could
 * feed CRLF and watch it reach a parser — which production never does — so the
 * double would be asserting a contract the runner does not have, and a test
 * written to it would demand tolerance in the wrong place.
 */
export function fakeGitRunner(
  responses: Readonly<Record<string, Partial<GitResult>>>,
): GitRunner & { calls: { repoPath: string; args: string[] }[] } {
  const calls: { repoPath: string; args: string[] }[] = []

  return {
    calls,
    async run(repoPath, args) {
      // The allow-list applies to the double as well, so a test cannot exercise
      // a command the real runner would refuse.
      assertAllowed(args)
      calls.push({ repoPath, args: [...args] })

      const key = args.join(' ')
      const match = responses[key] ?? responses[args[0] ?? ''] ?? {}
      return {
        stdout: normalize(match.stdout ?? ''),
        stderr: normalize(match.stderr ?? ''),
        failed: match.failed ?? false,
      }
    },
  }
}
