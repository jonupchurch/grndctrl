import { z } from 'zod'
import { subjectKey, type ToolBinding } from './shared.js'

/**
 * Ticket tags (010). The operator defines the tags in settings; an agent reads
 * them and puts one on a ticket — "Blocked" when it hits something it cannot
 * get past, for example.
 */
export const tagsTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_list_tags',
    operation: 'tags.list',
    description:
      'The tags the operator has defined for tickets (id, label, colour), and which ticket carries which. Read it to find the tag id grndctrl_set_tag needs.',
    inputSchema: {},
    mutates: false,
  },
  {
    tool: 'grndctrl_set_tag',
    operation: 'tags.set',
    description:
      "Put a tag on a ticket, replacing the one it had, or clear it with tagId null. A ticket carries at most one tag. Use the operator's tags only — the ids from grndctrl_list_tags.",
    inputSchema: {
      ticketKey: subjectKey.describe('The ticket, as jira:<site>/<ISSUE-KEY>.'),
      tagId: z
        .string()
        .min(1)
        .nullable()
        .describe('A tag id from grndctrl_list_tags, or null to clear the tag.'),
    },
    mutates: true,
  },
]
