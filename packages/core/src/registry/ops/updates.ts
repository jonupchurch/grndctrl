import { z } from 'zod'
import type { UpdatesService } from '../../services/updates.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * Agent updates as operations.
 *
 * Both are `all`. An agent reading what another agent said is the point of a
 * shared board, and posting is the whole feature.
 *
 * **The text bound lives here**, at the schema, and that is what makes "terse" a
 * property of the data rather than a hope about agent behaviour (FR-134). An
 * agent that pastes a stack trace gets a validation error naming the limit,
 * rather than a panel with a stack trace in it. The panel is specified to render
 * text, agent and age and nothing else, and it can only honour that if the text
 * is short enough to be one.
 *
 * **There is no `updates.edit` and no `updates.delete`.** An update is a thing
 * that was said. An agent that said something wrong says something else; the
 * operator reads a history, not a status (R5). The absence is the design and not
 * an omission.
 *
 * Not `providerDerived`: an update is authored, has no provider age to carry,
 * and wrapping it in a freshness envelope would attach a number that means
 * nothing.
 */

/** The wire form. `sessionKey` and `ticketKey` are plain strings — brands do not survive JSON. */
const updateSchema = z.object({
  id: z.string(),
  sessionKey: z.string(),
  agentId: z.string(),
  ticketKey: z.string().nullable(),
  text: z.string(),
  postedAt: z.string(),
})

/**
 * Long enough for a sentence about what just happened, short enough that nothing
 * is pasting a diff in. The note body limit is 8000 and is deliberately 20×
 * this: a note is a considered record and an update is a line in a stream.
 */
const MAX_TEXT = 400

export function updatesOperations(service: UpdatesService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'updates.list',
      description:
        'What agents have said, newest first. Read it to catch up on a session without asking.',
      input: z.object({
        sessionKey: naturalKeySchema.optional(),
        // The ticket that was active when each update was posted. A filter over
        // captured history, not a live join -- an update keeps the ticket it was
        // posted against even after focus moves.
        ticketKey: naturalKeySchema.optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
      output: z.array(updateSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (input) => service.list(input),
    }),

    defineOperation({
      name: 'updates.post',
      description:
        'Say what you are doing, in one line, as you do it. Appears on the operator’s board immediately.',
      // `agentId` and `ticketKey` are absent on purpose: both are filled by the
      // service, from the session and from the current focus. An agent supplying
      // either could attribute an update to another agent or to work it was not
      // doing.
      input: z.object({
        sessionKey: naturalKeySchema,
        text: z.string().min(1).max(MAX_TEXT),
      }),
      output: updateSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.post(input, ctx),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
