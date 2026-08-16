import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  allowedSubcommands,
  assertAllowed,
  forbiddenSubcommands,
  GitCommandRefused,
} from '../../src/providers/git/allowlist.js'

/**
 * Constitution XVI and FR-017, asserted rather than trusted.
 *
 * "Ground Control never fetches" is a claim about the whole codebase. It is
 * only checkable because exactly one module may spawn git and every invocation
 * passes through one allow-list — so the claim reduces to two assertions:
 * the list refuses network and mutating commands, and nothing else shells out
 * to git.
 */

describe('the git allow-list', () => {
  it('permits the read-only commands the provider needs', () => {
    expect(() => assertAllowed(['status', '--porcelain=v2', '--branch'])).not.toThrow()
    expect(() => assertAllowed(['worktree', 'list', '--porcelain'])).not.toThrow()
    expect(() => assertAllowed(['rev-list', '--count', '@{u}..HEAD'])).not.toThrow()
    expect(() => assertAllowed(['remote', 'get-url', 'origin'])).not.toThrow()
    expect(() => assertAllowed(['for-each-ref', '--format=%(refname)', 'refs/heads'])).not.toThrow()
  })

  // The whole point. Each of these would either touch the network or change
  // something the user owns.
  it('refuses every command that touches the network', () => {
    for (const cmd of ['fetch', 'pull', 'push', 'clone']) {
      expect(() => assertAllowed([cmd]), cmd).toThrow(GitCommandRefused)
    }
    expect(() => assertAllowed(['remote', 'update'])).toThrow(GitCommandRefused)
  })

  it('refuses every command that mutates the working tree, index, or refs', () => {
    for (const cmd of [
      'checkout',
      'switch',
      'merge',
      'rebase',
      'reset',
      'commit',
      'add',
      'rm',
      'stash',
      'cherry-pick',
      'revert',
      'apply',
      'gc',
      'prune',
    ]) {
      expect(() => assertAllowed([cmd]), cmd).toThrow(GitCommandRefused)
    }
  })

  it('refuses a worktree subcommand that would create or destroy one', () => {
    expect(() => assertAllowed(['worktree', 'add', '../wt'])).toThrow(GitCommandRefused)
    expect(() => assertAllowed(['worktree', 'remove', '../wt'])).toThrow(GitCommandRefused)
  })

  it('refuses anything not explicitly listed, rather than defaulting to allow', () => {
    expect(() => assertAllowed(['bisect'])).toThrow(/not on the read-only allow-list/)
    expect(() => assertAllowed(['filter-branch'])).toThrow(/not on the read-only allow-list/)
  })

  // A read-only subcommand can be handed a flag that is not. `status` is safe;
  // arguments still have to earn their place.
  it('allow-lists arguments too, not just subcommands', () => {
    expect(() => assertAllowed(['status', '--porcelain=v2'])).not.toThrow()
    expect(() => assertAllowed(['status', '--no-such-flag'])).toThrow(/not permitted for git status/)
  })

  it('refuses an empty invocation', () => {
    expect(() => assertAllowed([])).toThrow(GitCommandRefused)
  })

  it('names the rule in its message, so the next person knows what they hit', () => {
    expect(() => assertAllowed(['fetch'])).toThrow(/never runs a git command that touches the network/)
  })

  it('keeps the two lists disjoint', () => {
    const allowed = new Set(allowedSubcommands())
    expect(forbiddenSubcommands().filter((f) => allowed.has(f))).toEqual([])
  })
})

/**
 * The other half: the allow-list only guarantees anything while it is the sole
 * path to git. A module that calls execFile('git', ...) directly would bypass
 * it entirely and nothing else would notice.
 *
 * The scan looks for *any* process spawn rather than for git specifically — a
 * second spawn site is a second place a command can be constructed, and what
 * makes this rule enforceable is that there is normally exactly one.
 */

/**
 * The one argued exception, and what constrains it.
 *
 * `runtime/handshake.ts` runs `icacls` on Windows to strip inherited ACL
 * entries from the handshake file, which carries a bearer token. Node's `mode`
 * maps only to the read-only attribute on Windows and says nothing about the
 * ACL, so there is no in-process way to express "this account only" — and a
 * token readable by every account the parent directory grants is the situation
 * XI exists to prevent.
 *
 * It earns the exemption because its arguments cannot be influenced: a fixed
 * flag list, a path this module chose, and the current account name from the
 * OS, passed through `execFileSync` as an array so no shell parses any of it.
 * Anything added to this list needs an argument of the same kind.
 */
const SPAWN_EXEMPT = ['runtime/handshake.ts']

describe('nothing else in core spawns a process', () => {
  it('has no process invocation outside the git provider and the argued exception', () => {
    const srcDir = join(import.meta.dirname, '..', '..', 'src')
    const offenders: string[] = []

    for (const file of walk(srcDir)) {
      const relative = file.replace(/\\/g, '/')
      if (relative.includes('/providers/git/')) continue
      if (SPAWN_EXEMPT.some((allowed) => relative.endsWith(allowed))) continue

      const source = readFileSync(file, 'utf8')
      if (/execFile|spawn\s*\(|execSync|child_process/.test(source)) {
        offenders.push(file)
      }
    }

    expect(offenders).toEqual([])
  })

  it('holds the exception to one binary, on one platform, with no shell', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'runtime', 'handshake.ts'),
      'utf8',
    )

    // A second *binary* appearing here, or the platform guard going away, fails
    // this — which is the point of granting the exemption narrowly.
    const spawned = [...source.matchAll(/execFileSync\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(new Set(spawned)).toEqual(new Set(['icacls']))

    // Two call sites, deliberately, and the count is asserted so a third has to
    // be argued for rather than absorbed. The exemption was originally granted
    // for one — the grant. The second is the **readback**: `icacls` exits 0
    // after `/inheritance:r` even when explicit entries survive, so the only way
    // to know the handshake is restricted is to read the ACL and look. A Windows
    // CI runner produced exactly that case, on a test that had passed on the
    // author's machine for weeks. Widening this from one to two buys the
    // difference between "the command succeeded" and "the file is restricted".
    expect(spawned).toHaveLength(2)
    expect(source).toContain("process.platform !== 'win32'")
    expect(source).not.toMatch(/\bexec\(|\bexecSync\(|shell:\s*true/)
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
}
