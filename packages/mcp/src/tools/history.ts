import { z } from 'zod'
import { subjectKey, type ToolBinding } from './shared.js'

/**
 * The ticket history (008/FR-146).
 *
 * ## The description has to say what a *line* is, or it will get paragraphs
 *
 * This is the same failure `grndctrl_record_prompt` was written against, one
 * step worse. A model handed a field called `line` and a field called `notes`
 * will put a summary in both unless it is told what each is for, and the value
 * of this region is entirely that a hundred entries can be read down a column in
 * ten seconds. So the description names the reader (somebody asking months
 * later), the length (one sentence), and where the paragraph goes.
 *
 * ## Record, not append-a-note
 *
 * The tool is *upsert* and says so: recording twice against a ticket rewrites
 * the line and adds to the notes. A model that believes it is creating a new
 * entry each time will write "continued from before" into a field that is not
 * a stream, and one that believes it is overwriting will re-state the whole
 * history in every call.
 *
 * ## There is no revise and no delete here, and that is the curation
 *
 * `history.revise` and `history.delete` are `ui-only`. The operator asked for a
 * *curated* record; correcting and removing is what curating is, and an agent
 * that could rewrite an entry could restate what it did on the one record kept
 * to answer questions about it later. Recording is additive and visible.
 *
 * Authored records, not provider writes, so gate XVI is not engaged.
 */
export const historyTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_record_ticket_history',
    operation: 'history.record',
    description:
      'Record what was done on a ticket, for the operator to read back months later. Call it when a piece of work is finished, not while it is in progress — this is the durable record, not a status update (use grndctrl_post_update for those). Recording again against the same ticket replaces the line and adds to the notes, so state where the ticket now stands rather than repeating what is already there.',
    inputSchema: {
      ticketKey: subjectKey.describe(
        'The ticket, as jira:<site>/<ISSUE-KEY>, where <site> is the full host. Tickets only.',
      ),
      line: z
        .string()
        .min(1)
        .max(200)
        .describe(
          'One sentence on one line: what was done and where it now stands. This is the whole of what the operator sees in the list, so make it the thing they would need to recognise this ticket a year from now. A line break is refused — put anything longer in notes.',
        ),
      notes: z
        .string()
        .max(8_000)
        .optional()
        .describe(
          'The detail: decisions, what went wrong, what to know before touching it again. Added to whatever is already there rather than replacing it, so write only what is new. Paragraphs are fine here.',
        ),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_list_ticket_history',
    operation: 'history.list',
    description:
      'The curated ticket history, most recently written first — one line per ticket, with the notes. Read it before starting work that touches something already worked here, and search it when the operator asks what was done about something.',
    inputSchema: {
      q: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Narrow to entries whose ticket key, line or notes contain this text. Omit for everything.',
        ),
      limit: z.number().int().positive().max(1000).optional(),
    },
    mutates: false,
  },
  {
    tool: 'grndctrl_get_ticket_history',
    operation: 'history.get',
    description:
      'The history entry for one ticket, whole. Answers not_found when nothing has been written about it — which is the answer to "has anyone worked this before?".',
    inputSchema: {
      ticketKey: subjectKey.describe('The ticket, as jira:<site>/<ISSUE-KEY>.'),
    },
    mutates: false,
  },
]
