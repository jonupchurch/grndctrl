import { z } from 'zod'
import type { CoreServices } from '../../runtime/services.js'
import { freshnessView } from '../envelope.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'

/**
 * Refreshing the mirror, and reporting how fresh it is.
 *
 * `sync.status` is the honest half of constitution XIV. It reports per
 * connection *and* per resource kind, with four states kept apart: `fresh`,
 * `stale`, `failed`, and `never`. Collapsing `failed` into `stale` is the
 * specific error the gate forbids — a lane that is an hour old because polling
 * is slow is a different situation from one that is an hour old because the
 * token expired, and only one of them the operator can fix.
 *
 * `sync.now` is exposed to agents as well as to the UI. It reads; it cannot
 * write anything to a provider (XVI), and an agent that has just finished a
 * task has better information about when a refresh is worth doing than a timer
 * does.
 */

/*
 * `resourceKind` named six kinds until the producer stopped producing them.
 *
 * An operation's output is parsed against its schema, so narrowing this while
 * `syncCode` and `syncLocal` were still running would have made every refresh
 * throw — on a value the application itself produced. That is the whole
 * ordering argument in one field, and it is why this landed with the producer
 * rather than with the rest of the boundary narrowing a milestone earlier.
 */
const resultSchema = z.object({
  connectionId: z.string(),
  resourceKind: z.enum(['tickets']),
  ok: z.boolean(),
  count: z.number().int().nonnegative(),
  failureReason: z.enum(['auth', 'rateLimit', 'network', 'notFound', 'unknown']).optional(),
  detail: z.string().optional(),
})

const statusSchema = z.object({
  connections: z.array(
    z.object({
      connectionId: z.string(),
      resourceKind: z.string(),
      state: z.enum(['fresh', 'stale', 'failed', 'never']),
      lastSuccessAt: z.string().nullable(),
      lastFailureAt: z.string().nullable(),
      failureReason: z.enum(['auth', 'rateLimit', 'network', 'notFound', 'unknown']).nullable(),
      nextAttemptAt: z.string().nullable(),
      ageSec: z.number().nullable(),
    }),
  ),
  /** Connections that cannot run at all, and why. Never silently skipped. */
  unavailable: z.array(
    z.object({
      connectionId: z.string(),
      reason: z.enum(['no-credential', 'keychain-unavailable']),
    }),
  ),
})

export function syncOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'sync.status',
      description:
        'How fresh each connection is, per resource kind. "never synced", "stale" and "failed to refresh" are three different answers.',
      input: z.object({}),
      output: statusSchema,
      exposure: 'all',
      mutates: false,
      // Not provider-derived: this *is* the freshness report. Wrapping a
      // freshness report in a freshness envelope would be circular.
      providerDerived: false,
      handler: async (_input, ctx) => {
        const settings = services.settings.get()
        // Three polls' worth. It was the *larger* of two intervals, so a stale
        // reading meant "even the slow provider should have refreshed by now".
        const staleAfterSec = settings.pollIntervalSec.jira * 3

        return {
          connections: services.mirror.listFreshness().map((record) => {
            const view = freshnessView(record, ctx.now().getTime(), staleAfterSec)
            return {
              connectionId: record.connectionId,
              resourceKind: record.resourceKind,
              state: view.state,
              lastSuccessAt: view.lastSuccessAt,
              lastFailureAt: view.lastFailureAt,
              failureReason: view.failureReason,
              nextAttemptAt: view.nextAttemptAt,
              ageSec: view.ageSec,
            }
          }),
          unavailable: services.credentialGaps(),
        }
      },
    }),

    defineOperation({
      name: 'sync.now',
      description:
        'Refresh now, optionally for one connection. Read-only against every provider. Returns what each fetch did, including what failed.',
      input: z.object({ connectionId: z.string().min(1).optional() }),
      output: z.object({
        startedAt: z.string(),
        finishedAt: z.string(),
        results: z.array(resultSchema),
      }),
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => services.syncNow(input, ctx.now()),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
