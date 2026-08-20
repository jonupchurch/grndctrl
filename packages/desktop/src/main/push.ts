import { PUSH_CHANNELS } from '../shared/channels.js'

/**
 * What main tells the renderer without being asked.
 *
 * The events are listed below; the shape of them matters more than the count,
 * which is why this sentence no longer states one. Each carries
 * *that* something changed and nothing about what: the renderer refetches
 * through the same operations it already uses, so there is exactly one code path
 * producing any given number on the board. A push carrying data would be a
 * second one, and the two would disagree during an outage — which is the moment
 * the board is being read most carefully.
 *
 * They are derived from the dispatch stream rather than emitted from inside
 * core, which keeps them working when core moves out of the process (decision
 * 19): a message round trip still passes through the same wrapper.
 *
 * - `sync:progress` — a poll started or finished. Drives the header spinner and,
 *   on finish, a refetch of everything provider-derived.
 * - `freshness:tick` — nothing changed, but the numbers on screen aged. XIV
 *   requires freshness to be *shown*, and "4 minutes ago" that stays "4 minutes
 *   ago" for an hour is worse than no timestamp: it reads as fresh.
 * - `outbox:changed` — an action was enqueued, claimed, completed or expired, by
 *   this window or by an agent over MCP. Without it the operator watches a
 *   dispatched action sit at "pending" until they happen to click something.
 * - `sessions:changed` — an agent started, reported activity, or ended. The
 *   Sessions panel tells the operator "a session appears here the moment one
 *   starts"; until this existed that sentence was false for an open window.
 * - `notes:changed` — a note was written, edited, resolved or deleted, by this
 *   window or by an agent. **This one was missing for the whole life of the
 *   product** and nothing noticed, because until 007 the only thing a note
 *   changed on an open board was a badge count, and a badge that is a few
 *   minutes stale looks exactly like a badge that is correct. FR-135 puts an
 *   agent's unanswered *question* in a panel, and a question that appears when
 *   the next poll happens to finish is not a question the operator was asked.
 * - `updates:changed` — an agent posted an update. The panel is the one place
 *   an agent talks to the operator in sentences, and it is worth nothing if it
 *   only catches up when something else happens to invalidate the board.
 * - `focus:changed` — the active ticket was set or cleared. This is the event
 *   with the highest ratio of *agent* to *window* traffic on the list: the
 *   operator can set focus from a ticket row, but the caller it was built for is
 *   an agent picking work up over MCP (FR-127). Without it the panel says the
 *   operator is on whatever they were on when the window opened.
 *
 * ## The half that was missing, and why it was invisible
 *
 * These are derived by wrapping a dispatch — and for a year only *one* dispatch
 * was wrapped. `main/index.ts` composes the wrapper for the IPC adapter, while
 * the loopback HTTP adapter that agents use dispatches straight through the
 * registry in `main/service.ts`. So every event above was emitted for actions
 * taken *in the window* and none for actions taken *by an agent* — including
 * `outbox:changed`, whose own description above promised the opposite.
 *
 * Nothing failed, because both halves were individually correct: the window
 * updated when the window acted. The agent surface is the one nobody watches, so
 * "the board does not move when an agent does something" needed an agent, an
 * open window, and someone looking at both at once.
 *
 * `afterDispatch` is therefore the single place that maps an operation to its
 * event, and **both** paths call it.
 */

export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS]

export interface SyncProgress {
  phase: 'started' | 'finished'
  connectionId: string | null
}

export interface PushTarget {
  send(channel: string, payload: unknown): void
}

/** The one shape everything in `main/` uses to reach core. */
export type Dispatch = (operation: string, payload: unknown) => Promise<unknown>

export interface PushOptions {
  /** Every open window. Empty when the app is running with no UI, which is legal. */
  targets(): readonly PushTarget[]
  /**
   * Whether an operation changes anything, read from the registry.
   *
   * This is not decoration. Matching on the name prefix alone announces
   * `sessions.list` — a **read** — as a change, and the renderer's response to
   * the announcement is to refetch, which dispatches `sessions.list`, which
   * announces a change. The first version of the session push did exactly that
   * and produced hundreds of broadcasts from a single agent call.
   *
   * A predicate rather than a hardcoded list, so a mutating operation added
   * later is covered without anyone remembering this file — the registry
   * already carries the answer.
   *
   * Defaults to "everything mutates", which is the safe direction for a caller
   * that has not wired it: a redundant refresh is a nuisance, a missing one is
   * the bug this exists to fix. Callers that can loop must supply it.
   */
  mutates?: (operation: string) => boolean
  /** How often the clock-driven event fires. */
  freshnessIntervalMs?: number
  now?: () => Date
}

