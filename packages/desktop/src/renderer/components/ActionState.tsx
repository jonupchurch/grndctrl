import type { ReactElement } from 'react'
import type { AgentSession } from '../types.js'
import { formatAge } from './StaleBar.js'

/**
 * What happened to a confirmed action (T152, FR-066).
 *
 * The states are the outbox's own — pending, claimed, complete, failed,
 * expired, cancelled — and each is shown as itself rather than collapsed into
 * "sent". "Sent" is not a state this application can honestly report: nothing
 * is sent anywhere. An action is written to a local table and waits for an
 * agent to *ask* for it (FR-064), which is what makes it durable across a
 * restart and also what makes "delivered" a word with no referent here.
 *
 * That is the whole reason for `Listeners` below.
 */

export type ActionStateName =
  | 'pending'
  | 'claimed'
  | 'complete'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface OutboxAction {
  id: string
  subjectKey: string
  kind: string
  state: ActionStateName
  confirmedAt: string
  claimedBy: string | null
  result: string | null
  failureReason: string | null
  completedAt: string | null
  history: { at: string; to: string; actor: string; detail: string | null }[]
}

/**
 * Whether anything is actually there to pick this up (FR-066).
 *
 * `running` only. A session that has gone silent has missed its heartbeat, and
 * the reason for deriving silence from a missed beat rather than from anything
 * the agent said is precisely that a crashed agent cannot report its own crash
 * — so counting a silent session as a listener would put the reassuring
 * sentence on screen in the one case it is most wrong.
 *
 * The honest sentence when the count is zero is not "failed" and not an error.
 * The action is queued, durably, and the next agent to connect will find it.
 * What it must not do is read as though something has been dispatched.
 */
export function Listeners({
  sessions,
  className,
}: {
  sessions: readonly AgentSession[]
  className: string
}): ReactElement {
  const live = sessions.filter((s) => s.state === 'running')

  return (
    <p className={className} data-listening={live.length > 0 ? 'true' : 'false'}>
      {live.length > 0 ? (
        <span>
          {live.length} agent session{live.length === 1 ? '' : 's'} running —{' '}
          {live.length === 1 ? 'it' : 'one of them'} may pick this up.
        </span>
      ) : (
        <span>
          <strong>No agent is connected.</strong> This will sit in the outbox until one asks for
          work — it survives a restart, and nothing is sent anywhere in the meantime.
        </span>
      )}
    </p>
  )
}

const SENTENCE: Record<ActionStateName, string> = {
  pending: 'Waiting to be claimed',
  claimed: 'An agent is working on it',
  complete: 'Done',
  failed: 'Failed',
  expired: 'The claim lapsed before it finished',
  cancelled: 'Cancelled',
}

export function ActionState({
  action,
  sessions,
  onCancel,
  now,
}: {
  action: OutboxAction
  sessions: readonly AgentSession[]
  onCancel?: (() => void) | undefined
  now?: Date
}): ReactElement {
  return (
    <div className="action-state">
      <p className="action-state__line">
        <span className="action-state__badge" data-state={action.state}>
          {action.state}
        </span>
        <span>{SENTENCE[action.state]}</span>
        {action.claimedBy !== null && <span>· {action.claimedBy}</span>}
      </p>

      {/* Only while it could still be claimed. Once an agent holds it, the
          sentence about who is listening is answered by `claimedBy` above, and
          repeating it would be noise. */}
      {action.state === 'pending' && (
        <Listeners sessions={sessions} className="action-state__listeners" />
      )}

      {action.failureReason !== null && (
        <p className="action-state__detail">{action.failureReason}</p>
      )}
      {action.result !== null && <p className="action-state__detail">{action.result}</p>}

      <ul className="action-state__history">
        {action.history.map((entry, i) => (
          <li key={`${action.id}-${i}`}>
            {entry.to} · {entry.actor} · {formatAge(entry.at, now)}
            {entry.detail === null ? '' : ` · ${entry.detail}`}
          </li>
        ))}
      </ul>

      {onCancel !== undefined && action.state === 'pending' && (
        <span className="notes__form-actions">
          {/* FR-067. Consent is the operator's to withdraw, and `outbox.cancel`
              is `ui-only` for that reason — an agent cannot cancel its way out
              of work it was asked to do. */}
          <button type="button" onClick={onCancel}>
            Cancel this action
          </button>
        </span>
      )}
    </div>
  )
}
