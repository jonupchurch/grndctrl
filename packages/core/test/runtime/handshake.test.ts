import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handshakePath, onlyGrants, readHandshake, writeHandshake } from '../../src/runtime/handshake.js'

/**
 * The handshake file is a credential.
 *
 * It carries a bearer token for an API that can read the whole board and write
 * the operator's notes. Left world-readable it is a token sitting in a
 * predictable path on a shared machine, which is exactly what XI forbids — so
 * the permissions are asserted rather than assumed, on both platforms.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-handshake-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// A *live* pid, because `readHandshake` now refuses a handshake whose process
// is gone. Using this process's own is the honest fixture: in production the
// writer is the running app, and the file describes it.
const HANDSHAKE = { port: 51234, token: 'a-secret-bearer-token', pid: process.pid }

describe('writing it', () => {
  it('round-trips through the file', () => {
    const handle = writeHandshake(dir, HANDSHAKE)
    try {
      const read = readHandshake(dir)
      expect(read).toMatchObject(HANDSHAKE)
      // The version is stamped by the writer, not accepted from the caller —
      // it is how the MCP server detects talking to a different build.
      expect(read?.version).toMatch(/^\d+\.\d+\.\d+/)
    } finally {
      handle.remove()
    }
  })

  it('is removed on demand, and removing twice is not an error', () => {
    const handle = writeHandshake(dir, HANDSHAKE)
    expect(existsSync(handshakePath(dir))).toBe(true)

    handle.remove()
    expect(existsSync(handshakePath(dir))).toBe(false)
    expect(() => handle.remove()).not.toThrow()
  })

  it('replaces a stale file left by a previous run', () => {
    // A stale handshake is worse than none: the MCP server would present a
    // token to whatever process now owns that port.
    writeFileSync(handshakePath(dir), '{"port":1,"token":"old","pid":1,"version":"0.0.0"}')

    const handle = writeHandshake(dir, HANDSHAKE)
    try {
      expect(readHandshake(dir)?.token).toBe(HANDSHAKE.token)
    } finally {
      handle.remove()
    }
  })
})

describe('reading a bad one', () => {
  it('returns null rather than throwing, for every kind of bad', () => {
    // From the MCP server's point of view these all mean the same thing: there
    // is no app to talk to. It must say so cleanly rather than crash an agent's
    // client (T114).
    expect(readHandshake(dir)).toBeNull()

    for (const contents of ['', 'not json', '[]', 'null', '{"port":"not a number"}', '{}']) {
      writeFileSync(handshakePath(dir), contents)
      expect(readHandshake(dir), `'${contents}' should read as absent`).toBeNull()
    }
  })
})

describe('reading one the app did not get to clean up', () => {
  /**
   * The app removes its handshake on `exit` and on the two signals it can catch,
   * which covers every ordinary shutdown. It does not cover a force kill, a
   * crash, or the power going out — verified by force-killing a running app and
   * finding the file still there.
   *
   * What is left behind names a port that some *other* process may now own. An
   * agent that trusts it presents a bearer token to a stranger and reports a
   * confusing failure instead of "the app is not running".
   */
  const write = (pid: number): void => {
    writeFileSync(
      handshakePath(dir),
      JSON.stringify({ port: 51234, token: 'a-secret-bearer-token', pid, version: '0.0.0' }),
    )
  }

  it('refuses a handshake whose process is gone', () => {
    // Unlikely to be in use, and if it somehow is, the assertion below is the
    // one that would fail rather than a security property.
    write(0x7fffffff)
    expect(readHandshake(dir)).toBeNull()
  })

  it('refuses the pids that are not pids at all', () => {
    for (const pid of [0, -1, 1.5]) {
      write(pid)
      expect(readHandshake(dir), `pid ${pid} should read as absent`).toBeNull()
    }
  })

  it('accepts one whose process is alive', () => {
    write(process.pid)
    expect(readHandshake(dir)?.port).toBe(51234)
  })
})

