import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkConformance, type AdapterDescriptor } from '../../src/registry/conformance.js'
import { Registry } from '../../src/registry/index.js'
import { envelopeOf } from '../../src/registry/envelope.js'
import { defineOperation } from '../../src/registry/types.js'
import { startLoopbackAdapter } from '../../src/adapters/http.js'
import { tempServices } from '../helpers/services.js'

const noop = async () => ({})

const read = (name: string, exposure: 'all' | 'ui-only' | 'agent-only' = 'all') =>
  defineOperation({
    name,
    input: z.object({}),
    output: z.object({}),
    exposure,
    mutates: false,
    providerDerived: false,
    description: `test operation ${name}`,
    handler: noop,
  })

const stubAdapter = (surface: 'ipc' | 'http' | 'mcp', names: string[]): AdapterDescriptor => ({
  surface,
  exposedNames: () => names,
})

describe('the XII conformance gate', () => {
  // The gate must be green before there is anything to conform to. A gate that
  // only starts working once the thing it guards exists is not a gate — it is a
  // test someone will write later.
  it('passes on an empty registry with no adapters', () => {
    expect(checkConformance(new Registry(), [])).toEqual([])
  })

  it('passes when every adapter exposes every operation it should', () => {
    const registry = new Registry().register(read('work.list')).register(read('notes.list'))
    const names = ['work.list', 'notes.list']

    const violations = checkConformance(registry, [
      stubAdapter('ipc', names),
      stubAdapter('http', names),
      stubAdapter('mcp', names),
    ])

    expect(violations).toEqual([])
  })

  // The failure XII exists to prevent: wired into one surface, forgotten on the
  // other, and nothing complains until an agent acts on a world it cannot see.
  it('fails when an operation is wired into IPC but not MCP', () => {
    const registry = new Registry().register(read('work.list')).register(read('notes.create'))

    const violations = checkConformance(registry, [
      stubAdapter('ipc', ['work.list', 'notes.create']),
      stubAdapter('mcp', ['work.list']),
    ])

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      surface: 'mcp',
      kind: 'missing',
      operation: 'notes.create',
    })
  })

  it('fails when an adapter exposes something the registry does not have', () => {
    const registry = new Registry().register(read('work.list'))

    const violations = checkConformance(registry, [
      stubAdapter('mcp', ['work.list', 'outbox.enqueueDirectly']),
    ])

    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ kind: 'unexpected', operation: 'outbox.enqueueDirectly' })
  })

  // The concrete case this protects: mintConfirmation is ui-only because only a
  // human can confirm a dispatched action (FR-059, XVI). An agent surface
  // exposing it would hand an agent the ability to authorise its own writes.
  it('fails when an agent surface exposes a ui-only operation', () => {
    const registry = new Registry().register(read('outbox.mintConfirmation', 'ui-only'))

    const ok = checkConformance(registry, [stubAdapter('ipc', ['outbox.mintConfirmation'])])
    expect(ok).toEqual([])

    const bad = checkConformance(registry, [stubAdapter('mcp', ['outbox.mintConfirmation'])])
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatchObject({ kind: 'unexpected', operation: 'outbox.mintConfirmation' })
  })

  it('does not require a ui-only operation of the agent surfaces', () => {
    const registry = new Registry().register(read('outbox.mintConfirmation', 'ui-only'))
    expect(checkConformance(registry, [stubAdapter('mcp', []), stubAdapter('http', [])])).toEqual([])
  })

  // The real registry, against a real running adapter. Deliberately not against
  // a declared list of adapters: that version of this test passed through M1 and
  // M2 with both sides empty, which is the shape of a green test that guards
  // nothing. The MCP surface gets the same treatment in its own package.
  it('holds for the real registry and a real adapter', async () => {
    const t = tempServices()
    const server = await startLoopbackAdapter({ registry: t.registry })
    try {
      expect(checkConformance(t.registry, [server])).toEqual([])
      expect(t.registry.names().length).toBeGreaterThan(20)
      expect(server.exposedNames().length).toBeGreaterThan(0)
    } finally {
      await server.close()
      t.dispose()
    }
  })
})

/**
 * What 006 removed, asserted against the real registry.
 *
 * All three of these are **enumerated rather than pattern-matched**, and that is
 * the point rather than a style choice. A regex over the schemas would pass on
 * whatever the pattern failed to anticipate, and the whole risk in a removal is
 * the thing nobody thought to look for. A list is checkable by reading it.
 *
 * Each one was made to fail before it was left passing, by putting the removed
 * thing back:
 *
 * - re-registering `driftOperations` in `build.ts` — the first test fails,
 *   naming all three operations;
 * - restoring `'branch'` to the `links.resolve` target enum — the second fails;
 * - restoring `workspaceKey` to `sessions.start` — the third fails.
 *
 * An absence assertion that has never been seen to fail is not evidence. This is
 * a removal, so every assertion in it passes trivially if the selector is wrong,
 * and a suite full of those is worse than no suite because it reports confidence.
 */
