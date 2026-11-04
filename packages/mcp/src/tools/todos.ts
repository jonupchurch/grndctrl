import { z } from 'zod'
import { subjectKey, type ToolBinding } from './shared.js'

/**
 * The to-do list (009).
 *
 * The operator's list, shared with agents. An agent adds an item when it finds
 * work that should not be lost but is not its to do right now, and ticks one
 * off when it finishes it. Deleting is the operator's (`todos.delete` is
 * `ui-only`).
 */
export const todosTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_add_todo',
    operation: 'todos.create',
    description:
      "Add an item to the operator's to-do list. Use it for follow-up work you found but are not doing now, or when the operator asks you to note something down. Link it to a ticket when it belongs to one.",
    inputSchema: {
      text: z
        .string()
        .min(1)
        .max(500)
        .describe('One line saying what needs doing. A line break is refused.'),
      ticketKey: subjectKey
        .nullable()
        .optional()
        .describe(
          'The ticket it belongs to, as jira:<site>/<ISSUE-KEY>. Omit for a free-standing to-do.',
        ),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_list_todos',
    operation: 'todos.list',
    description:
      "The operator's to-do list, open items first. Read it before adding one, so you do not add a duplicate, and to find the id and revision an update needs.",
    inputSchema: {
      ticketKey: subjectKey.optional().describe('Only to-dos linked to this ticket.'),
      state: z
        .enum(['open', 'done', 'all'])
        .optional()
        .describe('Which items: open (the default), done, or all.'),
      limit: z.number().int().positive().max(1000).optional(),
    },
    mutates: false,
  },
  {
    tool: 'grndctrl_update_todo',
    operation: 'todos.update',
    description:
      'Tick a to-do off (done: true), reopen it (done: false), reword it, or link it to a ticket (ticketKey, or null to unlink). Requires the revision you read; a stale revision is refused with the current item.',
    inputSchema: {
      id: z.string().describe('The to-do id, from grndctrl_list_todos.'),
      revision: z.number().int().positive().describe('The revision you read.'),
      text: z.string().min(1).max(500).optional(),
      ticketKey: subjectKey.nullable().optional(),
      done: z.boolean().optional(),
    },
    mutates: true,
  },
]
