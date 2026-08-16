import { z } from 'zod'
import type { OutboxService } from '../../services/outbox.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema, timestampSchema } from './schemas.js'

/**
 * The outbox as operations — and the only place in the registry where the
 * surfaces deliberately differ.
 *
 * Three entries are `ui-only`, and each is a capability that must originate
 * with the operator rather than with software:
 *
 * - **`mintConfirmation`** issues the single-use token that `enqueue` demands.
 *   Only a UI gesture can produce one, which is what makes "no automatic
 *   dispatch" a property of the wiring rather than a rule to remember (XVI).
 * - **`enqueue`** creates the action. Exposing it on MCP would be a capability
 *   with no purpose — an agent can never hold a token — and T118 requires that
 *   no `grndctrl_enqueue_action` tool exist. Since the conformance gate (T120)
 *   requires every `all` entry to have a tool, enqueue cannot be `all` and also
 *   have no tool; it is `ui-only`.
 * - **`cancel`** withdraws consent, which is the operator's to withdraw.
 *
 * **Deviation from contracts/operations.md**, which says v1 has exactly one
 * non-`all` entry. It has three, for the reason above: one asymmetry could not
 * satisfy both T118 and T120 at once.
 *
 * Everything an agent actually needs — see the queue, take an item, report the
 * outcome — is on every surface.
 */

const actionSchema = z.object({
  id: z.string(),
  subjectKey: z.string(),
  kind: z.enum(['transition-ticket', 'request-review', 'cleanup-workspace', 'investigate']),
  payload: z.record(z.unknown()),
  motivatingFindingId: z.string().nullable(),
  state: z.enum(['pending', 'claimed', 'complete', 'failed', 'expired', 'cancelled']),
  confirmedAt: z.string(),
  confirmedVia: z.string(),
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  claimExpiresAt: z.string().nullable(),
  result: z.string().nullable(),
  failureReason: z.string().nullable(),
  completedAt: z.string().nullable(),
  history: z.array(
    z.object({
      at: z.string(),
      from: z.string().nullable(),
      to: z.string(),
      actor: z.string(),
      detail: z.string().nullable(),
    }),
  ),
})

const actionKindSchema = z.enum([
  'transition-ticket',
  'request-review',
  'cleanup-workspace',
  'investigate',
])

export function outboxOperations(service: OutboxService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'outbox.mintConfirmation',
      description:
        'Issue a single-use token for one specific action. UI only — this is what an operator confirmation is.',
      input: z.object({
        subjectKey: naturalKeySchema,
        kind: actionKindSchema,
        payload: z.record(z.unknown()),
      }),
      output: z.object({ token: z.string(), expiresAt: timestampSchema }),
      exposure: 'ui-only',
      // Not a read. Each call issues a new secret, and replaying it must not be
      // treated as safe.
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.mintConfirmation(input, ctx),
    }),

    defineOperation({
      name: 'outbox.enqueue',
      description: 'Place a confirmed action in the outbox. Requires a matching, unused token.',
      input: z.object({
        subjectKey: naturalKeySchema,
        kind: actionKindSchema,
        payload: z.record(z.unknown()),
        confirmationToken: z.string().min(1),
        motivatingFindingId: z.string().nullable().optional(),
      }),
      output: actionSchema,
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.enqueue(input, ctx),
    }),

    defineOperation({
      name: 'outbox.pending',
      description: 'Actions waiting to be claimed, oldest confirmation first.',
      input: z.object({}),
      output: z.array(actionSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async () => service.pending(),
    }),

    defineOperation({
      name: 'outbox.list',
      description: 'Every action, optionally filtered by state. Includes the full history of each.',
      input: z.object({
        states: z
          .array(z.enum(['pending', 'claimed', 'complete', 'failed', 'expired', 'cancelled']))
          .optional(),
      }),
      output: z.array(actionSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (input) => service.list(input),
    }),

    defineOperation({
      name: 'outbox.claim',
      description:
        'Take an action to execute with your own credentials. Losing the race returns a conflict, which is normal.',
      input: z.object({ id: z.string().min(1) }),
      output: actionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.claim(input, ctx),
    }),

    defineOperation({
      name: 'outbox.complete',
      description: 'Report that a claimed action succeeded. Only the holder of the claim may.',
      input: z.object({ id: z.string().min(1), result: z.string().max(2000).optional() }),
      output: actionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.complete(input, ctx),
    }),

    defineOperation({
      name: 'outbox.fail',
      description:
        'Report that a claimed action failed, with a reason. Terminal — it is not retried automatically.',
      input: z.object({ id: z.string().min(1), reason: z.string().min(1).max(2000) }),
      output: actionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.fail(input, ctx),
    }),

    defineOperation({
      name: 'outbox.cancel',
      description: 'Withdraw a pending action. UI only — consent is the operator’s to withdraw.',
      input: z.object({ id: z.string().min(1) }),
      output: actionSchema,
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.cancel(input, ctx),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
