import { subjectKey, type ToolBinding } from './shared.js'

/**
 * The active ticket — the one board field an agent is *expected* to write.
 *
 * The operator's brief was "populated by MCP", so these three are the reason
 * `focus.*` is a registry operation at all rather than a settings key: settings
 * are `ui-only` and would have put this out of reach of the only caller it was
 * designed for (007/R3).
 *
 * The descriptions are written to be read at the moment of deciding, not to
 * describe the endpoint. "Sets the active ticket" is true and tells a model
 * nothing about **when** — and the failure mode of a vague description here is
 * not an error, it is a panel that stays empty because nothing ever thought the
 * tool applied to it.
 *
 * None of these is a write to Jira. Setting focus moves a local pointer; it does
 * not transition the ticket, comment on it, or touch the tracker, so gate XVI is
 * not engaged and there is no confirmation to mint. That distinction is worth
 * knowing when reading this file next to `outbox.ts`, where every tool is the
 * other kind.
 */
export const focusTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_set_active_ticket',
    operation: 'focus.set',
    description:
      'Call this when you start work on a ticket, so the operator can see what you are on without asking. Replaces whatever was set before — there is one active ticket, not a list. The key does not have to have been synced yet.',
    inputSchema: {
      ticketKey: subjectKey.describe(
        'The ticket you are working, as jira:<site>/<ISSUE-KEY>. Only a ticket key is accepted here.',
      ),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_get_active_ticket',
    operation: 'focus.get',
    description:
      'What the operator is currently working, and who set it. Read this before picking up work of your own — if a ticket is already active, that is probably the one to be on. Null means nothing is set.',
    inputSchema: {},
    mutates: false,
  },
  {
    tool: 'grndctrl_clear_active_ticket',
    operation: 'focus.clear',
    description:
      'Call this when the work is finished or abandoned and nothing has replaced it. Leaving a stale ticket active is worse than clearing it — the operator reads the panel as "this is what is happening now". Safe to call when nothing is set.',
    inputSchema: {},
    mutates: true,
  },
]
