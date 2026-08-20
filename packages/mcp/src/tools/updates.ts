import { z } from 'zod'
import { subjectKey, type ToolBinding } from './shared.js'

/**
 * Agent updates — what an agent says while it works.
 *
 * **The description below has one job and it is a hard one: there are now four
 * things in this neighbourhood and a model has to be able to pick.**
 *
 * - `grndctrl_heartbeat` — "the process is alive". Sent on a timer. Says nothing
 *   about work.
 * - `grndctrl_report_activity` — "work happened". Advances the activity clock,
 *   which is what stops a stuck agent looking busy. Machine-facing: it moves a
 *   colour on a panel.
 * - `reportedStatus`, on a session — "what I am doing", one line, **overwritten**
 *   each time. The current state, not a record.
 * - **`grndctrl_post_update`** — "here is something worth reading". Appended,
 *   kept, and shown to the operator as a stream.
 *
 * The distinction that actually decides it: a status is *replaced* and an update
 * is *added*. An agent that posts an update every thirty seconds has written a
 * log nobody asked for; an agent that only overwrites its status has left the
 * operator with the last thing it said and no idea it said anything else.
 *
 * These are authored records, not provider writes, so gate XVI is not engaged.
 */
export const updatesTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_post_update',
    operation: 'updates.post',
    description:
      'Tell the operator something worth reading — a decision made, a surprise found, a direction changed. Kept and shown as a stream, so post when there is news, not on a timer. For "I am alive" use grndctrl_heartbeat; for "work happened" use grndctrl_report_activity; to change the one-line summary of what you are doing now, set reportedStatus on your session.',
    inputSchema: {
      sessionKey: subjectKey.describe(
        'Your session, as session:<agent>/<id>. Who posted this is taken from it — you cannot post as another agent.',
      ),
      text: z
        .string()
        .min(1)
        .max(400)
        .describe('One or two sentences. The limit is deliberate: the panel shows text and nothing else.'),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_list_updates',
    operation: 'updates.list',
    description:
      'What agents have said, newest first. Read this when picking up work someone else started — it is the fastest way to find out what was already tried.',
    inputSchema: {
      sessionKey: subjectKey.optional().describe('Limit to one session. Omit for everything.'),
      ticketKey: subjectKey
        .optional()
        .describe('Updates posted while this ticket was active. Captured at post time, not a live lookup.'),
      limit: z.number().int().positive().max(200).optional(),
    },
    mutates: false,
  },
]