export interface Push {
  syncProgress(progress: SyncProgress): void
  outboxChanged(): void
  sessionsChanged(): void
  focusChanged(): void
  updatesChanged(): void
  notesChanged(): void
  /**
   * Emit whatever this operation implies, having run.
   *
   * The one place the operation-to-event mapping lives, so the IPC path and the
   * agent's HTTP path cannot drift apart — which is exactly what happened when
   * only the first of them was wrapped.
   */
  afterDispatch(operation: string): void
  /** Starts the freshness clock. Returns the stop function. */
  start(): () => void
  /**
   * Wrap a dispatch so the events above follow from what actually ran, rather
   * than from every caller remembering to announce itself.
   */
  observing(dispatch: Dispatch): Dispatch
}

export function push(options: PushOptions): Push {
  const now = options.now ?? (() => new Date())
  const intervalMs = options.freshnessIntervalMs ?? 30_000
  const mutates = options.mutates ?? ((): boolean => true)

  const broadcast = (channel: PushChannel, payload: unknown): void => {
    for (const target of options.targets()) target.send(channel, payload)
  }

  const self: Push = {
    syncProgress: (progress) => broadcast(PUSH_CHANNELS.syncProgress, progress),
    outboxChanged: () => broadcast(PUSH_CHANNELS.outboxChanged, {}),
    sessionsChanged: () => broadcast(PUSH_CHANNELS.sessionsChanged, {}),
    focusChanged: () => broadcast(PUSH_CHANNELS.focusChanged, {}),
    updatesChanged: () => broadcast(PUSH_CHANNELS.updatesChanged, {}),
    notesChanged: () => broadcast(PUSH_CHANNELS.notesChanged, {}),

    afterDispatch(operation) {
      // A read changes nothing, and announcing one is not merely wasteful — it
      // is a loop. The renderer answers an announcement by refetching, the
      // refetch is a read, and the read announces again.
      if (!mutates(operation)) return

      // Fired on failure as well as success, deliberately: a claim that threw
      // may still have moved the row, and the renderer's job is to go and look
      // rather than to infer.
      if (operation.startsWith('outbox.')) self.outboxChanged()
      // `sessions.heartbeat` included. It does not count as *activity* — the
      // service is careful about that distinction — but it does change
      // `sinceHeartbeatSec`, which is what turns a running session amber on the
      // panel. A liveness display that only updates when the agent does real
      // work cannot show an agent that has stopped doing any.
      if (operation.startsWith('sessions.')) self.sessionsChanged()
      // `focus.get` is a read and is filtered out above, which matters more here
      // than elsewhere: the panel's response to this event is to call
      // `focus.get`, so announcing reads would be a loop with a one-event cycle
      // rather than the long one the outbox nearly had.
      if (operation.startsWith('focus.')) self.focusChanged()
      if (operation.startsWith('updates.')) self.updatesChanged()
      if (operation.startsWith('notes.')) self.notesChanged()
    },

    start() {
      const timer = setInterval(
        () => broadcast(PUSH_CHANNELS.freshnessTick, { at: now().toISOString() }),
        intervalMs,
      )
      // The clock must never be the reason the process stays alive — the app
      // quits when its windows close, not when a timer is done with it.
      timer.unref?.()
      return () => clearInterval(timer)
    },

    observing(dispatch) {
      return async (operation, payload) => {
        const connectionId = syncConnectionOf(operation, payload)
        if (connectionId !== undefined) self.syncProgress({ phase: 'started', connectionId })

        try {
          return await dispatch(operation, payload)
        } finally {
          if (connectionId !== undefined) self.syncProgress({ phase: 'finished', connectionId })
          self.afterDispatch(operation)
        }
      }
    },
  }

  return self
}

/**
 * `undefined` when the operation is not a sync; otherwise the connection it
 * names, or `null` for "all of them".
 */
function syncConnectionOf(operation: string, payload: unknown): string | null | undefined {
  if (operation !== 'sync.now') return undefined

  const id =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['connectionId']
      : undefined

  return typeof id === 'string' ? id : null
}
