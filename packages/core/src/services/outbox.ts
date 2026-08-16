import { randomUUID } from 'node:crypto'
import type { NaturalKey } from '../domain/keys.js'
import { subjectKindOf } from '../domain/keys.js'
import type { ActionHistoryEntry, ActionKind, ActionState, OutboxAction } from '../domain/types.js'
import { conflict, invalid, preconditionFailed } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { OutboxRepository } from '../store/authored/outbox.js'
import type { Confirmation, ConfirmationTokens } from './confirmation.js'

/**
 * The action outbox — the only route from Ground Control to a change in the
 * outside world, and it does not travel that route itself.
 *
 * Constitution XVI in three sentences. Ground Control's own credentials are
 * read-only and no code here calls a provider write endpoint. What it does
 * instead is record a *request*, individually confirmed by the operator, which
 * an agent claims and executes with its own credentials. The outbox is durable
 * precisely so that confirming an action with no agent running still works —
 * the agent picks it up whenever it next connects (SC-008).
 *
 * The seam that makes this safe is `mintConfirmation`, and it is deliberately
 * asymmetric: it is the one operation in the registry exposed to the UI and
 * nowhere else. Sync, correlation and drift cannot reach it — not by policy,
 * but because they do not import it and a test walks the import graph to prove
 * it (T108). An agent cannot mint one either, so an agent cannot manufacture
 * work for itself.
 */

export interface OutboxServiceDeps {
  outbox: OutboxRepository
  confirmations: ConfirmationTokens
  /** How long a claim is held before it returns to the queue. */
  claimLeaseSec?: number
  /** How long a confirmed action waits for an agent before it lapses. */
  pendingTtlSec?: number
  newId?(): string
}

export interface MintInput {
  subjectKey: NaturalKey
  kind: ActionKind
  payload: Record<string, unknown>
}

export interface EnqueueInput extends MintInput {
  confirmationToken: string
  motivatingFindingId?: string | null | undefined
}

export interface OutboxService {
  mintConfirmation(input: MintInput, ctx: Ctx): Confirmation
  enqueue(input: EnqueueInput, ctx: Ctx): OutboxAction
  pending(): OutboxAction[]
  list(filter: { states?: readonly ActionState[] | undefined }): OutboxAction[]
  get(id: string): OutboxAction | null
  claim(input: { id: string; claimedBy?: string | undefined }, ctx: Ctx): OutboxAction
  complete(input: { id: string; result?: string | undefined }, ctx: Ctx): OutboxAction
  fail(input: { id: string; reason: string }, ctx: Ctx): OutboxAction
  cancel(input: { id: string }, ctx: Ctx): OutboxAction
  /** Return lapsed claims to the queue and expire actions nobody ever took. */
  sweep(now: Date): { revived: string[]; expired: string[] }
}

/**
 * Five minutes to execute a claimed action. Long enough for a Jira transition
 * plus retries; short enough that an agent killed mid-action returns the work
 * to the queue while the operator is still at the desk.
 */
const DEFAULT_CLAIM_LEASE_SEC = 300

/**
 * Seven days before a confirmed action lapses unclaimed. The outbox exists to
 * survive "no agent running right now", so this has to outlast a weekend — but
 * a two-week-old confirmation is no longer something the operator remembers
 * agreeing to.
 */
const DEFAULT_PENDING_TTL_SEC = 7 * 24 * 3600

/** Actions may only attach to things that can actually be acted on. */
const ACTIONABLE = ['ticket', 'pull-request', 'branch', 'workspace'] as const

