import type { NaturalKey } from '../domain/keys.js'
import { sessionKey } from '../domain/keys.js'
import { idleSecondsOf, sessionStateOf } from '../domain/sessions.js'
import type { AgentSession, SessionState, Timestamp } from '../domain/types.js'
import { invalid, notFound } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { SessionPatch, SessionsRepository } from '../store/authored/sessions.js'

/**
 * Agent sessions — what is running right now, and whether it is actually doing
 * anything.
 *
 * Sessions are authored data, not provider writes. Nothing here calls out to
 * Jira or GitHub, so constitution XVI is untouched: an agent reporting its own
 * work is the agent talking about itself.
 *
 * The design rests on one distinction, and it is the difference between a
 * useful panel and a decorative one:
 *
 *   **A heartbeat says "the process is alive". An activity report says "work
 *   happened".** They are stored separately, and a heartbeat never advances
 *   `lastRealActivityAt`. An agent stuck in a retry loop keeps beating
 *   perfectly, and if a heartbeat counted as activity the board would show it
 *   as busy indefinitely — which is precisely the failure the operator needs to
 *   see, rendered as its opposite.
 */

export interface SessionView extends AgentSession {
  /** Derived, never stored (FR-046). */
  state: SessionState
  /** Seconds since the last *real* activity. `null` when none has been reported. */
  idleSec: number | null
  /** Seconds since the last heartbeat, for the "silent for N minutes" label. */
  sinceHeartbeatSec: number
}

export interface SessionsServiceDeps {
  sessions: SessionsRepository
  /** Subjects carrying an unresolved question. A session with one is `needs-you`. */
  openQuestionSubjects(): readonly NaturalKey[]
  /** How many missed beats count as silence. From settings; 3 by default. */
  missMultiplier(): number
}

export interface StartSessionInput {
  agentId: string
  sessionId: string
  projectId?: string | null | undefined
  workItemKey?: NaturalKey | null | undefined
  reportedStatus?: string | null | undefined
  heartbeatIntervalSec: number
  /** The agent's own clock. Clamped — never trusted to be ahead of ours (FR-045). */
  at?: string | undefined
}

export interface SessionRef {
  agentId: string
  sessionId: string
  at?: string | undefined
}

/**
 * `workspaceKey` was on both of these, and on the patch `activity` builds.
 *
 * It outlived the column. Migration 4 dropped `agent_sessions.workspace_key`,
 * and `SessionPatch` lost the field with it, so the spread in `activity` was
 * building `UPDATE agent_sessions SET undefined = ?` for any caller that still
 * passed one. Nothing external could: the registry schema is strict and
 * `conformance.test.ts` asserts that `sessions.start` rejects it by name. But
 * `seed.mjs` calls these services directly, which is the whole point of a
 * composition root, and it was still passing the field.
 */
export interface ActivityInput extends SessionRef {
  reportedStatus?: string | null | undefined
  workItemKey?: NaturalKey | null | undefined
}

export interface SessionsService {
  list(now: Date): SessionView[]
  get(key: NaturalKey, now: Date): SessionView | null
  start(input: StartSessionInput, ctx: Ctx): SessionView
  heartbeat(input: SessionRef, ctx: Ctx): SessionView
  activity(input: ActivityInput, ctx: Ctx): SessionView
  end(input: SessionRef & { outcome: 'done' | 'failed' }, ctx: Ctx): SessionView
}

/**
 * Below five seconds the miss window is tighter than ordinary scheduling
 * jitter, and every agent on a loaded machine would flicker to silent. Above an
 * hour the panel stops being a live view.
 */
const MIN_INTERVAL_SEC = 5
const MAX_INTERVAL_SEC = 3600

