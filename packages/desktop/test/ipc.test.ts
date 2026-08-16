import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkConformance } from '@grndctrl/core'
import { registerIpcAdapter, type IpcAdapter } from '../src/main/ipc.js'
import { channelFor, OPERATION_CHANNEL_PREFIX } from '../src/shared/channels.js'
import { fakeIpc, testServices, trusted, type FakeIpc, type TestServices } from './harness.js'

/**
 * The third adapter, checked the way the other two are: by starting it and
 * asking it what it exposes, not by reading a list someone maintains.
 */

let s: TestServices
let host: FakeIpc
let adapter: IpcAdapter
const dispatched: { operation: string; payload: unknown }[] = []

beforeAll(() => {
  s = testServices()
  host = fakeIpc()

  adapter = registerIpcAdapter({
    host,
    operations: s.operations,
    dispatch: (operation, payload) => {
      dispatched.push({ operation, payload })
      return Promise.resolve({ operation })
    },
    isTrustedSender: trusted,
  })
})

afterAll(() => {
  s.dispose()
})

describe('the IPC surface against the registry (constitution XII)', () => {
  it('exposes every operation the registry says it should, and nothing more', () => {
    expect(checkConformance(s.registry, [adapter])).toEqual([])
  })

  it('is checking something — both sides are non-empty', () => {
    expect(s.registry.names().length).toBeGreaterThan(20)
    expect(adapter.exposedNames().length).toBeGreaterThan(20)
  })

  // The concrete asymmetry XII cares about, from the UI's side. `ui-only`
  // exists so an operator can confirm a dispatched action and an agent cannot;
  // if IPC failed to expose it, the confirmation flow would have no home at all
  // and the feature would quietly not exist.
  it('exposes the ui-only operations, which no agent surface may have', () => {
    for (const name of ['outbox.mintConfirmation', 'outbox.enqueue', 'drift.dismiss']) {
      expect(adapter.exposedNames()).toContain(name)
    }
  })

  it('registers one channel per operation and no others', () => {
    expect(host.channels()).toEqual(s.registry.namesFor('ipc').map(channelFor).sort())
  })
})

describe('the absence of a generic invoke', () => {
  // The property that matters is not "the handler rejects unknown names" — it is
  // that there is no handler to reject anything, because there is no channel
  // carrying a name. This is what makes a lookup bug impossible rather than
  // unlikely.
  it('has no channel that takes an operation name as an argument', () => {
    for (const channel of host.channels()) {
      expect(channel.startsWith(OPERATION_CHANNEL_PREFIX)).toBe(true)
      expect(channel.slice(OPERATION_CHANNEL_PREFIX.length)).not.toBe('')
    }
  })

  it('refuses an operation that does not exist, by having nowhere to send it', async () => {
    await expect(host.invoke(channelFor('outbox.enqueueDirectly'), {})).rejects.toThrow(
      /No handler registered/,
    )
  })
})

describe('what a handler will accept', () => {
  it('runs a valid call and returns the operation result', async () => {
    const result = await host.invoke(channelFor('sync.status'), {})
    expect(result).toEqual({ ok: true, data: { operation: 'sync.status' } })
  })

  // The attack this exists for: provider-supplied content rendered into an
  // iframe, which shares the preload bridge unless something refuses it.
  it('refuses a message from a subframe of our own window', async () => {
    const result = await host.invoke(
      channelFor('sync.status'),
      {},
      { isMainFrame: false, isOwnWindow: true },
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid', message: 'This message did not come from the application window.' },
    })
  })

  it('refuses a message from a webContents that is not one of our windows', async () => {
    const result = await host.invoke(
      channelFor('sync.status'),
      {},
      { isMainFrame: true, isOwnWindow: false },
    )

    expect(result.ok).toBe(false)
  })

  /**
   * The regression this replaced.
   *
   * The check used to compare `senderFrame.url` against the renderer entry
   * point. `senderFrame.url` is not dependably the final URL when the
   * renderer's *first* message arrives, so the app refused its own opening
   * `projects.list` about one launch in two and showed an error where the board
   * should be. Frame identity is a structural fact and is true from the moment
   * the frame exists, so a message arriving before any URL has settled is still
   * recognisable.
   */
  it('accepts the very first message, before any URL has settled', async () => {
    const result = await host.invoke(
      channelFor('sync.status'),
      {},
      { isMainFrame: true, isOwnWindow: true },
    )

    expect(result.ok).toBe(true)
  })

  // Principle II: the renderer is a trust boundary, not a friend. The registry
  // would reject this too — the redundancy is deliberate, and it is what stops a
  // malformed payload crossing a process seam once core moves out of process.
  it('rejects a payload that does not match the operation schema, before dispatching', async () => {
    const before = dispatched.length
    const result = await host.invoke(channelFor('notes.create'), { subjectKey: 42 })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } })
    expect(dispatched.length).toBe(before)
  })

  it('does not echo the rejected value back', async () => {
    const result = await host.invoke(channelFor('notes.create'), { body: 'a token: sk-live-secret' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).not.toContain('sk-live-secret')
  })
})

describe('what a handler will say when something goes wrong', () => {
  it('passes an operation error through with its code intact', async () => {
    const local = fakeIpc()
    const { OperationError } = await import('@grndctrl/core')

    registerIpcAdapter({
      host: local,
      operations: s.operations,
      dispatch: () => Promise.reject(new OperationError('conflict', 'Someone else edited that note.')),
      isTrustedSender: () => true,
    })

    // `conflict` is the code the notes modal branches on. Flattening it to a
    // string would cost the operator the one screen that explains what happened.
    expect(await local.invoke(channelFor('sync.status'), {})).toMatchObject({
      ok: false,
      error: { code: 'conflict', message: 'Someone else edited that note.' },
    })
  })

  it('makes an unexpected throw opaque', async () => {
    const local = fakeIpc()

    registerIpcAdapter({
      host: local,
      operations: s.operations,
      dispatch: () => Promise.reject(new Error('connect ECONNREFUSED https://x?token=sk-live-secret')),
      isTrustedSender: () => true,
    })

    const result = await local.invoke(channelFor('sync.status'), {})
    expect(result).toMatchObject({ ok: false, error: { code: 'provider_unavailable' } })
    if (!result.ok) expect(result.error.message).not.toContain('sk-live-secret')
  })
})

describe('teardown', () => {
  it('removes every channel it registered', () => {
    const local = fakeIpc()
    const built = registerIpcAdapter({
      host: local,
      operations: s.operations,
      dispatch: () => Promise.resolve({}),
      isTrustedSender: () => true,
    })

    expect(local.channels().length).toBeGreaterThan(20)
    built.dispose()
    expect(local.channels()).toEqual([])
  })
})
