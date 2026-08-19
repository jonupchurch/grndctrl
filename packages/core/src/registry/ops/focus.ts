import { z } from 'zod'
import type { FocusService } from '../../services/focus.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { activeTicketSchema, naturalKeySchema } from './schemas.js'

/**
 * The active ticket as operations.
 *
 * **All three are `all`, and `focus.set` is the one that must not be
 * `ui-only`.** The operator's brief for this feature was "populated by MCP":
 * an agent picking up a ticket says so, and the panel follows it. Parking this
 * on `settings` would have been less code and would have made it unreachable,
 * because `settings.update` is `ui-only` — which is correct for a preference and
 * wrong for this. That is the whole reason this is a registry addition rather
 * than a field (R3).
 *
 * `focus.clear` is `all` for the symmetric reason: an agent that finishes should
 * be able to put the board down. The asymmetry that would be worth defending is
 * an agent that can take focus but not release it, and there isn't one.
 *
 * **None of the three is `providerDerived`.** The pointer is authored — it
 * survives a mirror rebuild and has no provider age to carry. The *ticket* it
 * names is provider-derived and arrives through `work.list` inside its own
 * envelope, which is why the panel composes two reads rather than one, and why
 * "the mirror does not hold this ticket" (FR-131) is a state that can be
 * expressed at all.
 *
 * **`mutates` is true on set and clear, and gate XVI is still not engaged.**
 * Both write one local row. Neither transitions a ticket, comments on one, or
 * reaches Jira, so there is no confirmation token here and there should not be.
 */
export function focusOperations(service: FocusService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'focus.get',
      description: 'The ticket currently being worked, or null. Read this to find out what to work on.',
      input: z.object({}),
      output: activeTicketSchema.nullable(),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async () => service.get(),
    }),

    defineOperation({
      name: 'focus.set',
      // Written for a model deciding *whether* to call it. "Sets the active
      // ticket" is what it does and tells a reader nothing about when.
      description:
        'Declare which ticket is being worked now, when you start on one. Replaces any previous ' +
        'one; the key need not have been synced yet.',
      // Any subject key parses here; the ticket narrowing is in the service, so
      // that a session key comes back with a message naming the mistake rather
      // than the generic "not a recognised subject key".
      input: z.object({ ticketKey: naturalKeySchema }),
      output: activeTicketSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.set(input, ctx),
    }),

    defineOperation({
      name: 'focus.clear',
      description: 'Put the board down when the work is finished or abandoned. Safe if nothing is set.',
      input: z.object({}),
      output: z.object({ cleared: z.boolean() }),
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async () => service.clear(),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
