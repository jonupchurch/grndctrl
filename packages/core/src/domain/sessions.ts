import type { AgentSession, SessionState } from './types.js'

/**
 * What state a session is in, computed rather than stored.
 *
 * Deriving it at read time is the whole design (FR-046). A stored `running`
 * outlives the process that set it: an agent killed between heartbeats leaves
 * the flag on disk, and every subsequent launch inherits a claim it cannot
 * check. Derived, the same situation reads as `silent` the moment the clock
 * passes the miss window, with no writer needed and nothing to clean up.
 *
 * Shared by the correlation join and the sessions service so there is one
 * answer. Two copies of this would drift, and the symptom would be a board that
 * calls a session live in one panel and silent in another.
 */
export function sessionStateOf(
  session: AgentSession,
  now: Date,
  missMultiplier: number,
  hasOpenQuestion: boolean,
): SessionState {
  // An ended session is ended. Checked first so a question left attached to
  // finished work cannot resurrect it into "needs you".
  if (session.endedAt !== null) return session.outcome === 'failed' ? 'failed' : 'done'

  // An agent that stopped to ask is blocked on the operator, whether or not it
  // is still beating.
  if (hasOpenQuestion) return 'needs-you'

  const missAfterMs = session.heartbeatIntervalSec * missMultiplier * 1000
  const since = now.getTime() - Date.parse(session.lastHeartbeatAt)
  return since > missAfterMs ? 'silent' : 'running'
}

/**
 * How long since the agent last did something real, as opposed to breathing.
 *
 * `null` when it has reported no activity at all — which is not the same as
 * "no activity for zero seconds", and must not render as a fresh timestamp.
 */
export function idleSecondsOf(session: AgentSession, now: Date): number | null {
  if (session.lastRealActivityAt === null) return null
  return Math.max(0, Math.floor((now.getTime() - Date.parse(session.lastRealActivityAt)) / 1000))
}