export function outboxService(deps: OutboxServiceDeps): OutboxService {
  const { outbox, confirmations } = deps
  const leaseSec = deps.claimLeaseSec ?? DEFAULT_CLAIM_LEASE_SEC
  const ttlSec = deps.pendingTtlSec ?? DEFAULT_PENDING_TTL_SEC
  const newId = deps.newId ?? (() => `action:${randomUUID()}`)

  const actorOf = (ctx: Ctx): string =>
    ctx.authorKind === 'agent' ? (ctx.authorId ?? 'agent') : 'operator'

  const entry = (
    at: string,
    from: ActionState | null,
    to: ActionState,
    actor: string,
    detail: string | null,
  ): ActionHistoryEntry => ({ at, from, to, actor, detail })

  const mustGet = (id: string): OutboxAction => {
    const action = outbox.get(id)
    if (action === null) throw preconditionFailed(`No action '${id}'.`)
    return action
  }

  /**
   * A claimed action may only be finished by whoever holds the claim.
   *
   * Without this, an agent that lost its lease could still report completion for
   * work another agent is now doing, and the history would record a success that
   * belongs to nobody.
   */
  const requireClaimant = (action: OutboxAction, ctx: Ctx): void => {
    if (action.state !== 'claimed') {
      throw preconditionFailed(`Action '${action.id}' is ${action.state}, not claimed.`)
    }
    const actor = actorOf(ctx)
    if (action.claimedBy !== actor) {
      throw preconditionFailed(
        `Action '${action.id}' is claimed by ${action.claimedBy ?? 'someone else'}, not by ${actor}.`,
      )
    }
  }

  return {
    mintConfirmation(input, ctx) {
      const kind = subjectKindOf(input.subjectKey)
      if (kind === null || !ACTIONABLE.includes(kind as (typeof ACTIONABLE)[number])) {
        throw invalid(`Actions cannot be raised against '${input.subjectKey}'.`)
      }
      return confirmations.mint(input, ctx.now())
    },

    enqueue(input, ctx) {
      // Throws unless the token was minted for *this* action, is unused, and is
      // still inside its window. There is no path into the table that skips it.
      confirmations.consume(
        input.confirmationToken,
        { subjectKey: input.subjectKey, kind: input.kind, payload: input.payload },
        ctx.now(),
      )

      const at = ctx.now().toISOString()

      return outbox.insert({
        id: newId(),
        subjectKey: input.subjectKey,
        kind: input.kind,
        payload: input.payload,
        motivatingFindingId: input.motivatingFindingId ?? null,
        state: 'pending',
        // Stamped here rather than accepted from the caller: a confirmation
        // timestamp supplied by whoever wants the action is not evidence.
        confirmedAt: at,
        confirmedVia: ctx.surface,
        claimedBy: null,
        claimedAt: null,
        claimExpiresAt: null,
        result: null,
        failureReason: null,
        completedAt: null,
        history: [entry(at, null, 'pending', actorOf(ctx), 'confirmed by the operator')],
      })
    },

    pending: () => outbox.list({ states: ['pending'] }),

    list: (filter) =>
      outbox.list(filter.states === undefined ? {} : { states: filter.states }),

    get: (id) => outbox.get(id),

    claim(input, ctx) {
      const now = ctx.now()
      // Sweeping on claim rather than on a timer: the moment an agent asks for
      // work is exactly when a lapsed claim should be back in the queue, and it
      // needs no scheduler to be correct.
      outbox.expireClaims(now.toISOString())

      const actor = input.claimedBy ?? actorOf(ctx)
      const at = now.toISOString()
      const expiresAt = new Date(now.getTime() + leaseSec * 1000).toISOString()

      const claimed = outbox.claim(
        input.id,
        actor,
        at,
        expiresAt,
        entry(at, 'pending', 'claimed', actor, `lease ${leaseSec}s`),
      )

      if (claimed === null) {
        const current = mustGet(input.id)
        // A losing claimant is normal — two agents polling the same queue — so
        // it gets the current row rather than a bare refusal, and can move on.
        throw conflict(`Action '${input.id}' is already ${current.state}.`, current)
      }

      return claimed
    },

    complete(input, ctx) {
      const action = mustGet(input.id)
      requireClaimant(action, ctx)

      const at = ctx.now().toISOString()
      const done = outbox.transition(
        input.id,
        ['claimed'],
        'complete',
        { result: input.result ?? null, completedAt: at },
        entry(at, 'claimed', 'complete', actorOf(ctx), input.result ?? null),
      )

      if (done === null) throw conflict(`Action '${input.id}' changed underneath you.`, mustGet(input.id))
      return done
    },

    fail(input, ctx) {
      const action = mustGet(input.id)
      requireClaimant(action, ctx)

      const at = ctx.now().toISOString()
      // Terminal, not retried. An automatic retry of a provider write is a
      // second write the operator confirmed once, and XVI says once means once.
      const failed = outbox.transition(
        input.id,
        ['claimed'],
        'failed',
        { failureReason: input.reason, completedAt: at, clearClaim: true },
        entry(at, 'claimed', 'failed', actorOf(ctx), input.reason),
      )

      if (failed === null) throw conflict(`Action '${input.id}' changed underneath you.`, mustGet(input.id))
      return failed
    },

    cancel(input, ctx) {
      const at = ctx.now().toISOString()
      // Only from `pending`. Cancelling a claimed action would mark it stopped
      // while an agent is still executing it, and nothing here can reach into
      // that agent to actually stop it — a false record is worse than a refusal.
      const cancelled = outbox.transition(
        input.id,
        ['pending'],
        'cancelled',
        { completedAt: at },
        entry(at, 'pending', 'cancelled', actorOf(ctx), null),
      )

      if (cancelled === null) {
        const current = mustGet(input.id)
        throw preconditionFailed(
          `Action '${input.id}' is ${current.state}; only a pending action can be cancelled.`,
        )
      }

      return cancelled
    },

    sweep(now) {
      const at = now.toISOString()
      const revived = outbox.expireClaims(at)

      const cutoff = new Date(now.getTime() - ttlSec * 1000).toISOString()
      const expired: string[] = []

      for (const action of outbox.list({ states: ['pending'] })) {
        if (action.confirmedAt > cutoff) continue
        const lapsed = outbox.transition(
          action.id,
          ['pending'],
          'expired',
          { completedAt: at },
          entry(at, 'pending', 'expired', 'system', `unclaimed for ${ttlSec}s`),
        )
        if (lapsed !== null) expired.push(action.id)
      }

      return { revived, expired }
    },
  }
}
