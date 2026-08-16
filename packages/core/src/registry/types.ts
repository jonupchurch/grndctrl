import type { z } from 'zod'
import type { AuthorKind } from '../domain/types.js'

/**
 * Which adapters may expose an operation.
 *
 * Explicit and non-defaulted, on purpose. Gate XII's failure mode is a
 * capability that quietly exists on one surface and not the other; a default
 * value would reintroduce exactly that, because nobody declaring a new
 * operation would ever think about it.
 *
 * v1 has ten non-`all` entries, and they fall into three arguments, each made
 * where the operations are registered:
 *
 * - **The outbox** (`mintConfirmation`, `enqueue`, `cancel`) — dispatching a
 *   change to the outside world must originate with the operator (XVI).
 * - **Dismissal** (`drift.dismiss`, `drift.undismiss`) — an agent that could
 *   hide a finding could suppress the evidence of its own mistake.
 * - **Configuration** (`connections.list`, `projects.upsert`, `projects.remove`,
 *   `settings.get`, `settings.update`) — what the operator watches, and how
 *   often, is theirs.
 *
 * None of the three is covered by any other gate: none of them is a provider
 * write. The exposure field is what stops them, which is why it is explicit and
 * non-defaulted.
 */
export type Exposure = 'all' | 'ui-only' | 'agent-only'

/** The three surfaces. Adapters declare which one they are. */
export type Surface = 'ipc' | 'http' | 'mcp'

export function surfaceAllows(exposure: Exposure, surface: Surface): boolean {
  if (exposure === 'all') return true
  if (exposure === 'ui-only') return surface === 'ipc'
  return surface === 'http' || surface === 'mcp'
}

/**
 * What a handler is given. Deliberately small: a handler that needs more than
 * this is usually a handler doing an adapter's job.
 */
export interface Ctx {
  /**
   * Stamped by the adapter from the transport, never read from a payload —
   * an agent must not be able to claim it is the user.
   */
  authorKind: AuthorKind
  /** Which agent, when `authorKind` is `agent`. */
  authorId: string | null
  surface: Surface
  now(): Date
}

export interface Operation<In = unknown, Out = unknown> {
  /** Dotted, domain first: `work.list`, `notes.upsert`, `outbox.claim`. */
  name: string
  input: z.ZodType<In>
  output: z.ZodType<Out>
  exposure: Exposure
  /** Read operations are cache-safe; mutations are never retried automatically. */
  mutates: boolean
  /**
   * True when the result contains provider-derived data. Registration then
   * *requires* the output schema to be an envelope (XIV) — declaring this and
   * returning a bare object is a startup error, not a review finding.
   */
  providerDerived: boolean
  handler(input: In, ctx: Ctx): Promise<Out>
  /** One line, shown in an agent's tool list. Written for a model to read. */
  description: string
}

/** Helper that keeps `In`/`Out` inferred from the schemas rather than restated. */
export function defineOperation<In, Out>(op: Operation<In, Out>): Operation<In, Out> {
  return op
}
