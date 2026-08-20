import { z } from 'zod'
import type { HistoryService } from '../../services/history.js'
import { MAX_LINE, MAX_NOTES_CHUNK, MAX_NOTES_TOTAL } from '../../services/history.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * The ticket history as operations (008).
 *
 * **Five, and the split between them is a privilege decision made twice.**
 * `list`, `get` and `record` are `all`: an agent that has just finished a piece
 * of work is the one caller in a position to say what was done, and one that is
 * about to start needs to read what happened last time. That is the feature.
 *
 * `revise` and `delete` are `ui-only`, on the same argument `prompts.delete`
 * makes and a stronger version of it. The operator asked for a *curated* history
 * — the correcting and the removing are the curation, and an agent that could
 * rewrite an entry could quietly restate what it did, on the one record kept
 * specifically to answer questions about it later. Recording is additive and
 * visible; revising is neither.
 *
 * Note what `record` cannot do as a consequence: it cannot shorten the notes,
 * because it can only append. The one path that removes text from this table is
 * the operator's.
 *
 * Not `providerDerived`. The entry is authored — the ticket summary on it is a
 * snapshot taken at write time, not a provider read, and wrapping it in a
 * freshness envelope would attach an age to a fact that has none.
 */

/** The wire form. `ticketKey` is a plain string — brands do not survive JSON. */
const entrySchema = z.object({
  ticketKey: z.string(),
  // Derived from the key by the service, never stored — the entry outlives the
  // mirrored ticket that every other surface reads `issueKey` from.
  issueKey: z.string().nullable(),
  line: z.string(),
  notes: z.string().nullable(),
  ticketSummary: z.string().nullable(),
  authorKind: z.enum(['user', 'agent']),
  authorId: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export function historyOperations(service: HistoryService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'history.list',
      description:
        'The ticket history — one curated line per ticket, most recently written first. Read it to find out what was done about something before.',
      input: z.object({
        // Matched against the key, the line and the notes at once. One field
        // rather than three, because the operator's question is "what did we do
        // about X" and X is as likely to be a word as an issue key.
        q: z.string().max(200).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
      output: z.array(entrySchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (input) => service.list(input),
    }),

    defineOperation({
      name: 'history.get',
      description: 'The history entry for one ticket. Answers not_found when nothing was written.',
      input: z.object({ ticketKey: naturalKeySchema }),
      output: entrySchema,
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async ({ ticketKey }) => service.get(ticketKey),
    }),

    defineOperation({
      name: 'history.record',
      description:
        "Write what was done on a ticket. Replaces the ticket's line and adds to its notes; never removes anything.",
      // No author field, on purpose: it is stamped from `Ctx`, like every other
      // authored write in this product.
      input: z.object({
        ticketKey: naturalKeySchema,
        // The single-line rule is enforced in the service rather than with a
        // regex here, so the refusal can say *where the paragraph goes*. A schema
        // message cannot, and this is the one error a model needs to learn from.
        line: z.string().min(1).max(MAX_LINE),
        notes: z.string().max(MAX_NOTES_CHUNK).optional(),
      }),
      output: entrySchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.record(input, ctx),
    }),

    defineOperation({
      name: 'history.revise',
      description:
        'Rewrite an entry whole, including shortening or clearing its notes. The operator’s curation; the interface only.',
      input: z.object({
        ticketKey: naturalKeySchema,
        // Required, not optional — the same argument `notes.update` makes. An
        // optional revision is omitted by every caller in a hurry, and
        // optimistic concurrency you can opt out of is last-write-wins.
        revision: z.number().int().positive(),
        line: z.string().min(1).max(MAX_LINE).optional(),
        // Nullable: `null` clears the notes, which is the only way to undo an
        // append. Absent leaves them alone.
        notes: z.string().max(MAX_NOTES_TOTAL).nullable().optional(),
      }),
      output: entrySchema,
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.revise(input, ctx),
    }),

    defineOperation({
      name: 'history.delete',
      description: 'Remove a ticket’s history entry. Requires the revision you read.',
      input: z.object({
        ticketKey: naturalKeySchema,
        revision: z.number().int().positive(),
      }),
      output: z.object({ ticketKey: z.string() }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input) => service.remove(input),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
