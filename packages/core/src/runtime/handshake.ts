import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import { appDataDir, handshakePath } from '../store/paths.js'
import { CORE_VERSION } from '../version.js'

/**
 * Re-exported so `@grndctrl/core/handshake` is the whole contract for a process
 * that has nothing else — the MCP server needs to find the file and must not
 * import the core package proper, which would pull `better-sqlite3` into
 * something delivered by `npx`.
 */
export { appDataDir as dataDir, handshakePath }

/**
 * How `grndctrl-mcp` finds the running app.
 *
 * The MCP server is a separate process, started by an agent's client, that has
 * to reach the loopback API in the desktop app. It cannot be told the port —
 * the port is ephemeral — and it must not be told the token by any route an
 * agent could read. So the app writes both to a file only the current user can
 * open, and the MCP server reads it.
 *
 * Two properties this file is responsible for:
 *
 * - **The file is a credential.** It carries a bearer token for an API that can
 *   read the whole board and write the operator's notes. It is created `0600`
 *   on POSIX and has inheritance stripped on Windows, so another account on a
 *   shared machine cannot read it (XI).
 * - **It is deleted when the app stops.** A stale handshake is worse than a
 *   missing one: the MCP server would connect to a port that some other process
 *   now owns, present a token to it, and report a confusing failure instead of
 *   "the app is not running".
 */

export interface Handshake {
  port: number
  token: string
  pid: number
  version: string
}

export interface HandshakeHandle {
  path: string
  handshake: Handshake
  /**
   * Whether the file's permissions could actually be tightened.
   *
   * Reported rather than thrown: on a filesystem that cannot express the
   * restriction the honest answer is to say so, not to refuse to start. The
   * caller decides whether to warn.
   */
  restricted: boolean
  remove(): void
}

export function writeHandshake(dir: string, handshake: Omit<Handshake, 'version'>): HandshakeHandle {
  const path = handshakePath(dir)
  mkdirSync(dirname(path), { recursive: true })

  const full: Handshake = { ...handshake, version: CORE_VERSION }

  // Removed first so the file is always *created* with the restrictive mode
  // rather than created loose and tightened a moment later — that gap is
  // exactly long enough to read a token out of.
  rmSync(path, { force: true })
  writeFileSync(path, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600, flag: 'wx' })

  const restricted = restrictToCurrentUser(path)

  let removed = false
  const remove = (): void => {
    if (removed) return
    removed = true
    rmSync(path, { force: true })
  }

  // `exit` covers a normal shutdown and an uncaught throw. The signals cover a
  // terminal Ctrl-C and a supervisor stopping the app, neither of which fires
  // `exit` on its own.
  process.once('exit', remove)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      remove()
      process.exit(0)
    })
  }

  return { path, handshake: full, restricted, remove }
}

/**
 * Read a handshake, or `null` if there is not a usable one.
 *
 * Every failure is `null` rather than a throw: from the MCP server's point of
 * view "no file", "unreadable file", "file full of nonsense" and "file
 * describing a process that is gone" all mean the same thing — the app is not
 * running in a way it can talk to — and it must report that cleanly rather than
 * crash an agent's client (T114).
 *
 * That last case is why the `pid` is in the file. The app removes the handshake
 * on `exit` and on the two signals it can catch, which covers every ordinary
 * shutdown — but not a force kill, not a power cut, and not a crash. What is
 * left behind then is a file naming a port some *other* process may now own, and
 * an agent that trusts it will present a bearer token to a stranger and report a
 * confusing failure instead of "the app is not running". Checking that the
 * process still exists costs one syscall and closes that entirely.
 */
export function readHandshake(dir: string): Handshake | null {
  let raw: string
  try {
    raw = readFileSync(handshakePath(dir), 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>

  if (
    typeof candidate['port'] !== 'number' ||
    typeof candidate['token'] !== 'string' ||
    typeof candidate['pid'] !== 'number' ||
    typeof candidate['version'] !== 'string'
  ) {
    return null
  }

  if (!isRunning(candidate['pid'])) return null

  return {
    port: candidate['port'],
    token: candidate['token'],
    pid: candidate['pid'],
    version: candidate['version'],
  }
}

/**
 * Whether a process id is still alive.
 *
 * Signal `0` performs the permission and existence checks without delivering
 * anything. `ESRCH` is the answer being looked for — no such process. `EPERM`
 * means it exists and belongs to someone else, which is *not* our app but is
 * also not a stale file this code should quietly discard, so it counts as
 * running and the connection attempt fails honestly a moment later.
 *
 * A recycled pid would pass this. That is a much narrower window than an
 * abandoned file that lives until the next launch, and the bearer token still
 * has to match on the other end.
 */
function isRunning(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false

  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Tighten the file to the current user.
 *
 * On POSIX, `chmod 0600` is the whole story. On Windows it is not: Node's
 * `mode` maps only to the read-only attribute and says nothing about the ACL,
 * so the file inherits whatever the parent directory grants — which normally
 * includes Administrators and SYSTEM. `icacls /inheritance:r` drops the
 * inherited entries and grants the current account alone.
 */
function restrictToCurrentUser(path: string): boolean {
  try {
    chmodSync(path, 0o600)
  } catch {
    return false
  }

  if (process.platform !== 'win32') return true

  try {
    const { username } = userInfo()
    execFileSync(
      'icacls',
      [path, '/inheritance:r', '/grant:r', `${username}:F`],
      { stdio: 'ignore', windowsHide: true },
    )
    return true
  } catch {
    // The app still runs. A handshake readable by an administrator on the
    // operator's own machine is a smaller problem than refusing to start, and
    // the caller is told so it can say something.
    return false
  }
}
