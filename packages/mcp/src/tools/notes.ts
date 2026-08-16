import { z } from 'zod'
import { subjectKey, type ToolBinding } from './shared.js'

/**
 * Notes — the one thing on this surface an agent can leave behind for a human.
 *
 * Two things worth an agent knowing, and both are in the descriptions because
 * that is where a model will read them:
 *
 * - A `question-for-human` note is not a comment. It puts the work item in the
 *   operator's court and marks the session "needs you". It is the mechanism for
 *   stopping and asking, and it should be used when stopping and asking is the
 *   right thing to do.
 * - Editing requires the revision you read. A stale revision is rejected with
 *   the current text attached, and the correct response is to show both — never
 *   to re-send with the new revision, which would overwrite whatever the
 *   operator just wrote.
 */
export const notesTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_list_notes',
    operation: 'notes.list',
    description:
      'Notes attached to a ticket, pull request, branch, workspace or session — decisions, gotchas, to-dos and open questions, from both the operator and other agents. Read these before starting work on something.',
    inputSchema: { subjectKey },
    mutates: false,
  },
  {
    tool: 'grndctrl_list_questions',
    operation: 'notes.questions',
    description:
      'Every unresolved question waiting on the operator. Check before asking a new one — it may already have been asked.',
    inputSchema: {},
    mutates: false,
  },
  {
    tool: 'grndctrl_count_notes',
    operation: 'notes.counts',
    description:
      'How many notes each subject has, for many subjects in one call. Use it to find out which rows are worth reading notes on before fetching them.',
    inputSchema: {
      subjectKeys: z.array(subjectKey).max(1000),
    },
    mutates: false,
  },
  {
    tool: 'grndctrl_add_note',
    operation: 'notes.create',
    description:
      'Attach a note. Use "question-for-human" when you are blocked on the operator — it moves the item into their court and marks your session as needing them. Use "decision" for a choice made and why, "gotcha" for something the next person will trip on, "todo" for follow-up work.',
    inputSchema: {
      subjectKey,
      type: z.enum(['decision', 'gotcha', 'question-for-human', 'todo']),
      body: z.string().min(1).max(8000),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_update_note',
    operation: 'notes.update',
    description:
      'Edit a note, or resolve a question with `resolved: true`. Pass the revision you read. If it comes back as a conflict, someone edited it after you read it — show both versions rather than re-sending, or you will destroy their edit.',
    inputSchema: {
      id: z.string(),
      revision: z.number().int().positive().describe('The revision you read. Required.'),
      body: z.string().min(1).max(8000).optional(),
      type: z.enum(['decision', 'gotcha', 'question-for-human', 'todo']).optional(),
      resolved: z.boolean().optional().describe('Settle a question without deleting the exchange.'),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_delete_note',
    operation: 'notes.delete',
    description:
      'Delete a note. Requires the revision you read, for the same reason an edit does. Prefer resolving a question over deleting it — the answer is usually worth keeping.',
    inputSchema: { id: z.string(), revision: z.number().int().positive() },
    mutates: true,
  },
]
