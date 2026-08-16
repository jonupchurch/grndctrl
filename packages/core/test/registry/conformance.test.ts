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
    const registry = new Registry().register(read('work.list')).register(read('drift.list'))
    const names = ['work.list', 'drift.list']

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
