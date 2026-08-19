import { describe, expect, it } from 'vitest'
import { scheduler, type SchedulerDeps } from '../../src/runtime/scheduler.js'
import { DEFAULT_SETTINGS } from '../../src/services/settings.js'
import type { ProviderKind } from '../../src/domain/types.js'
import type { SyncReport, SyncResult } from '../../src/services/sync.js'

/**
 * The poll scheduler (T074, FR-013).
 *
 * Every assertion here is about *time*, and none of it waits: the clock is a
 * number this file advances and the timers are recorded rather than run. That
 * is the whole reason `scheduler.ts` takes `now`, `setTimer` and `clearTimer`
 * as arguments — a backoff that reaches half an hour would otherwise be a test
 * that takes half an hour, so it would be a test nobody wrote.
 */

interface Harness {
  deps: SchedulerDeps
  /** Move the clock forward. */
  advance(ms: number): void
  /** Every connection id passed to `sync`, in order, across all ticks. */
  polls: string[]
  /** Connections the next sync should report as failing. */
  failing: Set<string>
  /** Connections whose sync should throw rather than report. */
  throwing: Set<string>
  connections: { id: string; kind: ProviderKind }[]
  intervals: { jira: number }
  timers: { run: () => void; ms: number }[]
  cleared: unknown[]
}

const SECOND = 1_000
const MINUTE = 60 * SECOND

function harness(): Harness {
  let clock = Date.parse('2026-08-15T09:00:00.000Z')

  const h: Harness = {
    polls: [],
    failing: new Set(),
    throwing: new Set(),
    /*
     * Two connections of one kind, on one cadence.
     *
     * They were two *kinds* on two cadences — 60s GitHub, 300s Jira — and the
     * difference was what made "each target holds its own cadence" observable.
     * With one provider that pairing is gone, and what these tests demonstrate
     * instead is the case an operator actually has: two Jira sites, or a work
     * account and a personal one. The properties that matter survive the change,
     * because none of them was ever about the *kinds* being different:
     *
     * - backing one target off must not move the other;
     * - the interval is re-read from settings rather than captured;
     * - a hand refresh restarts that target's clock and nothing else's.
     *
     * Sorted so `jira-1` polls before `jira-2` and the assertions can name them.
     */
    connections: [
      { id: 'jira-1', kind: 'jira' },
      { id: 'jira-2', kind: 'jira' },
    ],
    intervals: { ...DEFAULT_SETTINGS.pollIntervalSec },
    timers: [],
    cleared: [],
    advance: (ms) => {
      clock += ms
    },
    deps: {
      connections: async () => h.connections,
      settings: async () => ({ pollIntervalSec: h.intervals }),
      sync: async (connectionId) => {
        h.polls.push(connectionId)
        if (h.throwing.has(connectionId)) throw new Error('unreachable')
        return report(connectionId, !h.failing.has(connectionId))
      },
      now: () => new Date(clock),
      setTimer: (run, ms) => {
        h.timers.push({ run, ms })
        return h.timers.length - 1
      },
      clearTimer: (handle) => h.cleared.push(handle),
    },
  }

  return h
}

