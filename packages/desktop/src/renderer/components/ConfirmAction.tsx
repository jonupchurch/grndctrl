import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState, type ReactElement } from 'react'
import { BridgeError, call } from '../bridge.js'
import type { AgentSession, DriftFinding } from '../types.js'
import { ActionState, Listeners, type OutboxAction } from './ActionState.js'
import { Modal } from './Modal.js'
import { formatAge } from './StaleBar.js'

/**
 * The confirmation gesture (T151, XVI, FR-062).
 *
 * Ground Control never writes to Jira or GitHub with the operator's stored
 * credentials — those are read-only, and the service layer has no call that
 * would. What it does instead is record that the operator asked for something,
 * and let an agent carry it out with credentials of its own.
 *
 * **So the confirmation is not a courtesy `confirm()`.** It is the mechanism.
 * `outbox.enqueue` demands a single-use token bound to this exact subject,
 * kind, and payload, and `outbox.mintConfirmation` is the only thing that
 * issues one — `ui-only`, reachable from this window and from no agent, no
 * MCP tool, and no loopback caller. Two operations rather than one is what
 * makes "nothing is dispatched without the operator" a property of the wiring
 * instead of a rule someone has to keep remembering.
 *
 * Both calls happen here, back to back, with nothing in between that could
 * decide differently. The token is never held in state and never leaves this
 * function.
 */

export interface ConfirmActionProps {
  finding: DriftFinding
  /** For FR-066: whether anything is listening, before and after. */
  sessions: readonly AgentSession[]
  onClose(): void
  now?: Date
}

export function ConfirmAction({
  finding,
  sessions,
  onClose,
  now,
}: ConfirmActionProps): ReactElement {
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<OutboxAction | null>(null)

  const suggested = finding.suggestedAction

  const confirm = useCallback(async (): Promise<void> => {
    if (suggested === null) return

    setBusy(true)
    setError(null)

    // Bound into the token by `confirmations.mint`, so it must be byte-identical
    // at enqueue. Built once and used twice rather than written out twice: two
    // literals that have to match are two literals that will eventually not.
    const payload: Record<string, unknown> = {
      rule: finding.rule,
      label: suggested.label,
      summary: finding.summary,
    }

    try {
      const minted = (await call('outbox.mintConfirmation', {
        subjectKey: finding.subjectKey,
        kind: suggested.kind,
        payload,
      })) as { token: string; expiresAt: string }

      const enqueued = (await call('outbox.enqueue', {
        subjectKey: finding.subjectKey,
        kind: suggested.kind,
        payload,
        confirmationToken: minted.token,
        // Ties the action back to what prompted it, so the outbox can answer
        // "why was this asked for" without the operator remembering.
        motivatingFindingId: finding.id,
      })) as OutboxAction

      setAction(enqueued)
      await client.invalidateQueries({ queryKey: ['outbox.list'] })
      await client.invalidateQueries({ queryKey: ['outbox.pending'] })
    } catch (cause) {
      setError(cause instanceof BridgeError ? cause.message : 'That could not be queued.')
    } finally {
      setBusy(false)
    }
  }, [client, finding, suggested])

  const cancel = useCallback(async (): Promise<void> => {
    if (action === null) return
    setBusy(true)
    try {
      setAction((await call('outbox.cancel', { id: action.id })) as OutboxAction)
      await client.invalidateQueries({ queryKey: ['outbox.list'] })
    } catch (cause) {
      setError(cause instanceof BridgeError ? cause.message : 'That could not be cancelled.')
    } finally {
      setBusy(false)
    }
  }, [action, client])

  return (
    <Modal
      title={action === null ? 'Confirm this action' : 'Queued'}
      onClose={onClose}
      footer={
        action === null ? (
          <>
            <button type="button" onClick={onClose} disabled={busy}>
              Not now
            </button>
            <button
              type="button"
              data-tone="primary"
              disabled={busy || suggested === null || !finding.dispatchable}
              onClick={() => void confirm()}
            >
              {suggested?.label ?? 'Confirm'}
            </button>
          </>
        ) : (
          <button type="button" data-tone="primary" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      <div className="confirm">
        <div className="confirm__what">
          <span className="confirm__label">Drift · {finding.rule}</span>
          <p className="confirm__summary">{finding.summary}</p>

          {/* Named because it is the substance of what is being authorised: the
              two facts that disagree, each with when it was true. */}
          <ul className="confirm__evidence" aria-label="Evidence">
            {finding.evidence.map((e, i) => (
              <li key={`${finding.id}-${i}`}>
                <span className="confirm__side">{e.side}</span>
                {e.fact}
                {e.at !== null && <span> · {formatAge(e.at, now)}</span>}
              </li>
            ))}
          </ul>
        </div>

        {action === null ? (
          <>
            <p className="confirm__summary">
              Ground Control will not do this itself — it holds read-only credentials and never
              writes to Jira or GitHub. Confirming records the request in the outbox for an agent
              to carry out with its own.
            </p>

            <Listeners sessions={sessions} className="confirm__listeners" />

            {error !== null && (
              <p className="confirm__error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <ActionState
              action={action}
              sessions={sessions}
              onCancel={() => void cancel()}
              {...(now === undefined ? {} : { now })}
            />
            {error !== null && (
              <p className="confirm__error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
