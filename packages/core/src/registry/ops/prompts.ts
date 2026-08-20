import { z } from 'zod'
import type { PromptsService } from '../../services/prompts.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * Recorded prompts as operations.
 *
 * **`prompts.delete` is `ui-only`, and it is the only one that is a privilege
 * question** (FR-140). Curating the operator's own history is not an agent's
 * business: the reason a prompt gets deleted is that it contains something the
 * operator would rather not keep, and an agent that could delete one could
 * remove the record of what it was told to do. `record` and `list` are `all`,
 * because recording is the whole feature and reading back what was recorded is
 * how an agent picks up where another left off.
 *
 * **There are four here and the tasks file says three.** The fourth is
 * `prompts.get`, which exists because the shell's copy channel takes a prompt
 * *id* and has to read the text from somewhere (FR-139) — main holds no store
 * and reaches core the same way every other adapter does. It is `ui-only` for a
 * reason that is about surface design rather than privilege, and worth being
 * plain about: everything it returns is already in `prompts.list`, so a tool for
 * it would put a choice in an agent's tool list where there is no decision to
 * make. Nothing is being withheld from agents here.
 *
 * **There is no `prompts.edit`.** A recorded prompt is what was sent; editing
 * one would make the copy button reproduce something that never was. Delete and
 * record again is the honest shape.
 *
 * Not `providerDerived`: a prompt is authored, has no provider age to carry, and
 * a freshness envelope round it would attach a number that means nothing.
 */

/** The wire form. `sessionKey` is a plain string — brands do not survive JSON. */
const promptSchema = z.object({
  id: z.string(),
  text: z.string(),
  agentId: z.string(),
  sessionKey: z.string().nullable(),
  projectId: z.string().nullable(),
  recordedAt: z.string(),
})

/**
 * A ceiling, not a truncation — and the difference is the whole of FR-138.
 *
 * Something has to stop a caller writing a hundred megabytes into a local
 * database over a loopback socket. What that something must never do is quietly
 * shorten the text, because the failure would surface at the paste, days later,
 * as a prompt that stops mid-sentence. So this refuses, loudly, at the boundary,
 * and nothing anywhere below it trims.
 *
 * Twelve times the note body limit. A prompt is a thing somebody pasted; a note
 * is a thing somebody wrote.
 */
const MAX_TEXT = 100_000

export function promptsOperations(service: PromptsService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'prompts.list',
      description:
        'Prompts that were recorded, newest first. Read it to see how work like this was asked for before.',
      // `null` reads as "every project", matching `work.list`. It is not "the
      // prompts with no project": nothing asks that question, and a filter whose
      // meaning depended on null-versus-absent would be a trap for every caller
      // that passes a nullable variable straight through.
      input: z.object({
        sessionKey: naturalKeySchema.optional(),
        projectId: z.string().nullable().optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
      // The full text, not a preview. The store does not truncate and neither
      // does this; the panel truncates a row, which is a fact about a row.
      output: z.array(promptSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async ({ projectId, ...rest }) =>
        service.list({ ...rest, ...(projectId === null ? {} : { projectId }) }),
    }),

    defineOperation({
      name: 'prompts.get',
      description: 'One recorded prompt, whole. The read behind the interface’s copy control.',
      input: z.object({ id: z.string().min(1) }),
      output: promptSchema,
      exposure: 'ui-only',
      mutates: false,
      providerDerived: false,
      handler: async ({ id }) => service.get(id),
    }),

    defineOperation({
      name: 'prompts.record',
      description:
        'Keep a prompt so the operator can send it again. Who recorded it comes from the caller, not from this payload.',
      // No `agentId` field, on purpose: it is stamped from `Ctx`. An agent that
      // could name its own author could attribute a prompt to another one, and
      // the panel renders that name.
      input: z.object({
        text: z.string().min(1).max(MAX_TEXT),
        sessionKey: naturalKeySchema.optional(),
        projectId: z.string().nullable().optional(),
      }),
      output: promptSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.record(input, ctx),
    }),

    defineOperation({
      name: 'prompts.delete',
      description: 'Remove a recorded prompt. The operator’s own history; the interface only.',
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ deleted: z.boolean() }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async ({ id }) => service.remove(id),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
