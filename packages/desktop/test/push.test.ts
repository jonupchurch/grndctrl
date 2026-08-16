import { describe, expect, it, vi } from 'vitest'
import { push, type PushTarget } from '../src/main/push.js'
import { PUSH_CHANNELS } from '../src/shared/channels.js'

/**
 * Push events, derived from the dispatch stream rather than announced by hand.
 *
 * The reason that matters is not tidiness. An event a caller has to remember to
 * emit is an event that gets forgotten at exactly one call site, and the symptom
 * is a board that is correct everywhere except after the one action nobody
 * tested. Deriving them means a new outbox operation is announced the day it is
 * registered, by nobody.
 */

function recorder(): PushTarget & { sent: { channel: string; payload: unknown }[] } {
  const sent: { channel: string; payload: unknown }[] = []
  return { sent, send: (channel, payload) => void sent.push({ channel, payload }) }
}

describe('events derived from what actually ran', () => {
  it('brackets a sync with a start and a finish', async () => {
    const target = recorder()
    const events = push({ targets: () => [target] })
    const dispatch = events.observing(() => Promise.resolve({}))

    await dispatch('sync.now', { connectionId: 'github' })

    expect(target.sent).toEqual([
      { channel: PUSH_CHANNELS.syncProgress, payload: { phase: 'started', connectionId: 'github' } },
      {
        channel: PUSH_CHANNELS.syncProgress,
        payload: { phase: 'finished', connectionId: 'github' },
      },
    ])
  })

  it('reports a sync of everything as a null connection rather than omitting it', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    await dispatch('sync.now', {})
    expect(target.sent[0]?.payload).toEqual({ phase: 'started', connectionId: null })
  })

  // A failed sync still ends. Without the finish the header spins forever, which
  // reads as "still working" — the opposite of what happened.
  it('finishes a sync that threw', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() =>
      Promise.reject(new Error('rate limited')),
    )

    await expect(dispatch('sync.now', {})).rejects.toThrow('rate limited')
    expect(target.sent.at(-1)?.payload).toMatchObject({ phase: 'finished' })
  })

  it('announces every outbox operation, without naming them one by one', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    for (const operation of ['outbox.enqueue', 'outbox.claim', 'outbox.complete', 'outbox.cancel']) {
      await dispatch(operation, {})
    }

    expect(target.sent.filter((s) => s.channel === PUSH_CHANNELS.outboxChanged)).toHaveLength(4)
  })

  // A claim that threw may still have moved the row — the conditional UPDATE is
  // the authority, not the return value. The renderer's job is to go and look.
  it('announces an outbox operation that failed', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() =>
      Promise.reject(new Error('conflict')),
    )

    await expect(dispatch('outbox.claim', {})).rejects.toThrow()
    expect(target.sent.map((s) => s.channel)).toEqual([PUSH_CHANNELS.outboxChanged])
  })

  it('says nothing about a plain read', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    await dispatch('work.list', {})
    await dispatch('notes.list', {})

    expect(target.sent).toEqual([])
  })

  it('returns the operation result unchanged', async () => {
    const dispatch = push({ targets: () => [] }).observing(() => Promise.resolve({ items: [1, 2] }))
    expect(await dispatch('work.list', {})).toEqual({ items: [1, 2] })
  })
})

describe('the freshness clock', () => {
  it('ticks so that "4 minutes ago" does not stay "4 minutes ago" (XIV)', () => {
    vi.useFakeTimers()
    try {
      const target = recorder()
      const stop = push({
        targets: () => [target],
        freshnessIntervalMs: 1000,
        now: () => new Date('2026-08-14T12:00:00Z'),
      }).start()

      vi.advanceTimersByTime(3000)
      stop()
      vi.advanceTimersByTime(5000)

      expect(target.sent).toHaveLength(3)
      expect(target.sent[0]).toEqual({
        channel: PUSH_CHANNELS.freshnessTick,
        payload: { at: '2026-08-14T12:00:00.000Z' },
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('running with no window open', () => {
  // The app is legitimately usable with no UI — an agent works the board over
  // MCP whether or not anything is on screen. That is M3's whole demonstration,
  // and it must not become a crash now that a renderer exists to send to.
  it('sends to nobody without complaint', async () => {
    const dispatch = push({ targets: () => [] }).observing(() => Promise.resolve({}))
    await expect(dispatch('outbox.claim', {})).resolves.toEqual({})
  })
})
