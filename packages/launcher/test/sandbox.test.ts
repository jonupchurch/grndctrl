import { describe, expect, it } from 'vitest'
import {
  helperIsUsable,
  refusal,
  sandboxDecision,
  userNamespacesAvailable,
  type SandboxIo,
} from '../src/sandbox.js'

/**
 * The Linux sandbox decision (T168).
 *
 * Found by the first Linux run of the packaging workflow: `npx grndctrl` could
 * not start at all, because Electron's setuid helper needs root ownership and
 * an npm install has none. Windows and macOS both passed, so nothing short of
 * running it on Linux would have shown it.
 *
 * Every branch is tested here rather than on a runner, because the interesting
 * states — AppArmor restricting user namespaces, a kernel with no such knob —
 * cannot all be produced on one machine.
 */

/** A fake `/proc` and filesystem. Absent paths are absent, not empty. */
function io(files: Record<string, string>, owners: Record<string, { uid: number; mode: number }> = {}): SandboxIo {
  return {
    fileOwner: (path) => owners[path] ?? null,
    readSmallFile: (path) => files[path] ?? null,
  }
}

const HELPER = '/cache/33.4.11-linux-x64/chrome-sandbox'

describe('the setuid helper', () => {
  it('is usable only when root owns it and the setuid bit is set', () => {
    expect(helperIsUsable({ uid: 0, mode: 0o4755 })).toBe(true)
    // Right owner, no setuid bit: Chromium refuses this exactly as hard.
    expect(helperIsUsable({ uid: 0, mode: 0o755 })).toBe(false)
    // Setuid bit, wrong owner: setuid to a non-root user buys nothing.
    expect(helperIsUsable({ uid: 1000, mode: 0o4755 })).toBe(false)
    expect(helperIsUsable(null)).toBe(false)
  })
})

describe('user namespaces', () => {
  it('are available on a kernel that says nothing about them', () => {
    // The common case, and the one a naive check gets wrong: none of the three
    // knobs exists, which is not a denial.
    expect(userNamespacesAvailable(io({}))).toBe(true)
  })

  it('are unavailable when AppArmor restricts them', () => {
    // Ubuntu 24.04 and later, on by default. This is the case that makes the
    // count insufficient on its own -- the count below is healthy and the
    // namespace is still denied.
    expect(
      userNamespacesAvailable(
        io({
          '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
          '/proc/sys/user/max_user_namespaces': '15000\n',
        }),
      ),
    ).toBe(false)
  })

  it('are unavailable when the count is zero', () => {
    expect(userNamespacesAvailable(io({ '/proc/sys/user/max_user_namespaces': '0\n' }))).toBe(false)
  })

  it("are unavailable on Debian's older switch", () => {
    expect(
      userNamespacesAvailable(io({ '/proc/sys/kernel/unprivileged_userns_clone': '0\n' })),
    ).toBe(false)
  })

  it('are available when every knob permits them', () => {
    expect(
      userNamespacesAvailable(
        io({
          '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n',
          '/proc/sys/kernel/unprivileged_userns_clone': '1\n',
          '/proc/sys/user/max_user_namespaces': '15000\n',
        }),
      ),
    ).toBe(true)
  })

  it('treats unparseable contents as no answer rather than as a denial', () => {
    expect(userNamespacesAvailable(io({ '/proc/sys/user/max_user_namespaces': 'nonsense' }))).toBe(true)
  })
})

describe('the launch decision', () => {
  it('adds no flags on Windows or macOS', () => {
    for (const platform of ['win32', 'darwin']) {
      const decision = sandboxDecision(platform, '', io({}))
      expect(decision).toEqual({ kind: 'setuid', args: [], note: null })
    }
  })

  it('uses the setuid helper when it is correctly owned', () => {
    const decision = sandboxDecision('linux', HELPER, io({}, { [HELPER]: { uid: 0, mode: 0o4755 } }))
    expect(decision.kind).toBe('setuid')
    if (decision.kind !== 'refuse') expect(decision.args).toEqual([])
  })

  it('falls back to the namespace sandbox on an npx install, and says so', () => {
    // The shipping case: unpacked by npm as the invoking user.
    const decision = sandboxDecision('linux', HELPER, io({}, { [HELPER]: { uid: 1000, mode: 0o755 } }))

    expect(decision.kind).toBe('namespace')
    if (decision.kind === 'namespace') {
      expect(decision.args).toEqual(['--disable-setuid-sandbox'])
      // Never silent. An operator who is sandboxed differently than they expect
      // should be able to find that out without reading this file.
      expect(decision.note).toContain('user-namespace sandbox')
    }
  })

  it('refuses when neither sandbox is available, and never falls through to --no-sandbox', () => {
    const decision = sandboxDecision(
      'linux',
      HELPER,
      io(
        { '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' },
        { [HELPER]: { uid: 1000, mode: 0o755 } },
      ),
    )

    expect(decision.kind).toBe('refuse')
    if (decision.kind === 'refuse') {
      // The two ways out, both named, both one line to run.
      expect(decision.message).toContain(`sudo chown root:root ${HELPER}`)
      expect(decision.message).toContain('kernel.apparmor_restrict_unprivileged_userns=0')
      expect(decision.message).toContain('will not start itself with the sandbox turned off')
    }
  })

  it('never produces --no-sandbox from any state', () => {
    // The assertion that makes the argument in the module docblock enforceable
    // rather than aspirational: no combination of inputs yields it.
    const states: SandboxIo[] = [
      io({}),
      io({}, { [HELPER]: { uid: 0, mode: 0o4755 } }),
      io({}, { [HELPER]: { uid: 1000, mode: 0o755 } }),
      io({ '/proc/sys/user/max_user_namespaces': '0\n' }, { [HELPER]: { uid: 1000, mode: 0o755 } }),
      io({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' }),
    ]

    for (const state of states) {
      const decision = sandboxDecision('linux', HELPER, state)
      if (decision.kind !== 'refuse') expect(decision.args).not.toContain('--no-sandbox')
    }
  })

  it('names the actual helper path in the refusal', () => {
    // A message telling somebody to chown "the helper" is a message they cannot
    // act on. The path is the whole value of the sentence.
    expect(refusal('/somewhere/specific/chrome-sandbox')).toContain('/somewhere/specific/chrome-sandbox')
  })
})