/**
 * Let a pass started by a timer finish.
 *
 * `start()` fires the pass with `void tick()`, so there is no promise to await
 * — by design, since a timer callback cannot be awaited either. `setImmediate`
 * runs after every pending microtask, which is what "the pass is done" means
 * when the pass is a chain of awaits over resolved promises. Counting
 * `Promise.resolve()`s instead works only until someone adds an await.
 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function report(connectionId: string, ok: boolean): SyncReport {
  const result: SyncResult = ok
    ? { connectionId, resourceKind: 'tickets', ok: true, count: 3 }
    : { connectionId, resourceKind: 'tickets', ok: false, count: 0, failureReason: 'auth' }

  return { startedAt: '', finishedAt: '', results: [result] }
}

describe('poll scheduler', () => {
  it('polls every connection on the first pass', async () => {
    const h = harness()
    await scheduler(h.deps).tick()

    // Every target is a connection. Local git used to be appended as a
    // pseudo-target under a reserved id, so the lane it fed aged and recovered
    // by the same rules as everything else; there is no such lane now.
    expect(h.polls).toEqual(['jira-1', 'jira-2'])
  })

  it('holds each target to the cadence rather than polling every tick', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    h.polls.length = 0

    // 300s, ticking every 15. Twenty ticks inside one interval must produce one
    // poll each, not twenty — the scheduler's whole job is that the tick rate
    // and the poll rate are different numbers.
    for (let elapsed = 0; elapsed < 6 * MINUTE; elapsed += 15 * SECOND) {
      h.advance(15 * SECOND)
      await poller.tick()
    }

    expect(h.polls.filter((id) => id === 'jira-2')).toHaveLength(1)
    expect(h.polls.filter((id) => id === 'jira-2')).toHaveLength(1)
  })

  it('takes the interval from settings, read fresh rather than captured', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    h.polls.length = 0

    // Changed in Settings after the scheduler started. A scheduler that read
    // its intervals once at construction would keep the old cadence until the
    // app restarted, which is exactly the kind of setting that looks broken.
    h.intervals.jira = 1_200
    h.advance(6 * MINUTE)
    await poller.tick()

    expect(h.polls).not.toContain('jira-2')

    h.advance(15 * MINUTE)
    await poller.tick()
    expect(h.polls).toContain('jira-2')
  })

  it('backs a failing connection off, and only that connection', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    h.failing.add('jira-1')
    await poller.tick()
    h.polls.length = 0

    // One failure doubles the 300s base: not due at 300s.
    h.advance(310 * SECOND)
    await poller.tick()
    expect(h.polls).not.toContain('jira-1')

    // Due at 600s.
    h.advance(300 * SECOND)
    await poller.tick()
    expect(h.polls).toContain('jira-1')

    // Two failures now — 1200s — while the healthy connection kept its own
    // cadence throughout. XV in the time dimension: one connection failing must
    // not change what any other connection does.
    //
    // The window is chosen so both halves are live at once. At t=910s the failing
    // target was last polled at 610s and is not due until 1810s; the healthy one
    // was last polled at 610s (it is due every 300s) and is. A window where
    // neither was due would make the first assertion pass for the wrong reason.
    h.polls.length = 0
    h.advance(300 * SECOND)
    await poller.tick()
    expect(h.polls).not.toContain('jira-1')
    expect(h.polls).toContain('jira-2')
  })

  it('treats a thrown sync as a failure', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    h.throwing.add('jira-1')
    await poller.tick()

    expect(poller.state().find((s) => s.id === 'jira-1')?.failures).toBe(1)
  })

  it('recovers to the normal cadence as soon as a poll succeeds', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    h.failing.add('jira-1')
    await poller.tick()
    // Past the doubled 600s interval, so the second attempt actually happens.
    h.advance(11 * MINUTE)
    await poller.tick()
    expect(poller.state().find((s) => s.id === 'jira-1')?.failures).toBe(2)

    // The operator fixes the credential. Past the twice-doubled 1200s.
    h.failing.delete('jira-1')
    h.advance(21 * MINUTE)
    await poller.tick()
    expect(poller.state().find((s) => s.id === 'jira-1')?.failures).toBe(0)

    // Back on the ordinary 300s cadence, not the 1200s it had backed off to.
    // That is the recovery being asserted: a target that failed twice and then
    // succeeded must not keep waiting as though it were still broken.
    h.polls.length = 0
    h.advance(301 * SECOND)
    await poller.tick()
    expect(h.polls).toContain('jira-1')
  })

  it('caps the backoff at half an hour', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    h.failing.add('jira-2')

    // Eight failures, with 31 minutes between attempts — one minute more than
    // the cap. Capped, every attempt is due and all eight land. Uncapped, the
    // doubling passes 31 minutes at the third failure (5 → 10 → 20 → 40) and
    // the connection simply stops being retried, so the count stalls at 3.
    //
    // Asserting the count rather than "it eventually polls again" is the point:
    // the first version of this test advanced a day per attempt and passed with
    // the cap deleted, because a day is longer than the first several backoffs
    // either way. It was checking that time passes.
    for (let i = 0; i < 8; i += 1) {
      await poller.tick()
      h.advance(31 * MINUTE)
    }

    expect(poller.state().find((s) => s.id === 'jira-2')?.failures).toBe(8)
  })

  it('does not start a second poll for a target still running', async () => {
    const h = harness()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })

    const deps: SchedulerDeps = {
      ...h.deps,
      sync: async (connectionId) => {
        h.polls.push(connectionId)
        if (connectionId === 'jira-1') await blocked
        return report(connectionId, true)
      },
    }

    const poller = scheduler(deps)
    const first = poller.tick()

    // A slow provider must not accumulate a queue of identical requests behind
    // it — the poll every minute would otherwise become every minute *plus* one
    // for each minute it was already late.
    h.advance(5 * MINUTE)
    await poller.tick()
    expect(h.polls.filter((id) => id === 'jira-1')).toHaveLength(1)

    release?.()
    await first
  })

  it('starts polling a connection added after it started, and forgets a removed one', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    h.polls.length = 0

    h.connections.push({ id: 'jira-3', kind: 'jira' })
    await poller.tick()
    expect(h.polls).toEqual(['jira-3'])

    // Removed in Settings. Its backoff state goes with it, so re-adding a
    // connection that had been failing does not inherit a half-hour wait.
    h.connections = h.connections.filter((c) => c.id !== 'jira-3')
    await poller.tick()
    expect(poller.state().map((s) => s.id)).not.toContain('jira-3')
  })

  it('restarts the clock when the operator refreshes by hand', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    h.polls.length = 0

    // Most of the way through the interval the operator presses Refresh.
    // Without this, the automatic poll fires shortly afterwards and asks the
    // tracker the same question twice.
    h.advance(280 * SECOND)
    const dispatch = poller.observing(async () => report('jira-1', true))
    await dispatch('sync.now', { connectionId: 'jira-1' })

    // Past when it *would* have been due, had the hand refresh not counted.
    h.advance(40 * SECOND)
    await poller.tick()
    expect(h.polls).not.toContain('jira-1')

    // And due again 300s after the hand refresh, not after the last automatic
    // poll — the clock restarted rather than being suppressed once.
    h.advance(280 * SECOND)
    await poller.tick()
    expect(h.polls).toContain('jira-1')
  })

  it('clears every target when a hand refresh names no connection', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    h.polls.length = 0

    h.advance(50 * SECOND)
    const dispatch = poller.observing(async () => ({
      startedAt: '',
      finishedAt: '',
      results: [
        { connectionId: 'jira-1', resourceKind: 'tickets' as const, ok: true, count: 1 },
        { connectionId: 'jira-2', resourceKind: 'tickets' as const, ok: true, count: 2 },
      ],
    }))
    await dispatch('sync.now', {})

    h.advance(20 * SECOND)
    await poller.tick()
    expect(h.polls).toEqual([])
  })

  it('leaves the clock alone for operations that are not a sync', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    h.polls.length = 0

    const dispatch = poller.observing(async () => ({ ok: true }))
    await dispatch('notes.create', { body: 'x' })

    h.advance(301 * SECOND)
    await poller.tick()
    expect(h.polls).toContain('jira-1')
  })

  it('counts a failed hand refresh towards backoff', async () => {
    const h = harness()
    const poller = scheduler(h.deps)

    await poller.tick()
    const dispatch = poller.observing(async () => report('jira-1', false))
    await dispatch('sync.now', { connectionId: 'jira-1' })

    expect(poller.state().find((s) => s.id === 'jira-1')?.failures).toBe(1)
  })

  it('survives a tick taken while the service is closing', async () => {
    const h = harness()
    const poller = scheduler({
      ...h.deps,
      connections: async () => {
        throw new Error('database is closed')
      },
    })

    await expect(poller.tick()).resolves.toBeUndefined()
    expect(h.polls).toEqual([])
  })

  it('waits before the first pass, then repeats on the tick interval', async () => {
    const h = harness()
    const stop = scheduler({ ...h.deps, tickMs: 15_000, startDelayMs: 3_000 }).start()

    expect(h.timers).toHaveLength(1)
    expect(h.timers[0]?.ms).toBe(3_000)

    // Nothing has polled yet: the window is still painting, and SQLite writes
    // on this thread would be felt.
    expect(h.polls).toEqual([])

    h.timers[0]?.run()
    await settle()

    expect(h.polls).toEqual(['jira-1', 'jira-2'])
    expect(h.timers[1]?.ms).toBe(15_000)

    stop()
    expect(h.cleared).toContain(1)
  })

  it('does not re-arm after it has been stopped', async () => {
    const h = harness()
    const poller = scheduler({ ...h.deps, startDelayMs: 3_000 })
    const stop = poller.start()

    stop()
    h.timers[0]?.run()
    await settle()

    // A pass already in flight when the app quits is allowed to finish; what
    // must not happen is another one being armed into a service whose databases
    // are closed.
    expect(h.timers).toHaveLength(1)
  })
})
