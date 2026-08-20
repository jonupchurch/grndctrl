import { randomUUID } from 'node:crypto'
import { subjectKindOf, type NaturalKey } from '../domain/keys.js'
import type { Prompt } from '../domain/types.js'
import { invalid, notFound } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { PromptFilter, PromptsRepository } from '../store/authored/prompts.js'

/**
 * Prompts worth keeping, so they can be given again (FR-136 to FR-141).
 *
 * Three rules, and two of them are the same rules the rest of 007 follows.
 *
 * 1. **`agentId` comes from `Ctx`, never from the payload.** The panel shows who
 *    recorded a prompt, and a caller that could name its own author could
 *    attribute one to another agent. This is the third operation in this release
 *    to take provenance from the transport, and the reason is unchanged: a
 *    payload is a claim, and `Ctx` is what the adapter observed.
 *
 *    The column is `agent_id` and the operator has no agent id, so a prompt
 *    recorded from the window stores the literal `user`. That collapses the two
 *    fields `active_ticket` keeps separate into one, because the table has one —
 *    the ambiguity it buys is an agent that calls itself `user`, which is a
 *    stranger thing to do than the distinction is worth.
 *
 * 2. **The session and the project are labels, and only their shape is checked.**
 *    Unlike an update, a prompt does not take its author from its session, so a
 *    session that has ended or was never started cleanly is not a reason to
 *    refuse the record — losing the prompt would cost more than the reference is
 *    worth. What is refused is a key that is not a session key at all, which is
 *    a caller's bug rather than a timing accident.
 *
 * 3. **`text` is stored exactly as given.** No trim, no collapse of whitespace,
 *    no bound. FR-138 is that the copy reproduces what was recorded, and every
 *    tidying step here is a difference between the two that nothing would ever
 *    report. Leading indentation in a pasted prompt is part of the prompt.
 *
 * Delete is the operator's alone (FR-140) and the exposure that enforces that is
 * in `registry/ops/prompts.ts`. It is not a correction — there is no edit — it is
 * for the prompt that turned out to have a token in it.
 */

export interface PromptsServiceDeps {
  prompts: PromptsRepository
  /** Overridable so tests get stable ids without stubbing global crypto. */
  newId?(): string
}

export interface RecordPromptInput {
  text: string
  sessionKey?: NaturalKey | undefined
  projectId?: string | null | undefined
}

export interface PromptsService {
  list(filter?: PromptFilter): Prompt[]
  /** The whole prompt. What the shell's clipboard path reads, by id. */
  get(id: string): Prompt
  record(input: RecordPromptInput, ctx: Ctx): Prompt
  remove(id: string): { deleted: boolean }
}

export function promptsService(deps: PromptsServiceDeps): PromptsService {
  const { prompts } = deps
  const newId = deps.newId ?? (() => `prompt:${randomUUID()}`)

  return {
    list(filter?: PromptFilter): Prompt[] {
      return prompts.list(filter)
    },

    get(id): Prompt {
      const prompt = prompts.get(id)
      if (prompt === null) {
        // A missing prompt is `not_found` rather than an empty string, because
        // the caller that matters here is the copy path: an empty clipboard and
        // a successful copy look identical at the paste, which is exactly the
        // silent failure FR-138 forbids.
        throw notFound(`No prompt '${id}'. It may have been deleted or pruned.`)
      }
      return prompt
    },

    record({ text, sessionKey, projectId }, ctx): Prompt {
      if (sessionKey !== undefined && subjectKindOf(sessionKey) !== 'session') {
        throw invalid(
          `A prompt's session must be a session key (session:<agent>/<id>); received '${sessionKey}'.`,
        )
      }

      return prompts.record({
        id: newId(),
        // Exactly as given. See rule 3 above.
        text,
        // See rule 1. `authorKind` is `user` or `agent`, and `authorId` is only
        // set for the latter.
        agentId: ctx.authorId ?? ctx.authorKind,
        sessionKey: sessionKey ?? null,
        projectId: projectId ?? null,
        recordedAt: ctx.now().toISOString(),
      })
    },

    remove(id): { deleted: boolean } {
      // Deleting something that is already gone is not an error — the operator
      // may have pressed twice, or the prune may have reached it first — but the
      // caller is told which it was.
      return { deleted: prompts.remove(id) }
    },
  }
}
