import type { ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { Section } from '../components/Section.js'
import { formatAge } from '../components/StaleBar.js'
import { StatusMark, type Severity } from '../components/StatusMark.js'
import type { AgentSession, SessionState } from '../types.js'

/**
 * Agent sessions, with the three states that matter (T142).
 *
 * - **running** — heartbeating and doing something. Nothing owed.
 * - **silent** — the heartbeat stopped. Derived from a *missed heartbeat*, not
 *   from anything the agent said, because an agent that has crashed cannot tell
 *   you it crashed. This is the state the whole heartbeat mechanism exists for.
 * - **needs-you** — the agent wrote a `question-for-human` note and is waiting.
 *   It is still heartbeating, so nothing else would notice, and it is doing no
 *   work. The most expensive kind of idle there is.
 *
 * Age is measured from **last real activity**, never from the heartbeat. A
 * zombie session heartbeating on a dead task must not read as "active four
 * seconds ago" — that would hide exactly the situation this lane exists to show.
 *
 * A session has no web page, so unlike every other row on this board it does not
 * launch anywhere (FR-075's stated exception). Clicking it is not offered rather
 * than offered and doing nothing.
 */

const STATE: Record<SessionState, { severity: Severity; label: string; note: string }> = {
  running: { severity: 'good', label: 'Running', note: 'heartbeating' },
  'needs-you': { severity: 'critical', label: 'Needs you', note: 'waiting on an answer' },
  silent: { severity: 'serious', label: 'Silent', note: 'missed its heartbeat' },
  done: { severity: 'good', label: 'Done', note: 'ended cleanly' },
  failed: { severity: 'critical', label: 'Failed', note: 'ended with an error' },
}

export interface SessionsProps {
  sessions: readonly AgentSession[]
  now?: Date
}

export function Sessions({ sessions, now }: SessionsProps): ReactElement {
  // Needs-you first, then silent: both are stopped, and one of them is stopped
  // on something only the operator can supply.
  const ordered = [...sessions].sort((a, b) => rank(a.state) - rank(b.state))
  const live = sessions.filter((s) => s.state === 'running' || s.state === 'needs-you').length

  return (
    <Section
      id="sessions"
      title="Agent sessions"
      className="lane"
      count={`${live} of ${sessions.length}`}
    >
      {sessions.length === 0 ? (
        <EmptyState title="No agent sessions">
          Agents report themselves through <code>grndctrl-mcp</code> — start, heartbeat, activity,
          end. A session appears here the moment one starts, whether or not this window is open.
        </EmptyState>
      ) : (
        ordered.map((session) => {
          const state = STATE[session.state]

          return (
            <div key={session.key} className="session" data-state={session.state}>
              <StatusMark severity={state.severity} />
              <span className="session__agent">{session.agentId}</span>
              <span className="session__status">
                {session.reportedStatus ?? state.note}
              </span>
              <span className="session__state">{state.label}</span>
              {/* From real activity, not the heartbeat. */}
              <span className="session__age">{formatAge(session.lastRealActivityAt, now)}</span>
            </div>
          )
        })
      )}
    </Section>
  )
}

function rank(state: SessionState): number {
  return { 'needs-you': 0, silent: 1, running: 2, failed: 3, done: 4 }[state]
}