export function sessionsService(deps: SessionsServiceDeps): SessionsService {
  const { sessions } = deps

  const view = (session: AgentSession, now: Date): SessionView => {
    const questions = new Set<string>(deps.openQuestionSubjects())
    // The workspace was a third place a question could be attached, and it went
    // with the checkout. Both surviving arms matter: a question written against
    // the *session* is the agent stopping to ask, and one against the *ticket*
    // is the operator or another agent asking about the work.
    const hasOpenQuestion =
      questions.has(session.key) ||
      (session.workItemKey !== null && questions.has(session.workItemKey))

    return {
      ...session,
      state: sessionStateOf(session, now, deps.missMultiplier(), hasOpenQuestion),
      idleSec: idleSecondsOf(session, now),
      sinceHeartbeatSec: Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(session.lastHeartbeatAt)) / 1000),
      ),
    }
  }

  /**
   * The agent's timestamp, made safe.
   *
   * Clamped forward to receipt time because a clock running fast would push
   * `lastHeartbeatAt` into the future and keep a dead session "running" until
   * real time caught up (FR-045). Clamped backward against what is already
   * stored, because a late-delivered beat must not drag a live session
   * backwards into silence.
   */
  const stamp = (supplied: string | undefined, now: Date, floor?: Timestamp | null): Timestamp => {
    const receipt = now.getTime()
    const parsed = supplied === undefined ? receipt : Date.parse(supplied)
    const usable = Number.isNaN(parsed) ? receipt : Math.min(parsed, receipt)
    const floorMs = floor === undefined || floor === null ? 0 : Date.parse(floor)
    return new Date(Math.max(usable, Number.isNaN(floorMs) ? 0 : floorMs)).toISOString()
  }

  const mustGet = (agentId: string, sessionId: string): AgentSession => {
    const existing = sessions.get(sessionKey(agentId, sessionId))
    if (existing === null) {
      // Deliberately not an implicit start. An agent heartbeating a session it
      // never opened has lost its own state, and inventing a row would hide
      // that behind a plausible-looking board.
      throw notFound(`No open session '${agentId}/${sessionId}'. Start one first.`)
    }
    return existing
  }

  const touch = (existing: AgentSession, patch: SessionPatch, now: Date): SessionView => {
    const updated = sessions.patch(existing.key, patch)
    if (updated === null) throw notFound(`Session '${existing.key}' vanished mid-write.`)
    return view(updated, now)
  }

  return {
    list: (now) => sessions.list().map((s) => view(s, now)),

    get(key, now) {
      const session = sessions.get(key)
      return session === null ? null : view(session, now)
    },

    start(input, ctx) {
      if (input.agentId.trim() === '' || input.sessionId.trim() === '') {
        throw invalid('A session needs both an agent id and a session id.')
      }
      if (
        input.heartbeatIntervalSec < MIN_INTERVAL_SEC ||
        input.heartbeatIntervalSec > MAX_INTERVAL_SEC
      ) {
        throw invalid(
          `heartbeatIntervalSec must be between ${MIN_INTERVAL_SEC} and ${MAX_INTERVAL_SEC}.`,
        )
      }

      const now = ctx.now()
      const key = sessionKey(input.agentId, input.sessionId)
      const at = stamp(input.at, now)

      // A start for a key that already exists resumes it (FR-044). The store
      // keeps the original `startedAt`, so a crash-and-reconnect loop does not
      // reset the age of work that has genuinely been running for an hour.
      return view(
        sessions.upsertStart({
          key,
          agentId: input.agentId,
          sessionId: input.sessionId,
          projectId: input.projectId ?? null,
          workItemKey: input.workItemKey ?? null,
          reportedStatus: input.reportedStatus ?? null,
          startedAt: at,
          lastHeartbeatAt: at,
          // Not set at start. Opening a session is not doing work, and stamping
          // it here would make a session that never did anything look busy for
          // one interval.
          lastRealActivityAt: null,
          endedAt: null,
          outcome: null,
          heartbeatIntervalSec: input.heartbeatIntervalSec,
        }),
        now,
      )
    },

    heartbeat(input, ctx) {
      const now = ctx.now()
      const existing = mustGet(input.agentId, input.sessionId)

      // The whole point of this method: it advances one column. Adding
      // `lastRealActivityAt` here would make every stuck agent look busy.
      return touch(
        existing,
        { lastHeartbeatAt: stamp(input.at, now, existing.lastHeartbeatAt) },
        now,
      )
    },

    activity(input, ctx) {
      const now = ctx.now()
      const existing = mustGet(input.agentId, input.sessionId)
      const at = stamp(input.at, now, existing.lastHeartbeatAt)

      return touch(
        existing,
        {
          // Work happening implies the process is alive, so this advances both.
          // The converse does not hold, which is why they are separate columns.
          lastHeartbeatAt: at,
          lastRealActivityAt: stamp(input.at, now, existing.lastRealActivityAt),
          ...(input.reportedStatus === undefined ? {} : { reportedStatus: input.reportedStatus }),
          ...(input.workItemKey === undefined ? {} : { workItemKey: input.workItemKey }),
        },
        now,
      )
    },

    end(input, ctx) {
      const now = ctx.now()
      const existing = mustGet(input.agentId, input.sessionId)
      const at = stamp(input.at, now, existing.lastHeartbeatAt)

      return touch(existing, { endedAt: at, outcome: input.outcome, lastHeartbeatAt: at }, now)
    },
  }
}
