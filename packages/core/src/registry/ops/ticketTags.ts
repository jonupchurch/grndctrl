import { z } from 'zod'
import type { TicketTagsService } from '../../services/ticketTags.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'
import { ticketTagDefinitionSchema } from '../../services/settings.js'

/**
 * Ticket tags as operations (010). All `all`: an agent that finds a ticket
 * blocked can say so on the board, and since 0.11.0 can create a tag the
 * operator asks for. Renaming, recolouring and removing tags stay in Settings
 * (`settings.update` is `ui-only`).
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

    defineOperation({
      name: 'tags.define',
      description:
        'Create a ticket tag, with a colour or one picked for it. A tag with the same name is returned rather than duplicated. Renaming and removing are in Settings.',
      input: z.object({
        label: ticketTagDefinitionSchema.shape.label,
        color: ticketTagDefinitionSchema.shape.color.optional(),
      }),
      output: z.object({ definition: definitionSchema, created: z.boolean() }),
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input) => service.define(input),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
