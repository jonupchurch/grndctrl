import { z } from 'zod'
import { evidenceHash } from '../../drift/id.js'
import type { CoreServices } from '../../runtime/services.js'
import { envelopeOf } from '../envelope.js'
import { notFound } from '../errors.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'

/**
 * Drift findings, and dismissing them.
 *
 * A dismissal is stored against the finding's id and a hash of its *evidence*,
 * not against a timestamp. That is what makes "not now" mean not now rather
 * than never: the dismissal lapses when the situation changes, and survives a
 * sync that merely re-observes the same disagreement (FR-038).
 *
 * The hash is computed here from the live finding rather than accepted from the
 * caller. A caller-supplied hash would let a stale UI dismiss a finding as it
 * looked five minutes ago and suppress the version the operator never saw.
 *
 * **Dismissing is `ui-only`.** Reading findings is not — an agent should see
 * what disagrees, and often caused it. But dismissal hides a finding from the
 * operator's Attention list, and an agent that could hide its own drift is an
 * agent that can suppress the evidence of its own mistake. That has nothing to
 * do with provider writes, so XVI does not cover it; the exposure does.
 */

const findingSchema = z.object({
  id: z.string(),
  rule: z.enum(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']),
  subjectKey: z.string(),
  projectId: z.string().nullable(),
  summary: z.string(),
  evidence: z.array(
    z.object({
      side: z.string(),
      fact: z.string(),
      at: z.string().nullable(),
    }),
  ),
  ageSec: z.number().int().nonnegative(),
  suggestedAction: z
    .object({
      kind: z.enum(['transition-ticket', 'request-review', 'cleanup-workspace', 'investigate']),
      label: z.string(),
    })
    .nullable(),
  dispatchable: z.boolean(),
})

export function driftOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'drift.list',
      description:
        'Disagreements between the systems — a merged PR against an open ticket, a branch with no ticket, and seven more. Each carries both sides of its evidence.',
      input: z.object({ projectId: z.string().nullable().optional() }),
      output: envelopeOf(z.array(findingSchema)),
      exposure: 'all',
      mutates: false,
      // Every finding is a claim about provider data, so it is only meaningful
      // alongside how old that data is. A drift finding computed from a
      // six-hour-old mirror is a six-hour-old finding.
      providerDerived: true,
      handler: async (input, ctx) => {
        const board = services.board(ctx.now())
        const findings =
          input.projectId === undefined || input.projectId === null
            ? board.data.findings
            : board.data.findings.filter((f) => f.projectId === input.projectId)

        return { ...board, data: findings }
      },
    }),

    defineOperation({
      name: 'drift.dismiss',
      description:
        'Set a finding aside. It returns on its own if the evidence changes — this is "not now", not "never".',
      input: z.object({ findingId: z.string().min(1) }),
      output: z.object({
        findingId: z.string(),
        dismissedAt: z.string(),
        evidenceHash: z.string(),
      }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => {
        const now = ctx.now()
        const finding = services
          .board(now)
          .data.findings.find((f) => f.id === input.findingId)

        // Dismissing something that is not currently raised would write a
        // dismissal that can never lapse, because there is no evidence to
        // compare against later.
        if (finding === undefined) {
          throw notFound(`No finding '${input.findingId}' is currently raised.`)
        }

        return services.dismissals.dismiss(
          finding.id,
          now.toISOString(),
          evidenceHash(finding),
        )
      },
    }),

    defineOperation({
      name: 'drift.undismiss',
      description: 'Bring a dismissed finding back.',
      input: z.object({ findingId: z.string().min(1) }),
      output: z.object({ findingId: z.string(), removed: z.boolean() }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input) => ({
        findingId: input.findingId,
        // Not an error when there was nothing to remove: undismissing something
        // that already lapsed on its own is the same outcome the caller wanted.
        removed: services.dismissals.undismiss(input.findingId),
      }),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
