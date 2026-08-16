import type { ProviderKind, Settings } from '../domain/types.js'
import { LOCAL_CONNECTION_ID, type SyncReport } from '../services/sync.js'

/**
 * What makes the board refresh without being asked (T074, FR-013).
 *
 * `pollIntervalSec` has been in the settings schema since M2, and until now the
 * only thing reading it was the *freshness* calculation: `board.ts` marks a lane
 * stale at three times the poll interval, and `sync.ts` reports the same
 * threshold on `sync.status`. So the board has been saying "this is stale
 * because we should have polled twice by now" while nothing polled at all. The
 * numbers were only ever correct because the operator kept clicking Refresh.
 *
 * That is the shape of most defects in this project — a field both halves agree
 * about that nothing connects — and this file is the connection.
 *
 * ## Why it lives in core
 *
 * The poll is a property of the service, not of the window. An operator who
 * closes the window on macOS, or who is running this purely as an MCP backend
 * for an agent, still has a mirror that must not silently rot. Nothing here
 * imports Electron or a timer implementation: the host passes `setTimer`,
 * `clearTimer` and `now`, so "eleven minutes pass and the second failure backs
 * off to four" is a unit test that runs in a millisecond.
 *
 * ## The shape of the loop
 *
 * One repeating tick that asks "what is due?", rather than a timer per
 * connection. It costs two trivial reads every `tickMs` and buys three things a
 * timer-per-target design has to solve separately: a connection added in
 * Settings starts polling without anything telling the scheduler, a connection
 * removed stops, and an interval changed in Settings takes effect on the next
 * tick instead of at the end of the current one.
 */

/**
 * The one shape a host reaches the registry through.
 *
 * Declared here rather than imported so core keeps its direction of dependency:
 * the Electron shell has an identical `Dispatch` in `main/push.ts`, and this
 * file must not know that the shell exists (XVIII).
 */
export type SchedulerDispatch = (operation: string, payload: unknown) => Promise<unknown>

export interface PollTarget {
  id: string
  kind: ProviderKind | 'local'
}

export interface SchedulerDeps {
  /**
   * The connections that exist *right now*. Re-read every tick rather than
   * captured at start, so adding a connection in Settings starts polling it.
   */
  connections(): Promise<readonly { id: string; kind: ProviderKind }[]>
  settings(): Promise<Pick<Settings, 'pollIntervalSec'>>
  /**
   * Refresh one target. The report is read rather than trusted: a sync that
   * resolves can still carry a failed result per connection and resource kind,
   * which is the whole point of XV, and backing off only on a thrown error
   * would mean a revoked credential is retried at full rate forever.
   */
  sync(connectionId: string): Promise<SyncReport>
  now(): Date
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** How often to ask what is due. Tests drive `tick()` directly instead. */
  tickMs?: number
  /**
   * How long to leave the process alone before the first pass.
   *
   * Not politeness. `better-sqlite3` is synchronous, so writing a sync's
   * results blocks whichever process hosts core — in v1 that is the Electron
   * main process, which is also the one the window is waiting on to paint. A
   * few seconds of quiet is the difference between an app that opens and an app
   * that opens after a stutter, and nothing on the board is wrong in the
   * meantime: it is showing the mirror, and the mirror says how old it is.
   */
  startDelayMs?: number
}

export interface Scheduler {
  /** Begin polling. Returns the stop function. */
  start(): () => void
  /**
   * Consider every target once. Exposed so the cadence can be tested without a
   * clock, and so a host can force a pass — not because anything else should
   * call it on a schedule of its own.
   */
  tick(): Promise<void>
  /**
   * Wrap a dispatch so a refresh the *operator* asked for restarts the clock.
   *
   * Without this, clicking Refresh at 59 seconds is followed by an automatic
   * poll one second later: two round trips to GitHub for one question. Written
   * as a wrapper rather than as a method the caller remembers to invoke, for
   * the same reason `push.observing` is — a rule that depends on every call
   * site remembering it is a rule that lasts until the next call site.
   */
  observing(dispatch: SchedulerDispatch): SchedulerDispatch
  /** What the scheduler currently believes, for diagnostics and tests. */
  state(): readonly PollState[]
}

