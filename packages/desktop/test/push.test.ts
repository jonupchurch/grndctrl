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
    /*
     * The **wired** predicate, not the default.
     *
     * This used to pass with the default "everything mutates", because
     * `notes.list` matched no prefix in `afterDispatch` and so was silent by
     * accident rather than by rule. Adding the notes event made that accident
     * visible, which is the right way round: `mutates` is the mechanism that
     * keeps a read quiet, and a test of that mechanism has to supply it. The
     * real caller reads it off the registry (`main/index.ts`).
     */
    const dispatch = push({
      targets: () => [target],
      mutates: (operation) => !operation.endsWith('.list'),
    }).observing(() => Promise.resolve({}))

    await dispatch('work.list', {})
    await dispatch('notes.list', {})

    expect(target.sent).toEqual([])
  })

  it('returns the operation result unchanged', async () => {
    const dispatch = push({ targets: () => [] }).observing(() => Promise.resolve({ items: [1, 2] }))
    expect(await dispatch('work.list', {})).toEqual({ items: [1, 2] })
  })

  it('announces every session operation', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    for (const operation of ['sessions.start', 'sessions.activity', 'sessions.end']) {
      await dispatch(operation, {})
    }

    expect(target.sent.filter((s) => s.channel === PUSH_CHANNELS.sessionsChanged)).toHaveLength(3)
  })

  /*
   * The event that did not exist until 007, and the reason it does now.
   *
   * A note used to change one thing on an open board — a badge count — and a
   * badge a few minutes stale is indistinguishable from a correct one. FR-135
   * puts an agent's unanswered question in a panel, and a question that appears
   * whenever the next poll happens to finish is not a question the operator was
   * asked. Found by an end-to-end test that posted one and waited.
   */
  it('announces a note being written, so a question reaches an open board', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    for (const operation of ['notes.create', 'notes.update', 'notes.delete']) {
      await dispatch(operation, {})
    }

    expect(target.sent.filter((s) => s.channel === PUSH_CHANNELS.notesChanged)).toHaveLength(3)
  })

  it('announces the active ticket being set or cleared', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    for (const operation of ['focus.set', 'focus.clear']) {
      await dispatch(operation, {})
    }

    expect(target.sent.map((s) => s.channel)).toEqual([
      PUSH_CHANNELS.focusChanged,
      PUSH_CHANNELS.focusChanged,
    ])
  })

  /*
   * The loop this one would make is shorter than the outbox's.
   *
   * The panel answers a `focus:changed` by calling `focus.get`. If reads were
   * announced, that call would announce, the panel would refetch, and the cycle
   * would be one event long rather than the several the session push managed
   * before anyone noticed. `mutates` is what stops it, and it is defaulted to
   * "everything mutates" — so this asserts the *wired* predicate, the one
   * `main/index.ts` supplies from the registry.
   */
  it('says nothing when the active ticket is merely read', async () => {
    const target = recorder()
    const dispatch = push({
      targets: () => [target],
      mutates: (operation) => operation !== 'focus.get',
    }).observing(() => Promise.resolve(null))

    await dispatch('focus.get', {})

    expect(target.sent).toEqual([])
  })

  // A heartbeat is explicitly *not* activity — the service is careful about that
  // — but it does move `sinceHeartbeatSec`, which is what turns a running
  // session amber. A liveness display that only updates when the agent does real
  // work is unable to show an agent that has stopped doing any.
  it('announces a heartbeat, which is not activity but does change the display', async () => {
    const target = recorder()
    const dispatch = push({ targets: () => [target] }).observing(() => Promise.resolve({}))

    await dispatch('sessions.heartbeat', {})

    expect(target.sent.map((s) => s.channel)).toEqual([PUSH_CHANNELS.sessionsChanged])
  })
})

/**
 * The half that was missing for the entire life of the feature.
 *
 * `main/index.ts` wraps the dispatch it gives the IPC adapter, so every event
 * above fired for what the *window* did. The loopback adapter that agents use
 * dispatches straight through the registry and was never wrapped, so nothing an
 * *agent* did reached the renderer — `outbox:changed` documented itself as
 * firing "by this window or by an agent over MCP" and did not.
 *
 * Both halves were individually correct, which is why nothing failed. Catching
 * it needed an agent, an open window, and someone watching both.
 */
describe('the mapping both surfaces share', () => {
  it('is the same for an agent as for the window', () => {
    const target = recorder()
    const events = push({ targets: () => [target] })

    events.afterDispatch('sessions.start')
    events.afterDispatch('outbox.claim')
    events.afterDispatch('work.list')

    expect(target.sent.map((s) => s.channel)).toEqual([
      PUSH_CHANNELS.sessionsChanged,
      PUSH_CHANNELS.outboxChanged,
    ])
  })

  // The bug this file's `mutates` predicate exists to prevent, and it is a loop
  // rather than a waste. `sessions.list` shares the `sessions.` prefix, the
  // renderer answers an announcement by refetching, and the refetch *is* a
  // `sessions.list`. The first version of the session push matched on prefix
  // alone and produced hundreds of broadcasts from one agent call — found by
  // running it, because every unit test still passed.
  it('does not announce a read that shares a prefix with a write', () => {
    const target = recorder()
    const writes = new Set(['sessions.start', 'sessions.end', 'outbox.claim'])
    const events = push({
      targets: () => [target],
      mutates: (operation) => writes.has(operation),
    })

    events.afterDispatch('sessions.list')
    events.afterDispatch('outbox.list')
    events.afterDispatch('outbox.pending')

    expect(target.sent).toEqual([])

    // ...and the writes beside them still do announce, so this is a filter and
    // not an off switch.
    events.afterDispatch('sessions.start')
    expect(target.sent.map((s) => s.channel)).toEqual([PUSH_CHANNELS.sessionsChanged])
  })

  it('says nothing for a read, whoever dispatched it', () => {
    const target = recorder()
    const events = push({ targets: () => [target] })

    for (const read of ['work.list', 'board.summary', 'sync.status', 'app.status']) {
      events.afterDispatch(read)
    }

    expect(target.sent).toEqual([])
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
