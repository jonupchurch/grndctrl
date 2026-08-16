import { z } from 'zod'
import { projectId, subjectKey, type ToolBinding } from './shared.js'

/**
 * Reading the board.
 *
 * Every one of these returns an envelope — the data plus when each contributing
 * lane was last successfully fetched — because an agent holds a response for the
 * length of a task, and a board without its age is a board an agent will act on
 * an hour later believing it is current (XIV).
 *
 * The timestamps inside are absolute ISO-8601, never "3 minutes ago". A relative
 * string is computed once and then quietly becomes wrong, and it is wrong in the
 * direction that makes stale data look fresh.
 */
export const readTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_get_board',
    operation: 'board.summary',
    description:
      'The state of the operator’s work in one object: how many items are in their court, how many are drifting, how many are stalled, how many have an agent on them. Start here. Carries freshness per lane.',
    inputSchema: { projectId },
    mutates: false,
  },
  {
    tool: 'grndctrl_list_work',
    operation: 'work.list',
    description:
      'Every correlated work item — ticket, branches, pull requests, CI checks and agent sessions joined into one row each — with severity, staleness and whose move it is.',
    inputSchema: { projectId },
    mutates: false,
  },
  {
    tool: 'grndctrl_get_work_item',
    operation: 'work.get',
    description: 'One work item by its natural key, with everything correlated onto it.',
    inputSchema: { key: subjectKey },
    mutates: false,
  },
  {
    tool: 'grndctrl_get_drift',
    operation: 'drift.list',
    description:
      'Where the systems disagree — a merged pull request against an open ticket, a branch with no ticket, a ticket in review with nothing to review. Each finding carries both sides of its evidence. You cannot dismiss these; dismissal is the operator’s.',
    inputSchema: { projectId },
    mutates: false,
  },
  {
    tool: 'grndctrl_get_app_status',
    operation: 'app.status',
    description:
      'Versions, platform, database schema versions, and the runtime ABI Ground Control is actually running against. Worth reading when something is failing to start or a native module is complaining about a version number — the ABI mismatch that breaks a packaged install names two numbers and no remedy, and this is where the real ones are.',
    inputSchema: {},
    mutates: false,
  },
  {
    tool: 'grndctrl_get_freshness',
    operation: 'sync.status',
    description:
      'How current the data is, per connection and per resource kind. "never synced", "stale" and "failed to refresh" are three different answers and mean three different things — check this before trusting a board you have been holding.',
    inputSchema: {},
    mutates: false,
  },
  {
    tool: 'grndctrl_refresh',
    operation: 'sync.now',
    description:
      'Refresh from the providers now. Read-only against every provider. Worth calling when you have just finished something and want the board to reflect it.',
    inputSchema: {
      connectionId: z.string().optional().describe('Refresh one connection only. Omit for all.'),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_resolve_link',
    operation: 'links.resolve',
    description:
      'The https URL a row opens. Use this rather than constructing a URL: provider data is not trusted here and any other scheme is refused. Falls back to the repository for a branch the host has never seen, and says so.',
    inputSchema: {
      subjectKey,
      target: z
        .enum(['default', 'ticket', 'pull-request', 'repository', 'branch', 'documentation', 'check'])
        .optional(),
    },
    mutates: false,
  },
  {
    tool: 'grndctrl_list_projects',
    operation: 'projects.list',
    description:
      'The operator’s projects — each one a Jira project plus a repository. Use it to make sense of a ticket key or a repository name.',
    inputSchema: {},
    mutates: false,
  },
]
