import {
  QueryClient,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useEffect } from 'react'
import { call, type BridgeError } from './bridge.js'

/**
 * Every read the interface makes, and the one number it must not invent (T132).
 *
 * **`lastSuccessAt`, never `dataUpdatedAt`.** TanStack Query knows when *it*
 * last got an answer. That is not when the data was last true. During a GitHub
 * outage the query keeps succeeding — main answers instantly from the mirror —
 * so `dataUpdatedAt` marches forward at four seconds old while the pull requests
 * on screen are from this morning. Rendering the cache's timestamp would make
 * the board most confidently wrong exactly when the operator most needs it
 * right. The envelope's `lastSuccessAt` is the provider's, and it is the only
 * one this code will show (XIV).
 *
 * The two also disagree in the other direction, which is why `state` is carried
 * rather than derived from an age: a resource that has *never* synced has no age
 * at all, and "never" is a different sentence from "stale" (FR-013).
 */

export type FreshnessState = 'fresh' | 'stale' | 'failed' | 'never'
export type FailureReason = 'auth' | 'rateLimit' | 'network' | 'notFound' | 'unknown'

export interface FreshnessView {
  lastSuccessAt: string | null
  lastFailureAt: string | null
  failureReason: FailureReason | null
  nextAttemptAt: string | null
  state: FreshnessState
  ageSec: number | null
}

export interface Envelope<T> {
  data: T
  freshness: Record<string, FreshnessView | undefined>
  /** True when a contributing provider failed. The data still renders (XV). */
  partial: boolean
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // No polling here. Main already polls the providers on the operator's
        // configured interval and pushes `sync:progress` when it finishes; a
        // second, unrelated timer in the renderer would re-read SQLite on its
        // own schedule and put two different ages on screen at once.
        refetchInterval: false,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        // A mutation is never retried automatically (that is what `mutates`
        // means in the registry), and a read that failed over IPC failed for a
        // reason retrying will not fix — main is either running or it is not.
        retry: false,
      },
    },
  })
}

/** Read an operation. The key is the operation name plus its input, nothing else. */
export function useOperation<T>(operation: string, input?: unknown): UseQueryResult<T, BridgeError> {
  return useQuery<T, BridgeError>({
    queryKey: [operation, input ?? {}],
    queryFn: () => call(operation, input) as Promise<T>,
  })
}

/**
 * Refetch when main says something changed.
 *
 * The push events carry no data, deliberately (`main/push.ts`), so this
 * invalidates and the ordinary query path produces the new numbers. One code
 * path per number on the board; a push carrying its own payload would be a
 * second one, and the two would disagree during an outage.
 */
export function usePushInvalidation(): void {
  const client = useQueryClient()

  useEffect(() => {
    const bridge = globalThis.window.grndctrl
    if (bridge === undefined) return

    const everything = (): void => void client.invalidateQueries()

    const unsubscribe = [
      // Only on finish. Invalidating when a sync *starts* would refetch the
      // pre-sync state and then immediately refetch again.
      bridge.on.syncProgress((payload) => {
        if ((payload as { phase?: string }).phase === 'finished') everything()
      }),
      bridge.on.outboxChanged(() => {
        void client.invalidateQueries({ queryKey: ['outbox.list'] })
        void client.invalidateQueries({ queryKey: ['outbox.pending'] })
      }),
      // Nothing changed; the numbers aged. Re-render without refetching — the
      // data is identical and only the "4 minutes ago" beside it is not.
      bridge.on.freshnessTick(() => void client.invalidateQueries({ queryKey: ['__tick'] })),
    ]

    return () => {
      for (const off of unsubscribe) off()
    }
  }, [client])
}

/**
 * The worst freshness among some named resources.
 *
 * Worst rather than average: a header that averaged would report "mostly fine"
 * for a board whose pull requests have not refreshed since a token expired. XV
 * says degradation is per-provider and visible, so the summary takes the worst
 * case or it is reassurance rather than information.
 *
 * **Which resources, though, is the part that has to be chosen.** An envelope
 * carries freshness for everything correlation touched, including kinds nothing
 * on screen displays. Taking the worst across all of them puts a lane into
 * "never synced" because `comparisons` has no row yet — which is true about
 * comparisons and a lie about that lane. Each caller names the resources it is
 * actually showing.
 */
const ORDER: Record<FreshnessState, number> = { fresh: 0, stale: 1, never: 2, failed: 3 }

export function worstFreshness(
  envelope: Envelope<unknown> | undefined,
  ...kinds: string[]
): FreshnessView | null {
  if (envelope === undefined) return null

  const considered =
    kinds.length === 0
      ? Object.values(envelope.freshness)
      : kinds.map((kind) => envelope.freshness[kind])

  let worst: FreshnessView | null = null
  for (const view of considered) {
    if (view === undefined) continue
    if (worst === null || ORDER[view.state] > ORDER[worst.state]) worst = view
  }

  return worst
}