describe('what 006 removed', () => {
  const GONE = ['drift.list', 'drift.dismiss', 'drift.undismiss']

  it('has no drift operation on any surface', () => {
    const t = tempServices()
    try {
      for (const name of GONE) {
        expect(t.registry.names(), `${name} is still registered`).not.toContain(name)
      }

      // The paired presence. Without it, a `names()` that returned an empty
      // array would satisfy every assertion above.
      expect(t.registry.names()).toContain('work.list')
      expect(t.registry.names()).toContain('notes.list')
    } finally {
      t.dispose()
    }
  })

  /**
   * The eight outbox operations are the bystanders of this removal.
   *
   * They were reachable only through a drift finding's confirmation dialog, so
   * the tempting tidy-up is to take them out too. They stay: they are the
   * agent-facing half of a durable store holding the operator's confirmed
   * actions, and gate XVI has no other implementation. This asserts the
   * tidy-up did not happen quietly.
   */
  it('still registers all eight outbox operations, with no producer', () => {
    const t = tempServices()
    try {
      for (const name of [
        'outbox.pending',
        'outbox.list',
        'outbox.claim',
        'outbox.complete',
        'outbox.fail',
        'outbox.cancel',
        'outbox.enqueue',
        'outbox.mintConfirmation',
      ]) {
        expect(t.registry.names(), `${name} was removed`).toContain(name)
      }
    } finally {
      t.dispose()
    }
  })

  it('refuses a removed link target with an error, never a fallback', async () => {
    const t = tempServices()
    const ctx = {
      authorKind: 'user' as const,
      authorId: null,
      surface: 'ipc' as const,
      now: () => new Date(),
    }
    try {
      for (const target of ['pull-request', 'repository', 'branch', 'check']) {
        await expect(
          t.registry.dispatch(
            'links.resolve',
            { subjectKey: 'jira:acme.atlassian.net/MERC-1', target },
            ctx,
          ),
          `links.resolve accepted the removed target '${target}'`,
        ).rejects.toThrow(/Invalid input/)
      }

      // A surviving target reaches the handler rather than the schema. It throws
      // too — nothing is mirrored here — but for a different reason, and that
      // difference is what shows the four above were refused *as targets*.
      await expect(
        t.registry.dispatch(
          'links.resolve',
          { subjectKey: 'jira:acme.atlassian.net/MERC-1', target: 'ticket' },
          ctx,
        ),
      ).rejects.toThrow(/no usable link/i)
    } finally {
      t.dispose()
    }
  })

  it('rejects a session started with a workspace key, rather than ignoring it', async () => {
    const t = tempServices()
    const ctx = {
      authorKind: 'agent' as const,
      authorId: 'a1',
      surface: 'mcp' as const,
      now: () => new Date(),
    }
    try {
      // FR-115. Zod strips what it does not recognise by default, so this only
      // holds because the input is `.strict()` — and an agent that went on
      // sending a checkout every session would otherwise never learn that
      // nothing receives it.
      await expect(
        t.registry.dispatch(
          'sessions.start',
          {
            agentId: 'a1',
            sessionId: 's1',
            heartbeatIntervalSec: 60,
            workspaceKey: 'repo:github.com/acme/web#main',
          },
          ctx,
        ),
      ).rejects.toThrow(/workspaceKey/)

      // The same call without it succeeds, so the rejection is about the field
      // and not about the rest of the input being wrong.
      await expect(
        t.registry.dispatch(
          'sessions.start',
          { agentId: 'a1', sessionId: 's1', heartbeatIntervalSec: 60 },
          ctx,
        ),
      ).resolves.toBeDefined()
    } finally {
      t.dispose()
    }
  })
})

describe('registry invariants', () => {
  it('refuses a duplicate operation name', () => {
    const registry = new Registry().register(read('work.list'))
    expect(() => registry.register(read('work.list'))).toThrow(/already registered/)
  })

  // Constitution XIV as a startup failure. An operation that claims to return
  // provider data but does not return an envelope cannot be registered at all,
  // so "we forgot to include freshness" is impossible rather than unlikely.
  it('refuses provider-derived output that is not an envelope', () => {
    const registry = new Registry()
    expect(() =>
      registry.register(
        defineOperation({
          name: 'work.list',
          input: z.object({}),
          output: z.object({ items: z.array(z.string()) }),
          exposure: 'all',
          mutates: false,
          providerDerived: true,
          description: 'returns provider data without its age',
          handler: async () => ({ items: [] }),
        }),
      ),
    ).toThrow(/must carry its freshness/)
  })

  it('accepts provider-derived output wrapped in an envelope', () => {
    const registry = new Registry()
    expect(() =>
      registry.register(
        defineOperation({
          name: 'work.list',
          input: z.object({}),
          output: envelopeOf(z.array(z.string())),
          exposure: 'all',
          mutates: false,
          providerDerived: true,
          description: 'returns provider data with its age',
          handler: async () => ({ data: [], freshness: {}, partial: false }),
        }),
      ),
    ).not.toThrow()
  })
})
