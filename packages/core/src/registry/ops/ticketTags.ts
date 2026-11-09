import { z } from 'zod'
import type { TicketTagsService } from '../../services/ticketTags.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * Ticket tags as operations (010). Both `all`: an agent that finds a ticket
 * blocked can say so on the board. Defining the tags themselves is a setting,
 * and settings are the operator's (`settings.update` is `ui-only`).
 */

const definitionSchema = z.object({ id: z.string(), label: z.string(), color: z.string() })

const tagSchema = z.object({
  ticketKey: z.string(),
  issueKey: z.string(),
  tagId: z.string(),
  label: z.string(),
  color: z.string(),
  authorKind: z.enum(['user', 'agent']),
  authorId: z.string().nullable(),
  updatedAt: z.string(),
})

export function ticketTagsOperations(service: TicketTagsService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'tags.list',
      description: 'The tags a ticket can carry, and every ticket that carries one.',
      input: z.object({}),
      output: z.object({ definitions: z.array(definitionSchema), tags: z.array(tagSchema) }),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async () => service.list(),
    }),

    defineOperation({
      name: 'tags.set',
      description: 'Put a tag on a ticket, replacing any it had, or clear it with tagId null.',
      input: z.object({
        ticketKey: naturalKeySchema,
        tagId: z.string().min(1).nullable(),
      }),
      output: tagSchema.nullable(),
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.set(input, ctx),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
