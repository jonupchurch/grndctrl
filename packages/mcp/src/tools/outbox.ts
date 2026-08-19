import { z } from 'zod'
import type { ToolBinding } from './shared.js'

/**
 * The work queue — and the tool that is deliberately absent from it.
 *
 * **There is no `grndctrl_enqueue_action`, and there must never be one** (T118).
 * An action enters the outbox only when the operator confirms it, through a
 * single-use token that only a UI gesture can mint. The minting operation and
 * the enqueue operation are both `ui-only`, so this file could not offer them
 * even by accident — but the absence is stated here because "add a tool for it"
 * is the obvious thing for a future contributor to do, and the reason it is
 * wrong is not obvious from the code (XVI, FR-059).
 *
 * What an agent gets is the other half: see the queue, take an item, execute it
 * **with its own credentials**, report what happened. Ground Control never
 * performs the write and never holds the authority to.
 */
export const outboxTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_pending_actions',
    operation: 'outbox.pending',
    description:
      'Actions the operator has confirmed and nobody has taken yet, oldest first. Each says what to change and on what. Poll this, or subscribe to grndctrl://outbox/pending to be told. Nothing in the interface currently creates one — the route that did ran through drift, which was removed — so expect this to be empty.',
    inputSchema: {},
    mutates: false,
  },
  {
    tool: 'grndctrl_list_actions',
    operation: 'outbox.list',
    description:
      'Every action with its full history, optionally filtered by state. Useful for seeing whether something you failed earlier was retried by someone else.',
    inputSchema: {
      states: z
        .array(z.enum(['pending', 'claimed', 'complete', 'failed', 'expired', 'cancelled']))
        .optional(),
    },
    mutates: false,
  },
  {
    tool: 'grndctrl_claim_action',
    operation: 'outbox.claim',
    description:
      'Take an action to execute with your own credentials. Only one agent can hold it; losing the race returns a conflict, which is normal — move to the next one. The claim lapses if you do not finish, and the action returns to the queue.',
    inputSchema: { id: z.string() },
    mutates: true,
  },
  {
    tool: 'grndctrl_complete_action',
    operation: 'outbox.complete',
    description:
      'Report that you performed the action. Only the holder of the claim may. Say what you actually did — the operator reads it.',
    inputSchema: { id: z.string(), result: z.string().max(2000).optional() },
    mutates: true,
  },
  {
    tool: 'grndctrl_fail_action',
    operation: 'outbox.fail',
    description:
      'Report that you could not perform the action, with the reason. This is terminal and is not retried automatically — one confirmation authorises one attempt. Reporting a failure is much better than going quiet: the operator can then decide.',
    inputSchema: { id: z.string(), reason: z.string().min(1).max(2000) },
    mutates: true,
  },
]
