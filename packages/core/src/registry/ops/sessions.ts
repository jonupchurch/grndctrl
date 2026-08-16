import { z } from 'zod'
import type { SessionsService } from '../../services/sessions.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema, timestampSchema } from './schemas.js'

/**
 * Sessions as operations.
 *
 * Every one is exposed on all three surfaces. A user starting a session from
 * the UI is unusual but not forbidden, and more to the point: a capability that
 * exists on MCP and not on IPC is exactly the asymmetry gate XII is checking
 * for, and "agents wouldn't need it" is how that asymmetry always starts.
 *
 * `agentId` comes from the payload rather than from `ctx`, unlike `authorKind`
 * on a note. The loopback transport authenticates *the machine*, not which
 * agent is on the other end — one shared handshake token — so it has no agent
 * identity to stamp. That is acceptable here and would not be for a note,
 * because a session identifier grants no authority: the worst a lying agent
 * achieves is a mislabelled row in a panel. If the transport ever learns to
 * tell agents apart, this is the line that changes.
 */

const sessionRef = {
  agentId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  /** The agent's own clock, clamped on the way in. Absolute, never relative. */
  at: timestampSchema.optional(),
}

const sessionSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  sessionId: z.string(),
  projectId: z.string().nullable(),
  workItemKey: z.string().nullable(),
  workspaceKey: z.string().nullable(),
  reportedStatus: z.string().nullable(),
  startedAt: z.string(),
  lastHeartbeatAt: z.string(),
  lastRealActivityAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  outcome: z.enum(['done', 'failed']).nullable(),
  heartbeatIntervalSec: z.number().int(),
  state: z.enum(['running', 'silent', 'needs-you', 'done', 'failed']),
  idleSec: z.number().int().nullable(),
  sinceHeartbeatSec: z.number().int(),
})

export function sessionsOperations(service: SessionsService): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'sessions.list',
      description: 'Every agent session, with its live state derived from the heartbeat clock.',
      input: z.object({}),
      output: z.array(sessionSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (_input, ctx) => service.list(ctx.now()),
    }),

    defineOperation({
      name: 'sessions.start',
      description:
        'Open a session, or resume one with the same agent and session id. Declares the heartbeat interval.',
      input: z.object({
        ...sessionRef,
        projectId: z.string().nullable().optional(),
        workItemKey: naturalKeySchema.nullable().optional(),
        workspaceKey: naturalKeySchema.nullable().optional(),
        reportedStatus: z.string().max(500).nullable().optional(),
        heartbeatIntervalSec: z.number().int().min(5).max(3600),
      }),
      output: sessionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.start(input, ctx),
    }),

    defineOperation({
      name: 'sessions.heartbeat',
      description:
        'Report that the agent process is still alive. Does NOT count as activity — use sessions.activity when work actually happened.',
      input: z.object(sessionRef),
      output: sessionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.heartbeat(input, ctx),
    }),

    defineOperation({
      name: 'sessions.activity',
      description:
        'Report that real work happened, optionally with a one-line status. Advances both the activity clock and the heartbeat.',
      input: z.object({
        ...sessionRef,
        reportedStatus: z.string().max(500).nullable().optional(),
        workItemKey: naturalKeySchema.nullable().optional(),
        workspaceKey: naturalKeySchema.nullable().optional(),
      }),
      output: sessionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.activity(input, ctx),
    }),

    defineOperation({
      name: 'sessions.end',
      description: 'Close a session as done or failed.',
      input: z.object({ ...sessionRef, outcome: z.enum(['done', 'failed']) }),
      output: sessionSchema,
      exposure: 'all',
      mutates: true,
      providerDerived: false,
      handler: async (input, ctx) => service.end(input, ctx),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
