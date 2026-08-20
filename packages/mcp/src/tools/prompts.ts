import { z } from 'zod'
import { projectId, subjectKey, type ToolBinding } from './shared.js'

/**
 * Prompts, kept so the operator can send one again (FR-136).
 *
 * **What this is for is easy to get wrong, so the description says it twice.**
 * A model reading "record a prompt" will reasonably conclude it should record
 * every prompt it receives, which fills a two-hundred-row list with a
 * conversation and pushes out the handful of things worth keeping. The panel is
 * titled "recent prompts" and its value is that the operator can grab one and
 * send it somewhere else — so the thing to record is a prompt that *worked*, or
 * one they will want again, not a transcript.
 *
 * **There is no delete here and that is the point** (FR-140). `prompts.delete`
 * is `ui-only`: the reason a prompt gets removed is that it turned out to hold
 * something the operator would rather not keep, and curating that history is
 * theirs. An agent that could delete a prompt could remove the record of what it
 * was told to do.
 *
 * There is no edit anywhere, on any surface. A recorded prompt is what was sent;
 * a corrected one would make the copy button reproduce something that never was.
 *
 * Authored records, not provider writes, so gate XVI is not engaged.
 */
export const promptsTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_record_prompt',
    operation: 'prompts.record',
    description:
      'Keep a prompt the operator may want to send again — one that worked, or one worth reusing on similar work. It appears in their Recent prompts panel and one click copies it whole. Record the prompt itself, not a summary of it, and record it because it is worth keeping rather than on every turn: the list is bounded and a transcript pushes out the things worth having.',
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(100_000)
        .describe(
          'The prompt, exactly as it should be sent again. Stored and copied whole — nothing here truncates, so send the complete text rather than an abridged one.',
        ),
      sessionKey: subjectKey
        .optional()
        .describe(
          'Your session, as session:<agent>/<id>. A label only — the prompt is kept whether or not the session is still running.',
        ),
      projectId,
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_list_prompts',
    operation: 'prompts.list',
    description:
      'Prompts that were recorded, newest first, with their full text. Read this before starting work of a kind that has been done here before — it is the closest thing to a record of how the operator asks for things.',
    inputSchema: {
      sessionKey: subjectKey.optional().describe('Limit to one session. Omit for everything.'),
      projectId,
      limit: z.number().int().positive().max(200).optional(),
    },
    mutates: false,
  },
]
