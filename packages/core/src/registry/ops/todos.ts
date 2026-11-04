import { z } from 'zod'
import type { TodosService } from '../../services/todos.js'
import { MAX_TODO_TEXT } from '../../services/todos.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * The to-do list as operations (009).
 *
 * `list`, `create` and `update` are `all`: an agent can add items it finds,
 * tick off ones it finishes, and link them to the ticket they belong to.
 * `delete` is `ui-only` — removing an item is the operator's call, and a
 * ticked-off item is already out of the way.
 *
 * Authored, not provider-derived, so no freshness envelope.
 */

const todoSchema = z.object({
  id: z.string(),
  text: z.string(),
  ticketKey: z.string().nullable(),
  issueKey: z.string().nullable(),
  doneAt: z.string().nullable(),
  authorKind: z.enum(['user', 'agent']),
  authorId: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export function todosOperations(service: TodosService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'todos.list',
      description:
        'The to-do list: open items first, then finished ones, oldest first within each. Narrow to one ticket with ticketKey.',
      input: z.object({
        ticketKey: naturalKeySchema.optional(),
        state: z.enum(['open', 'done', 'all']).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
      output: z.array(todoSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (input) => service.list(input),
    }),

    defineOperation({
      name: 'todos.create',
      description: 'Add a to-do, optionally linked to a ticket.',
      input: z.object({
        text: z.string().min(1).max(MAX_TODO_TEXT),
        ticketKey: naturalKeySchema.nullable().optional(),
      }),
      output: todoSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.create(input, ctx),
    }),

    defineOperation({
      name: 'todos.update',
      description:
        'Edit a to-do, link or unlink its ticket, or tick it off / reopen it. Requires the revision you read.',
      input: z.object({
        id: z.string().min(1),
        revision: z.number().int().positive(),
        text: z.string().min(1).max(MAX_TODO_TEXT).optional(),
        ticketKey: naturalKeySchema.nullable().optional(),
        done: z.boolean().optional(),
      }),
      output: todoSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.update(input, ctx),
    }),

    defineOperation({
      name: 'todos.delete',
      description: 'Remove a to-do. Requires the revision you read. The interface only.',
      input: z.object({
        id: z.string().min(1),
        revision: z.number().int().positive(),
      }),
      output: z.object({ id: z.string() }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input) => service.remove(input),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
