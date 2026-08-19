import { z } from 'zod'
import type { WorkItem } from '../../domain/types.js'
import type { CoreServices } from '../../runtime/services.js'
import { envelopeOf } from '../envelope.js'
import { notFound } from '../errors.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * The board, as operations.
 *
 * Every one of these returns provider-derived data, so every one is declared
 * `providerDerived: true` and every output schema is an envelope. That is not a
 * convention here — the registry refuses to register an operation that claims
 * the first without the second, so a handler returning bare work items is a
 * startup failure rather than a board that silently shows hour-old data as
 * though it were current (XIV).
 *
 * The envelope's freshness is per resource kind. That mattered more when a
 * partial sync could leave tickets stale and pull requests fresh; it still holds
 * because the envelope carries a reading per kind rather than one for the board,
 * and 007 adds a second lane with its own.
 */

/**
 * Deliberately loose about the *contents* of a work item.
 *
 * Restating all fourteen entity shapes here would mean two definitions of the
 * domain that must be kept in step, with the second one silently truncating a
 * field it forgot — and truncation at the boundary is the failure mode this
 * codebase can least afford, because it would show as missing data rather than
 * as an error.
 *
 * What the output schema is *for* is the envelope, and that is still fully
 * checked: an operation marked `providerDerived` cannot return work items
 * without their freshness (XIV). The payload's shape is enforced by `WorkItem`
 * in TypeScript, which is where a structural type belongs.
 */
const workItemSchema = z.custom<WorkItem>(
  (v) => typeof v === 'object' && v !== null,
  { message: 'not a work item' },
)

/**
 * `drifting` is removed with the tile it fed, and `lanes` loses two entries.
 *
 * The three counts that stay keep their meanings **exactly**. `yourCourt`,
 * `stalled` and `agentsLive` each count work items or sessions, and both still
 * exist; the numbers they report get smaller because the board is smaller, and
 * the definitions do not move. Re-deriving any of them while in here would be an
 * undocumented product change wearing a removal's clothes.
 */
const summarySchema = z.object({
  total: z.number().int().nonnegative(),
  yourCourt: z.number().int().nonnegative(),
  stalled: z.number().int().nonnegative(),
  agentsLive: z.number().int().nonnegative(),
  lanes: z.object({
    tickets: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
  }),
})

export function workOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'work.list',
      description:
        'Every correlated work item — a ticket, with any agent sessions on it — with per-lane freshness.',
      input: z.object({ projectId: z.string().nullable().optional() }),
      output: envelopeOf(z.array(workItemSchema)),
      exposure: 'all',
      mutates: false,
      providerDerived: true,
      handler: async (input, ctx) => {
        const board = services.board(ctx.now())
        const items =
          input.projectId === undefined || input.projectId === null
            ? board.data.workItems
            : board.data.workItems.filter((w) => w.projectId === input.projectId)

        return { ...board, data: items }
      },
    }),

    defineOperation({
      name: 'work.get',
      description: 'One work item by its natural key.',
      input: z.object({ key: naturalKeySchema }),
      output: envelopeOf(workItemSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: true,
      handler: async (input, ctx) => {
        const board = services.board(ctx.now())
        const item = board.data.workItems.find((w) => w.key === input.key)
        // A key that correlates to nothing is genuinely absent rather than an
        // empty item — an empty row would read as "this work has nothing on it".
        if (item === undefined) throw notFound(`No work item for '${input.key}'.`)
        return { ...board, data: item }
      },
    }),

    defineOperation({
      name: 'board.summary',
      description:
        'The counts across the top of the board: how much is in your court, how much has stalled, and how much has an agent on it.',
      input: z.object({ projectId: z.string().nullable().optional() }),
      output: envelopeOf(summarySchema),
      exposure: 'all',
      mutates: false,
      providerDerived: true,
      handler: async (input, ctx) => {
        const board = services.board(ctx.now())
        const items =
          input.projectId === undefined || input.projectId === null
            ? board.data.workItems
            : board.data.workItems.filter((w) => w.projectId === input.projectId)

        return {
          ...board,
          data: {
            total: items.length,
            yourCourt: items.filter((w) => w.ballInCourt === 'you').length,
            stalled: items.filter((w) => w.staleness === 'stale' || w.staleness === 'abandoned')
              .length,
            // An ended session is history, not a live agent. Counting rows
            // rather than sessions: two agents on one item is still one item
            // being worked on.
            agentsLive: items.filter((w) => w.sessions.some((s) => s.endedAt === null)).length,
            lanes: {
              tickets: items.filter((w) => w.ticket !== null).length,
              sessions: items.filter((w) => w.sessions.length > 0).length,
            },
          },
        }
      },
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
