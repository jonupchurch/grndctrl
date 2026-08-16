import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLoopbackAdapter, type LoopbackServer } from '@grndctrl/core/adapters/http'
import { writeHandshake, type HandshakeHandle } from '@grndctrl/core/handshake'
import { buildRegistry } from '@grndctrl/core'
import type { Registry } from '@grndctrl/core'
import { createCoreServices, type CoreServices } from '@grndctrl/core/runtime'
import { appClient, type AppClient } from '../src/client.js'

/**
 * A real app, a real loopback server, a real handshake file, and the MCP
 * client that has to find its way through all three.
 *
 * Nothing is stubbed. The claims under test — that an agent gets the same
 * capabilities as the UI, that every read carries its freshness — are claims
 * about the path from a tool name to an operation and back, and a double would
 * only test the double.
 *
 * These tests import the core package proper, which the shipped MCP server must
 * never do. `no-core-import.test.ts` asserts that separately, on `src/`.
 */

export interface Harness {
  dir: string
  services: CoreServices
  registry: Registry
  server: LoopbackServer
  handshake: HandshakeHandle
  client: AppClient
  dispose(): Promise<void>
}

export async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-mcp-'))
  const services = createCoreServices({ dir })
  const registry = buildRegistry(services)
  const server = await startLoopbackAdapter({ registry })
  const handshake = writeHandshake(dir, { port: server.port, token: server.token, pid: process.pid })

  return {
    dir,
    services,
    registry,
    server,
    handshake,
    client: appClient({ dir, agentId: 'claude-code' }),
    async dispose() {
      handshake.remove()
      await server.close()
      services.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A directory with no app running in it — the case an agent hits most often. */
export function emptyDir(): { dir: string; client: AppClient; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-mcp-empty-'))
  return {
    dir,
    client: appClient({ dir }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}
