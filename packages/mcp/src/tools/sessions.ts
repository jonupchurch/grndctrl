import { z } from 'zod'
import { agentRef, subjectKey, type ToolBinding } from './shared.js'

/**
 * Sessions — how an agent tells the operator it is here and what it is doing.
 *
 * The distinction the descriptions have to land, because the whole panel
 * depends on agents getting it right: **a heartbeat says the process is alive,
 * an activity report says work happened.** An agent that heartbeats through a
 * twenty-minute retry loop and never reports activity shows as running but
 * idle for twenty minutes — which is exactly right, and exactly what the
 * operator needs to see. An agent that heartbeats on every retry *and* calls it
 * activity shows as busy, and the stall becomes invisible.
 *
 * These are authored records, not provider writes, so nothing here touches XVI.
 */
export const sessionsTools: readonly ToolBinding[] = [
  {
    tool: 'grndctrl_start_session',
    operation: 'sessions.start',
    description:
      'Announce that you are working. Declare how often you will heartbeat; missing three in a row shows you as silent. Starting again with the same agent and session id resumes the existing session rather than creating a second one.',
    inputSchema: {
      ...agentRef,
      heartbeatIntervalSec: z
        .number()
        .int()
        .min(5)
        .max(3600)
        .describe('How often you will heartbeat. Be honest — silence is derived from it.'),
      workItemKey: subjectKey.nullable().optional().describe('What you are working on, if known.'),
      // `workspaceKey` was here — "The repo/branch checkout you are in."
      // Removed with the local git reader, and `sessions.start` is strict, so an
      // agent still sending it is told rather than quietly ignored (FR-115).
      projectId: z.string().nullable().optional(),
      reportedStatus: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe('One line the operator will read, e.g. "Writing tests for the cold-start path".'),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_heartbeat',
    operation: 'sessions.heartbeat',
    description:
      'Say you are still alive. This is NOT a claim that anything happened — it deliberately does not advance your activity clock. Send it on a timer; use grndctrl_report_activity when you actually did something.',
    inputSchema: agentRef,
    mutates: true,
  },
  {
    tool: 'grndctrl_report_activity',
    operation: 'sessions.activity',
    description:
      'Report that real work happened — a file changed, a test run, a decision made — optionally with a one-line status. Advances both your activity clock and your heartbeat. Do not send this on a timer; that is what makes a stuck agent look busy.',
    inputSchema: {
      ...agentRef,
      reportedStatus: z.string().max(500).nullable().optional(),
      workItemKey: subjectKey.nullable().optional(),
    },
    mutates: true,
  },
  {
    tool: 'grndctrl_end_session',
    operation: 'sessions.end',
    description:
      'Close the session as done or failed. Ending as failed is more useful to the operator than not ending at all — an unclosed session just goes silent, which says nothing about why.',
    inputSchema: { ...agentRef, outcome: z.enum(['done', 'failed']) },
    mutates: true,
  },
  {
    tool: 'grndctrl_list_sessions',
    operation: 'sessions.list',
    description:
      'Every agent session and its live state. Useful for noticing that another agent is already on the work you were about to start.',
    inputSchema: {},
    mutates: false,
  },
]
