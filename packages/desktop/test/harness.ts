import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry, type Registry } from '@grndctrl/core'
import { createCoreServices, type CoreServices } from '@grndctrl/core/runtime'
import type { IpcHost, IpcResult, IpcSender, OperationDescriptor } from '../src/main/ipc.js'

/**
 * A real registry, and a fake `ipcMain`.
 *
 * The registry is real for the same reason the MCP harness builds one: the
 * question these tests ask is whether the adapter and the registry agree, and a
 * stubbed registry would only tell us the stub agrees with itself.
 *
 * `ipcMain` is faked because it cannot be otherwise — it exists only inside a
 * running Electron main process, and requiring one would make the conformance
 * gate a thing that runs on a developer's machine rather than in the suite.
 * What is faked is the channel table, which is exactly the part under test:
 * which channels exist, and what happens when one is called.
 */

export interface TestServices {
  dir: string
  services: CoreServices
  registry: Registry
  operations: OperationDescriptor[]
  dispose(): void
}

export function testServices(): TestServices {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-desktop-'))
  const services = createCoreServices({ dir })
  const registry = buildRegistry(services)

  return {
    dir,
    services,
    registry,
    operations: registry.namesFor('ipc').map((name) => {
      const op = registry.get(name)
      if (op === undefined) throw new Error(`Registry lost operation '${name}'.`)
      return { name, input: op.input }
    }),
    dispose() {
      services.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export interface FakeIpc extends IpcHost {
  /** Call a channel the way Electron would, or throw the way Electron would. */
  invoke(channel: string, payload: unknown, sender?: IpcSender): Promise<IpcResult>
  channels(): string[]
}

export function fakeIpc(): FakeIpc {
  const handlers = new Map<string, (sender: IpcSender, payload: unknown) => Promise<IpcResult>>()

  return {
    handle(channel, listener) {
      // Electron throws on a duplicate registration. So does this, because a
      // silent overwrite is how two operations end up sharing a channel.
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
      handlers.set(channel, listener)
    },
    removeHandler: (channel) => void handlers.delete(channel),
    channels: () => [...handlers.keys()].sort(),

    invoke(channel, payload, sender = { isMainFrame: true, isOwnWindow: true }) {
      const handler = handlers.get(channel)
      // The message Electron itself produces. Tests assert on it, because "no
      // handler registered" *is* the security property for anything not exposed.
      if (handler === undefined) {
        return Promise.reject(new Error(`No handler registered for '${channel}'`))
      }
      return handler(sender, payload)
    },
  }
}

/** What `main/index.ts` treats as our own renderer. */
export const trusted = (sender: IpcSender): boolean => sender.isMainFrame && sender.isOwnWindow
