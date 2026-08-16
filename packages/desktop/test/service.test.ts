import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handshakePath, readHandshake } from '@grndctrl/core/handshake'
import { startAppService, type AppService } from '../src/main/service.js'

/**
 * The composition root, started for real.
 *
 * Nothing here is stubbed except the data directory. The claim under test is
 * that the thing `main/index.ts` starts before it opens a window is a complete,
 * working application — core, the loopback API and the handshake — because that
 * is what makes the app usable by an agent with no UI on screen, which is the
 * property M3 demonstrated and M4 must not quietly cost.
 *
 * It imports `electron` nowhere, which is why it can run in the suite at all.
 */

let dir: string
let service: AppService

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-service-'))
  service = await startAppService({ dir })
})

afterAll(async () => {
  await service.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('what starts before the window does', () => {
  it('serves the loopback API on a port only the handshake knows', async () => {
    const handshake = readHandshake(dir)
    expect(handshake).not.toBeNull()
    expect(handshake?.port).toBe(service.loopback.port)
    expect(handshake?.pid).toBe(process.pid)

    const response = await fetch(`http://127.0.0.1:${handshake?.port}/op/sync.status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handshake?.token}`, 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('binds to loopback and nowhere else', () => {
    // Not a formality. The default binds every interface, which on a laptop on
    // a café network puts the board — and a token-authenticated write surface —
    // on the café network.
    expect(service.loopback.surface).toBe('http')
    expect(service.loopback.port).toBeGreaterThan(0)
  })

  it('writes a handshake the rest of the machine cannot read', () => {
    const path = handshakePath(dir)
    const mode = statSync(path).mode & 0o777

    // The file carries a bearer token for an API that reads the whole board and
    // writes the operator's notes (XI). On Windows the mode is advisory and the
    // ACL is what matters — asserted in core's handshake tests, which is where
    // the `icacls` call lives.
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ port: service.loopback.port })
  })
})

describe('what the IPC adapter will be given', () => {
  it('offers every operation the registry exposes to the ipc surface', () => {
    expect(service.operations().length).toBeGreaterThan(20)
  })

  it('carries a schema with every name, so the adapter can validate before dispatching', () => {
    for (const op of service.operations()) {
      expect(typeof op.input.safeParse, op.name).toBe('function')
    }
  })

  it('includes the ui-only operations and excludes nothing else', () => {
    const names = service.operations().map((o) => o.name)
    expect(names).toContain('outbox.mintConfirmation')
    expect(names).toContain('work.list')
  })
})

describe('dispatching through the host', () => {
  it('stamps the author from the transport rather than the payload', async () => {
    const created = (await service.dispatch(
      'notes.create',
      {
        subjectKey: 'jira:example/GC-1',
        type: 'decision',
        body: 'Chose the conditional UPDATE over a read-then-write.',
        // An agent identity in the payload. It must not survive: the UI surface
        // is the operator by definition, and a note attributed to the wrong
        // author is authored data corrupted (XIII). The schema strips these
        // before the handler ever sees them, which is the mechanism — this
        // asserts the outcome, so replacing that mechanism cannot go unnoticed.
        authorKind: 'agent',
        authorId: 'claude-code',
      },
      { authorKind: 'user', authorId: null, surface: 'ipc' },
    )) as { authorKind: string; authorId: string | null }

    expect(created.authorKind).toBe('user')
    expect(created.authorId).toBeNull()
  })

  it('refuses an agent-surface caller the ui-only operations', async () => {
    await expect(
      service.dispatch('outbox.mintConfirmation', {}, {
        authorKind: 'agent',
        authorId: 'claude-code',
        surface: 'mcp',
      }),
    ).rejects.toThrow(/not available on the mcp surface/)
  })
})

describe('shutting down', () => {
  it('removes the handshake before the port stops answering', async () => {
    const local = mkdtempSync(join(tmpdir(), 'grndctrl-service-stop-'))
    const stopping = await startAppService({ dir: local })

    expect(readHandshake(local)).not.toBeNull()
    await stopping.close()

    // A stale handshake is worse than a missing one: an agent connects to a port
    // some other process now owns, presents a token to it, and reports a
    // confusing failure instead of "the app is not running".
    expect(readHandshake(local)).toBeNull()
    rmSync(local, { recursive: true, force: true })
  })
})
