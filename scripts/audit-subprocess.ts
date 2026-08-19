import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The subprocess audit (006/T057 — FR-100).
 *
 * Ground Control does not shell out. It held a local git reader that ran `git`
 * in a checkout the operator had pointed it at, which is the single largest
 * piece of attack surface a desktop application can hand itself: an argument
 * built from a branch name, a repository path taken from configuration, and a
 * binary resolved off `PATH`. 006 removed that reader, and this exists so it
 * cannot come back by accident — the next feature that wants "just run one
 * command" fails here rather than in review.
 *
 * ## FR-100 says "for any purpose", and this does not
 *
 * Worth being exact about, because the gap is real and reading the requirement
 * literally would make this file a lie. Two child processes remain, and each is
 * excluded here by name rather than by a pattern that happens not to match it.
 *
 * **The launcher spawns the application.** `npx grndctrl` downloads an Electron
 * runtime and runs the app in it; that spawn is the entire product delivery
 * mechanism. It is excluded as a *directory*, not as a call, because everything
 * in it is bootstrap and none of it is the application.
 *
 * **`runtime/handshake.ts` runs `icacls`.** On Windows it is how the handshake
 * file's ACL is restricted to the current user, and the handshake file holds the
 * loopback API's token. There is no Node API for a Windows ACL, so removing this
 * would not remove a subprocess so much as remove the protection on a secret.
 * Both arguments are literals or a path this process wrote itself; neither is
 * provider data.
 *
 * The distinction that matters is not "how many subprocesses" but **whether any
 * of them takes provider or operator input**. Neither of these does, and the
 * reader that did is gone.
 */

/** A module that may run a child process, and the reason it is allowed to. */
export const ALLOWED: Record<string, string> = {
  'packages/core/src/runtime/handshake.ts':
    'icacls, to restrict the handshake file ACL on Windows — arguments are literals and a self-written path',
}

/**
 * Directories excluded wholesale, and why.
 *
 * A directory rather than a file list: `packages/launcher` is a bootstrapper
 * from top to bottom, and enumerating its three spawning modules would mean
 * this audit quietly stopped covering a fourth.
 */
export const EXCLUDED_TREES: Record<string, string> = {
  'packages/launcher':
    'the bootstrapper — downloading a runtime and spawning the app in it is what it is',
}

/**
 * Anything that starts a process.
 *
 * Matched on the *import* as well as the call, because the import is the part
 * that cannot be spelled another way. A call site can be `cp.spawn`, `spawn`,
 * or a destructured alias; there is no reaching any of them without naming
 * `child_process` somewhere first.
 */
const PATTERNS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /['"]node:child_process['"]/, what: "imports node:child_process" },
  { pattern: /['"]child_process['"]/, what: 'imports child_process' },
  { pattern: /\bprocess\s*\.\s*binding\s*\(/, what: 'reaches process.binding' },
]

export interface SubprocessFinding {
  /** Repo-relative, forward slashes. */
  file: string
  what: string
  line: number
}

/** Scan one file's text. Exported so a planted spawn can be tested directly. */
export function findInSource(file: string, source: string): SubprocessFinding[] {
  const findings: SubprocessFinding[] = []

  source.split('\n').forEach((text, index) => {
    // A line that only *talks* about it. Every module here carries a comment
    // explaining why it does not shell out, and an audit that fired on its own
    // documentation would be turned off within a week.
    const trimmed = text.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return

    for (const { pattern, what } of PATTERNS) {
      if (pattern.test(text)) findings.push({ file, what, line: index + 1 })
    }
  })

  return findings
}

/** Every `.ts`/`.js`/`.mjs`/`.cjs` file under a directory, recursively. */
export function sourcesUnder(root: string, dir: string): Map<string, string> {
  const out = new Map<string, string>()

  const walk = (absolute: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(absolute)
    } catch {
      return
    }

    for (const entry of entries) {
      const child = join(absolute, entry)
      if (statSync(child).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'test') continue
        walk(child)
        continue
      }

      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) continue
      out.set(relative(root, child).split(sep).join('/'), readFileSync(child, 'utf8'))
    }
  }

  walk(join(root, dir))
  return out
}

/**
 * The findings that are not accounted for.
 *
 * An allowed file that has *stopped* using a subprocess is reported too, as a
 * stale exemption. An allow-list nobody prunes is how the second exception gets
 * added without discussion.
 */
export function auditSubprocess(sources: Map<string, string>): {
  findings: SubprocessFinding[]
  staleExemptions: string[]
} {
  const all = [...sources]
    .filter(([file]) => !Object.keys(EXCLUDED_TREES).some((tree) => file.startsWith(`${tree}/`)))
    .flatMap(([file, source]) => findInSource(file, source))

  const seen = new Set(all.map((f) => f.file))

  return {
    findings: all.filter((f) => !(f.file in ALLOWED)),
    staleExemptions: Object.keys(ALLOWED).filter((file) => !seen.has(file)),
  }
}
