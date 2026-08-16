import { PUSH_CHANNELS } from '../shared/channels.js'

/**
 * What main tells the renderer without being asked.
 *
 * Three events, and the shape of them matters more than the count. Each carries
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
  /** How often the clock-driven event fires. */
  freshnessIntervalMs?: number
  now?: () => Date
}

export interface Push {
  syncProgress(progress: SyncProgress): void
  outboxChanged(): void
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

  const broadcast = (channel: PushChannel, payload: unknown): void => {
    for (const target of options.targets()) target.send(channel, payload)
  }

  const self: Push = {
    syncProgress: (progress) => broadcast(PUSH_CHANNELS.syncProgress, progress),
    outboxChanged: () => broadcast(PUSH_CHANNELS.outboxChanged, {}),

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
          // Fired on failure as well as success, deliberately: a claim that
          // threw may still have moved the row, and the renderer's job is to go
          // and look rather than to infer.
          if (operation.startsWith('outbox.')) self.outboxChanged()
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