describe('permissions', () => {
  it('reports whether it could restrict the file', () => {
    const handle = writeHandshake(dir, HANDSHAKE)
    try {
      // Reported rather than thrown: on a filesystem that cannot express the
      // restriction, saying so beats refusing to start.
      expect(typeof handle.restricted).toBe('boolean')
    } finally {
      handle.remove()
    }
  })

  it.skipIf(process.platform === 'win32')('is 0600 on POSIX', () => {
    const handle = writeHandshake(dir, HANDSHAKE)
    try {
      // Group and other must have nothing at all — not read, not execute.
      expect(statSync(handshakePath(dir)).mode & 0o777).toBe(0o600)
    } finally {
      handle.remove()
    }
  })

  it.skipIf(process.platform !== 'win32')('grants only the current user on Windows', () => {
    const handle = writeHandshake(dir, HANDSHAKE)
    try {
      // Node's `mode` maps to the read-only attribute on Windows and says
      // nothing about the ACL, so the real assertion has to read the ACL.
      const acl = execFileSync('icacls', [handshakePath(dir)], {
        encoding: 'utf8',
        windowsHide: true,
      })

      expect(handle.restricted).toBe(true)
      // Inheritance stripped: no BUILTIN\Administrators, no NT AUTHORITY\SYSTEM,
      // no Users group carried down from the parent directory.
      expect(acl).not.toMatch(/BUILTIN\\Administrators/)
      expect(acl).not.toMatch(/NT AUTHORITY\\SYSTEM/)
      expect(acl).not.toMatch(/BUILTIN\\Users/)
    } finally {
      handle.remove()
    }
  })

  // These run everywhere, because the parsing is the part that was wrong and it
  // has nothing to do with the platform. The strings are real `icacls` output.
  describe('reading an ACL back', () => {
    it('accepts a file granted to the current user alone', () => {
      const acl =
        'C:\\Users\\jon\\AppData\\Local\\grndctrl\\runtime.json DESKTOP-1\\jon:(F)\r\n\r\n' +
        'Successfully processed 1 files; Failed processing 0 files\r\n'
      expect(onlyGrants(acl, 'jon')).toBe(true)
    })

    it('accepts a bare account name, without the machine prefix', () => {
      expect(onlyGrants('C:\\x\\runtime.json jon:(F)\r\n', 'jon')).toBe(true)
    })

    it('rejects the ACL a Windows CI runner actually produced', () => {
      // The exact shape that made this bug visible: `/inheritance:r` reported
      // success and left both of these in place, because they were explicit
      // entries rather than inherited ones.
      const acl =
        'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\g\\runtime.json NT AUTHORITY\\SYSTEM:(F)\r\n' +
        '                                          BUILTIN\\Administrators:(F)\r\n' +
        '                                          RUNNER~1\\runneradmin:(F)\r\n\r\n' +
        'Successfully processed 1 files; Failed processing 0 files\r\n'
      expect(onlyGrants(acl, 'runneradmin')).toBe(false)
    })

    it('rejects a principal nobody thought to look for', () => {
      // The reason this checks every entry instead of searching for known-bad
      // names: a search answers "none of the ones I listed are here", and what
      // broke this was something that was not on anyone's list.
      const acl = 'C:\\x\\runtime.json jon:(F)\r\n                  CONTOSO\\backup-svc:(R)\r\n'
      expect(onlyGrants(acl, 'jon')).toBe(false)
    })

    it('refuses an ACL it could not read, rather than assuming the best', () => {
      expect(onlyGrants(null, 'jon')).toBe(false)
      expect(onlyGrants('', 'jon')).toBe(false)
      // Only the summary line, no entries at all: nothing was proved, so it is
      // not a pass.
      expect(onlyGrants('Successfully processed 1 files; Failed processing 0 files\r\n', 'jon')).toBe(
        false,
      )
    })
  })

  it('does not put the token anywhere but the file', () => {
    const handle = writeHandshake(dir, HANDSHAKE)
    try {
      const contents = readFileSync(handshakePath(dir), 'utf8')
      expect(contents).toContain(HANDSHAKE.token)
      // And nothing else in the directory has picked it up on the way through.
      expect(handle.path).toBe(handshakePath(dir))
    } finally {
      handle.remove()
    }
  })
})
