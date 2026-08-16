import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Registry } from '../../src/registry/index.js'
import { conflict, isOperationError } from '../../src/registry/errors.js'
import { defineOperation, type Ctx, type Exposure } from '../../src/registry/types.js'

const ctx = (surface: Ctx['surface'] = 'ipc'): Ctx => ({
  authorKind: surface === 'ipc' ? 'user' : 'agent',
  authorId: surface === 'ipc' ? null : 'claude-code',
  surface,
  now: () => new Date('2026-08-14T12:00:00Z'),
})

const inputSchema = z.object({ body: z.string().min(1) })
const outputSchema = z.object({ id: z.string(), authorKind: z.string() })

type In = z.infer<typeof inputSchema>
type Out = z.infer<typeof outputSchema>

interface Overrides {
  exposure?: Exposure
  handler?: (input: In, ctx: Ctx) => Promise<unknown>
}

function registryWith(overrides: Overrides = {}) {
  const handler =
    overrides.handler ??
    (async (input: In, c: Ctx) => ({ id: `n-${input.body.length}`, authorKind: c.authorKind }))

  return new Registry().register(
    defineOperation<In, Out>({
      name: 'notes.create',
      input: inputSchema,
      output: outputSchema,
      exposure: overrides.exposure ?? 'all',
      mutates: true,
      providerDerived: false,
      description: 'create a note',
      handler: handler as (input: In, ctx: Ctx) => Promise<Out>,
    }),
  )
}

describe('dispatch', () => {
  it('validates input at the boundary and rejects what does not fit', async () => {
    const registry = registryWith()

    await expect(registry.dispatch('notes.create', { body: '' }, ctx())).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(registry.dispatch('notes.create', {}, ctx())).rejects.toMatchObject({
      code: 'invalid',
    })
  })

  // Error strings travel to logs and to agents, and the rejected value is
  // frequently the thing worth protecting -- a pasted token, a note body.
  it('does not echo the offending value in the error message', async () => {
    const registry = registryWith()
    const secret = 'ghp_supersecrettoken'

    await expect(
      registry.dispatch('notes.create', { body: 12345, secret }, ctx()),
    ).rejects.toSatisfy((e: unknown) => isOperationError(e) && !e.message.includes(secret))
  })

  it('rejects an unknown operation rather than failing silently', async () => {
    await expect(registryWith().dispatch('notes.destroy', {}, ctx())).rejects.toMatchObject({
      code: 'invalid',
    })
  })

  // The renderer stamps `user`, the MCP adapter stamps `agent`, and neither
  // reads it from the payload -- an agent must not be able to post as the user.
  it('takes authorKind from the context, never the payload', async () => {
    const registry = registryWith()

    const asUser = (await registry.dispatch(
      'notes.create',
      { body: 'hello', authorKind: 'user' },
      ctx('ipc'),
    )) as { authorKind: string }
    expect(asUser.authorKind).toBe('user')

    const asAgent = (await registry.dispatch(
      'notes.create',
      { body: 'hello', authorKind: 'user' },
      ctx('mcp'),
    )) as { authorKind: string }
    expect(asAgent.authorKind).toBe('agent')
  })

  it('refuses a ui-only operation on an agent surface', async () => {
    const registry = registryWith({ exposure: 'ui-only' })

    await expect(
      registry.dispatch('notes.create', { body: 'x' }, ctx('mcp')),
    ).rejects.toMatchObject({ code: 'invalid' })

    await expect(registry.dispatch('notes.create', { body: 'x' }, ctx('ipc'))).resolves.toBeDefined()
  })

  // The unusual half: output is validated too. It costs a little per call and
  // buys the guarantee that IPC and MCP cannot answer the same question
  // differently, because both go through this schema.
  it('catches a handler returning a shape it did not declare', async () => {
    const registry = registryWith({ handler: async () => ({ id: 42 }) })

    await expect(registry.dispatch('notes.create', { body: 'x' }, ctx())).rejects.toThrow(
      /does not match its declared output schema/,
    )
  })

  it('passes an OperationError through with its code and details intact', async () => {
    const registry = registryWith({
      handler: async () => {
        throw conflict('Note was modified by an agent.', { revision: 7 })
      },
    })

    await expect(registry.dispatch('notes.create', { body: 'x' }, ctx())).rejects.toMatchObject({
      code: 'conflict',
      details: { current: { revision: 7 } },
    })
  })

  // An unexpected throw from a provider client is the thing most likely to be
  // carrying a URL with a token in it, and adapters serve an untrusted renderer
  // and third-party agents.
  it('does not leak an unexpected internal error across the boundary', async () => {
    const registry = registryWith({
      handler: async () => {
        throw new Error('GET https://acme.atlassian.net?token=ghp_leak failed')
      },
    })

    await expect(registry.dispatch('notes.create', { body: 'x' }, ctx())).rejects.toSatisfy(
      (e: unknown) =>
        isOperationError(e) && e.code === 'provider_unavailable' && !e.message.includes('ghp_leak'),
    )
  })
})
