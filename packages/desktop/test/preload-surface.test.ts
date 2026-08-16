import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPERATIONS } from '../src/preload/operations.js'
import { SHELL_CHANNELS } from '../src/shared/channels.js'
import { testServices, type TestServices } from './harness.js'

/**
 * What keeps a hand-written list honest.
 *
 * The preload cannot ask the registry what exists — it runs in a sandboxed
 * renderer with no core, no database and no module resolution to speak of — so
 * its list of operations is a literal. A literal that nobody checks is a comment
 * with syntax highlighting: it goes stale the first time someone adds an
 * operation, and the symptom is a feature that silently does not exist in the
 * UI while working perfectly over MCP.
 *
 * This is the same guarantee `checkConformance` gives the HTTP and MCP adapters,
 * arrived at differently because the preload cannot be started in a test.
 */

let s: TestServices

beforeAll(() => {
  s = testServices()
})

afterAll(() => {
  s.dispose()
})

describe('the enumerated bridge against the registry', () => {
  it('lists exactly the operations the registry exposes to the ipc surface', () => {
    expect([...OPERATIONS].sort()).toEqual(s.registry.namesFor('ipc').sort())
  })

  it('is checking something — the list is not empty', () => {
    expect(OPERATIONS.length).toBeGreaterThan(20)
  })

  it('has no duplicates, which would silently overwrite a method', () => {
    expect(new Set(OPERATIONS).size).toBe(OPERATIONS.length)
  })

  // Every name becomes `bridge.<namespace>.<method>`. A name with no dot, or two,
  // would either collide with a namespace or produce a method nobody can call.
  it('gives every operation exactly one namespace and one method', () => {
    for (const name of OPERATIONS) {
      expect(name.split('.'), name).toHaveLength(2)
    }
  })

  it('does not collide with the two non-operation members of the bridge', () => {
    const namespaces = new Set(OPERATIONS.map((n) => n.split('.')[0]))
    expect(namespaces.has('open')).toBe(false)
    expect(namespaces.has('on')).toBe(false)
  })
})

/**
 * Read as source rather than imported, because importing it would execute
 * `contextBridge.exposeInMainWorld` and that needs an Electron renderer. The
 * absence being asserted is a property of the file, and the file is where it can
 * be asserted.
 */
const PRELOAD = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'preload', 'index.ts'),
  'utf8',
)

describe('what the preload does not expose', () => {
  it('exposes no generic invoke under any of its usual names', () => {
    for (const forbidden of ['invoke:', 'invoke =', 'send:', 'call:', 'dispatch:']) {
      expect(PRELOAD.includes(forbidden), `preload exposes '${forbidden}'`).toBe(false)
    }
  })

  it('never passes a caller-supplied string as a channel', () => {
    // Every `ipcRenderer.invoke` argument must be a bound constant: `channel`
    // from the loop, or one of the shell channels. A parameter name appearing
    // there is the bug this whole file exists to prevent.
    const invocations = [...PRELOAD.matchAll(/ipcRenderer\.(invoke|on|removeListener)\(([^,)]+)/g)]

    expect(invocations.length).toBeGreaterThan(0)
    for (const [, , argument] of invocations) {
      expect(
        ['channel', 'OPEN_CHANNEL', 'CREDENTIAL_CHANNEL'],
        `channel argument was '${argument}'`,
      ).toContain(argument?.trim())
    }
  })

  it('offers no way to read a credential back', () => {
    // The credential channel is write-only by construction. A getter here would
    // put the operator's token back inside a renderer that renders
    // provider-supplied strings, which is the process least entitled to hold it.
    const exposed = PRELOAD.slice(PRELOAD.indexOf('exposeInMainWorld'))
    for (const forbidden of ['getCredential', 'readCredential', 'credentials:']) {
      expect(exposed.includes(forbidden), `bridge exposes '${forbidden}'`).toBe(false)
    }
  })

  it('hands the renderer no Electron object', () => {
    // `ipcRenderer` itself, `process`, and `webFrame` are the three that get
    // exposed by accident when someone wants "just one more thing" across.
    const exposed = PRELOAD.slice(PRELOAD.indexOf('exposeInMainWorld'))
    for (const forbidden of ['ipcRenderer,', 'process', 'webFrame', 'require']) {
      expect(exposed.includes(forbidden), `bridge exposes '${forbidden}'`).toBe(false)
    }
  })

  it('drops the Electron event rather than forwarding it to a listener', () => {
    // The event carries `sender` — a handle to the `webContents`, and through it
    // to every other window in the application.
    expect(PRELOAD).toContain('(_event: unknown, payload: unknown)')
  })
})

describe('the non-operation channels', () => {
  // Neither is an operation, so the conformance gate cannot see either, and
  // pinning the set here is what stops a third, fourth and fifth accumulating —
  // each individually reasonable, and collectively a second service layer.
  //
  // Two, and each is here for its own reason. Opening a browser is a host
  // affordance like the window itself. Storing a credential is the opposite
  // case: it *could* be an operation, and must not be, because the registry is
  // served on the loopback API and MCP as well as IPC — so a secret in it would
  // be kept off those surfaces only by an `exposure` field staying correct
  // forever. A secret that never enters the registry cannot be exposed by
  // getting an exposure wrong.
  it('is exactly two: the launcher and the credential path', () => {
    expect(SHELL_CHANNELS).toEqual(['grndctrl:open', 'grndctrl:credential'])
  })

  it('has no operation that accepts a provider credential', () => {
    // The other half of the same guarantee. The credential channel is only worth
    // having while nothing equivalent exists in the registry, where `ui-only`
    // would be the single thing keeping a secret off the loopback API and MCP.
    //
    // Named fields rather than a substring sweep: `outbox.enqueue` takes a
    // `confirmationToken`, which is a short-lived proof that the operator
    // confirmed an action — the opposite of a credential, and a match for any
    // rule loose enough to say "token".
    const credentialField = /^(secret|password|apiToken|credential|accessToken)$/i

    for (const op of s.registry.all()) {
      const shape = (op.input as { shape?: Record<string, unknown> }).shape ?? {}
      for (const field of Object.keys(shape)) {
        expect(credentialField.test(field), `${op.name} accepts '${field}'`).toBe(false)
      }
    }
  })
})
