import { z } from 'zod'
import type { FailureReason, FreshnessRecord, ResourceKind, Timestamp } from '../domain/types.js'

/**
 * Constitution XIV, enforced by the type system.
 *
 * The gate says provider-derived data must never be shown — to a user or to an
 * agent — without when it was last successfully retrieved. Making that a
 * required output *schema* means an operation cannot return provider data
 * without its age: the output fails validation. It is not something review has
 * to remember to check.
 *
 * The four states are kept distinct deliberately. Collapsing `failed` into
 * `stale` is the specific error XIV forbids: a lane that has not updated in an
 * hour because polling is slow is a different situation from one that has not
 * updated because the token expired, and only one of them the user can fix.
 */

export type FreshnessState = 'fresh' | 'stale' | 'failed' | 'never'

export interface FreshnessView {
  lastSuccessAt: Timestamp | null
  lastFailureAt: Timestamp | null
  failureReason: FailureReason | null
  nextAttemptAt: Timestamp | null
  state: FreshnessState
  /** Seconds since the last success. `null` when there has never been one. */
  ageSec: number | null
}

export interface Envelope<T> {
  data: T
  /** Keyed by resource kind, because a partial sync leaves some fresh and some not. */
  freshness: Partial<Record<ResourceKind, FreshnessView>>
  /** True when at least one contributing provider failed (XV). The data still renders. */
  partial: boolean
}

const freshnessViewSchema = z.object({
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  failureReason: z
    .enum(['auth', 'rateLimit', 'network', 'notFound', 'unknown'])
    .nullable(),
  nextAttemptAt: z.string().nullable(),
  state: z.enum(['fresh', 'stale', 'failed', 'never']),
  ageSec: z.number().nullable(),
})

/**
 * Schemas produced here are tracked, so registration can verify that an
 * operation marked provider-derived actually returns an envelope. Without the
 * marker an operation could declare a hand-rolled object with a `freshness`
 * key and satisfy nothing.
 */
const ENVELOPE_SCHEMAS = new WeakSet<object>()

export function envelopeOf<T extends z.ZodTypeAny>(data: T) {
  const schema = z.object({
    data,
    freshness: z.record(freshnessViewSchema).default({}),
    partial: z.boolean(),
  })
  ENVELOPE_SCHEMAS.add(schema)
  return schema
}

export function isEnvelopeSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && ENVELOPE_SCHEMAS.has(schema)
}

/**
 * Derive the display state from a freshness record.
 *
 * `never` is checked first and separately: a resource that has never synced is
 * not stale, and calling it stale invites the UI to show an age of zero, which
 * reads as "just updated" — the exact inversion XIV exists to prevent.
 */
export function freshnessView(
  record: FreshnessRecord | undefined,
  nowMs: number,
  staleAfterSec: number,
): FreshnessView {
  if (record === undefined || record.lastSuccessAt === null) {
    return {
      lastSuccessAt: null,
      lastFailureAt: record?.lastFailureAt ?? null,
      failureReason: record?.failureReason ?? null,
      nextAttemptAt: record?.nextAttemptAt ?? null,
      state: 'never',
      ageSec: null,
    }
  }

  const successMs = Date.parse(record.lastSuccessAt)
  const ageSec = Math.max(0, Math.floor((nowMs - successMs) / 1000))

  const failedSinceSuccess =
    record.lastFailureAt !== null && Date.parse(record.lastFailureAt) > successMs

  const state: FreshnessState = failedSinceSuccess
    ? 'failed'
    : ageSec > staleAfterSec
      ? 'stale'
      : 'fresh'

  return {
    lastSuccessAt: record.lastSuccessAt,
    lastFailureAt: record.lastFailureAt,
    failureReason: record.failureReason,
    nextAttemptAt: record.nextAttemptAt,
    state,
    ageSec,
  }
}

/** Build an envelope. `partial` is derived, not passed — one less thing to get wrong. */
export function envelope<T>(
  data: T,
  freshness: Partial<Record<ResourceKind, FreshnessView>>,
): Envelope<T> {
  const partial = Object.values(freshness).some((f) => f !== undefined && f.state === 'failed')
  return { data, freshness, partial }
}