export interface PollState {
  id: string
  kind: ProviderKind | 'local'
  /** Consecutive failed polls. Reset to 0 by any success, manual or automatic. */
  failures: number
  lastPolledAt: string | null
}

const DEFAULT_TICK_MS = 15_000
const DEFAULT_START_DELAY_MS = 3_000

/**
 * The ceiling on backoff, and the reason it is half an hour.
 *
 * Backoff exists so a revoked token or a dropped VPN is not retried sixty times
 * an hour, but a command station that gives up entirely is worse than one that
 * is slow: the operator fixes the credential in Settings and then waits,
 * looking at a board that will not come back. Thirty minutes is short enough
 * that recovery happens on its own within one coffee, and long enough that a
 * genuinely dead connection costs two requests an hour.
 *
 * There is deliberately no jitter. Jitter earns its keep when many clients
 * stampede one server; here there are two or three connections belonging to one
 * person, and the cost — a cadence that cannot be asserted in a test without
 * injecting a random source — is larger than the benefit.
 */
const MAX_BACKOFF_MS = 30 * 60_000

/** Doubling stops here; beyond it the ceiling above is doing the work anyway. */
const MAX_DOUBLINGS = 6

export function scheduler(deps: SchedulerDeps): Scheduler {
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS

  interface Entry {
    failures: number
    lastPolledAt: number | null
    /** Prevents a slow poll from being started a second time while it runs. */
    running: boolean
  }

  const entries = new Map<string, Entry>()
  let kinds = new Map<string, ProviderKind | 'local'>()
  let stopped = false

  const entryFor = (id: string): Entry => {
    const existing = entries.get(id)
    if (existing !== undefined) return existing

    // A target seen for the first time is due immediately: on launch that is
    // exactly right — the board should be current when it opens rather than a
    // minute after — and for a connection added mid-session it is what the
    // person who just added it is waiting for.
    const fresh: Entry = { failures: 0, lastPolledAt: null, running: false }
    entries.set(id, fresh)
    return fresh
  }

  /**
   * How long this target waits between polls, given how it has been going.
   *
   * Local git takes the GitHub interval rather than one of its own. Not
   * arbitrary: `board.ts` derives the stale threshold for `branches` and
   * `local` from `pollIntervalSec.github`, so any other cadence here would put
   * the lane in a state it declares stale before the poll that would clear it.
   * Two numbers describing one rhythm have to come from one place.
   */
  const intervalMs = (kind: ProviderKind | 'local', settings: Pick<Settings, 'pollIntervalSec'>) => {
    const base = kind === 'jira' ? settings.pollIntervalSec.jira : settings.pollIntervalSec.github
    return base * 1_000
  }

  const delayMs = (
    entry: Entry,
    kind: ProviderKind | 'local',
    settings: Pick<Settings, 'pollIntervalSec'>,
  ): number => {
    const base = intervalMs(kind, settings)
    if (entry.failures === 0) return base
    return Math.min(base * 2 ** Math.min(entry.failures, MAX_DOUBLINGS), MAX_BACKOFF_MS)
  }

  /**
   * Did this run refresh the target, or not?
   *
   * A report with no results for the connection is a success: it means nothing
   * is bound to it, which is a configuration state and not a failure to reach
   * anything. Backing off there would be backing off from doing nothing.
   */
  const succeeded = (report: SyncReport, id: string): boolean =>
    report.results.filter((r) => r.connectionId === id).every((r) => r.ok)

  const poll = async (target: PollTarget): Promise<void> => {
    const entry = entryFor(target.id)
    if (entry.running) return

    entry.running = true
    try {
      const report = await deps.sync(target.id)
      entry.failures = succeeded(report, target.id) ? 0 : entry.failures + 1
    } catch {
      // A throw is the transport failing rather than a provider — the same
      // response either way, because the operator's board is equally not
      // refreshed and hammering it will not help.
      entry.failures += 1
    } finally {
      entry.lastPolledAt = deps.now().getTime()
      entry.running = false
    }
  }

  const targetsNow = async (): Promise<{
    targets: PollTarget[]
    settings: Pick<Settings, 'pollIntervalSec'>
  }> => {
    const [connections, settings] = await Promise.all([deps.connections(), deps.settings()])

    // Local git is a target like any other, under the reserved id the mirror
    // already records it against — so the lane it feeds ages and recovers by
    // the same rules as the rest of the board, rather than only when the
    // operator happens to refresh something else.
    const targets: PollTarget[] = [
      ...connections.map((c) => ({ id: c.id, kind: c.kind })),
      { id: LOCAL_CONNECTION_ID, kind: 'local' as const },
    ]

    // Forget the state of a connection that has been removed, so re-adding one
    // that was failing does not inherit its backoff.
    kinds = new Map(targets.map((t) => [t.id, t.kind]))
    for (const id of [...entries.keys()]) if (!kinds.has(id)) entries.delete(id)

    return { targets, settings }
  }

  const self: Scheduler = {
    async tick() {
      let context
      try {
        context = await targetsNow()
      } catch {
        // Settings or connections unreadable — usually the service shutting
        // down underneath us. Skip this pass; the next one will find out.
        return
      }

      const at = deps.now().getTime()

      for (const target of context.targets) {
        const entry = entryFor(target.id)

        // No `running` check here, deliberately. `poll` holds that invariant —
        // it is the function that must not run twice — and a second copy of the
        // guard at this level made it impossible to probe either one: removing
        // one left the other doing the job, and a gate that cannot be made to
        // fail is a gate nobody has tested.
        const due =
          entry.lastPolledAt === null ||
          at - entry.lastPolledAt >= delayMs(entry, target.kind, context.settings)

        // Awaited in sequence rather than fanned out: `runSync` already
        // serialises its own fetches to keep the rate-limit story simple, and
        // three connections starting at once would undo that.
        if (due) await poll(target)
      }
    },

    start() {
      stopped = false

      // Held in a variable rather than closed over, because the timer is
      // re-armed after each pass: clearing only the first handle would leave a
      // pass pending into a service that has already closed its databases.
      let handle = deps.setTimer(function run() {
        void self.tick().finally(() => {
          // Re-armed after the pass finishes rather than on a fixed interval,
          // so a poll that takes longer than one tick cannot queue passes
          // behind itself.
          if (!stopped) handle = deps.setTimer(run, tickMs)
        })
      }, deps.startDelayMs ?? DEFAULT_START_DELAY_MS)

      return () => {
        stopped = true
        deps.clearTimer(handle)
      }
    },

    observing(dispatch) {
      const wrapped = async (operation: string, payload: unknown): Promise<unknown> => {
        const result = await dispatch(operation, payload)
        if (operation !== 'sync.now') return result

        const at = deps.now().getTime()
        const named = connectionIdOf(payload)
        const report = result as SyncReport | undefined

        for (const [id] of kinds) {
          if (named !== null && named !== id) continue
          // `sync.now` with no connection id refreshes everything, so every
          // target's clock restarts — including `local`, which `runSync` runs
          // on any unscoped call.
          const entry = entryFor(id)
          entry.lastPolledAt = at
          if (report !== undefined) entry.failures = succeeded(report, id) ? 0 : entry.failures + 1
        }

        return result
      }

      return wrapped
    },

    state: () =>
      [...entries.entries()].map(([id, entry]) => ({
        id,
        kind: kinds.get(id) ?? 'local',
        failures: entry.failures,
        lastPolledAt:
          entry.lastPolledAt === null ? null : new Date(entry.lastPolledAt).toISOString(),
      })),
  }

  return self
}

/** The connection a `sync.now` payload names, or null for "all of them". */
function connectionIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const id = (payload as Record<string, unknown>)['connectionId']
  return typeof id === 'string' ? id : null
}
