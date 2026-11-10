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
    tool: 'grndctrl_define_tag',
    operation: 'tags.define',
    description:
      'Create a ticket tag when the operator asks for one. Give a colour as #rrggbb, or omit it and one is picked. A tag with the same name already existing is returned instead of a duplicate. You cannot rename or remove tags; the operator does that in Settings.',
    inputSchema: {
      label: z
        .string()
        .min(1)
        .max(24)
        .describe('The tag name, as the operator gave it. At most 24 characters.'),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional()
        .describe('#rrggbb. Omit to have one picked.'),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_set_tag',
    operation: 'tags.set',
    description:
      'Put a tag on a ticket, replacing the one it had, or clear it with tagId null. A ticket carries at most one tag. Use an id from grndctrl_list_tags, or from grndctrl_define_tag if the operator asked for a new tag.',
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
