import { z } from 'zod'
import type { NotesService } from '../../services/notes.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema, noteSchema, noteTypeSchema } from './schemas.js'

/**
 * Notes as operations.
 *
 * All six are exposed on every surface. That is the point of gate XII and it is
 * also the product decision: notes are readable and writable by both the
 * operator and agents (FR-054), so a capability the UI has and MCP does not
 * would be a bug, not a safeguard.
 *
 * The safeguard that *does* exist is narrower and lives in the handler: nothing
 * here reads an author from the payload. `authorKind` and `authorId` come from
 * `ctx`, which the adapter stamps from the transport it answered on. An agent
 * can write anything it likes into a note body; it cannot sign it as the user.
 *
 * Notes are not `providerDerived`. A note is the operator's own text and has no
 * provider age to carry — wrapping it in a freshness envelope would attach a
 * number that means nothing. The one mirror-dependent fact it does carry,
 * `subjectPresence`, is three-valued precisely so an unsynced mirror reports
 * `unknown` rather than declaring every note orphaned.
 */
export function notesOperations(service: NotesService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'notes.list',
      description: 'List every note attached to a subject, including orphaned ones.',
      input: z.object({ subjectKey: naturalKeySchema }),
      output: z.array(noteSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async ({ subjectKey }) => service.list(subjectKey),
    }),

    defineOperation({
      name: 'notes.counts',
      description: 'Note counts for many subjects at once, for a lane of row badges.',
      // Capped rather than unbounded: this builds one `IN (...)` per call, and
      // an agent asking for fifty thousand keys should get a validation error
      // rather than a query planner's opinion.
      input: z.object({ subjectKeys: z.array(naturalKeySchema).max(1000) }),
      output: z.record(z.number().int().nonnegative()),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async ({ subjectKeys }) => service.counts(subjectKeys),
    }),

    defineOperation({
      name: 'notes.questions',
      description: 'Every unresolved question-for-human note. These are the Attention nudges.',
      // **Deviation from contracts/operations.md**, which takes `{ projectId? }`.
      // Resolving a subject key to a project is correlation's job and nothing
      // else's; doing it here would put a second copy of that mapping in the
      // codebase, and the two would disagree. Attention filters by project from
      // the board, which already knows. An agent asking gets all of them, which
      // is the right answer for an agent.
      input: z.object({}),
      output: z.array(noteSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async () => service.questions(),
    }),

    defineOperation({
      name: 'notes.create',
      description: 'Attach a new note to a ticket, pull request, branch, workspace, or session.',
      input: z.object({
        subjectKey: naturalKeySchema,
        type: noteTypeSchema,
        body: z.string().min(1).max(8000),
      }),
      output: noteSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.create(input, ctx),
    }),

    defineOperation({
      name: 'notes.update',
      description:
        'Edit a note. Requires the revision you read; a stale revision is rejected as a conflict.',
      input: z.object({
        id: z.string().min(1),
        // Required, not optional. An optional revision would be omitted by every
        // caller in a hurry, and optimistic concurrency you can opt out of is
        // last-write-wins with extra steps (FR-055).
        revision: z.number().int().positive(),
        body: z.string().min(1).max(8000).optional(),
        type: noteTypeSchema.optional(),
        resolved: z.boolean().optional(),
      }),
      output: noteSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.update(input, ctx),
    }),

    defineOperation({
      name: 'notes.delete',
      description: 'Delete a note. Requires the revision you read.',
      input: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
      output: z.object({ id: z.string() }),
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.remove(input, ctx),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
