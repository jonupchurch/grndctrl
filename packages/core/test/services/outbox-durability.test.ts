import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isOperationError } from '../../src/registry/errors.js'
import {
  at,
  confirmAndEnqueue,
  ctx,
  outboxFixture,
  SUBJECT,
  type OutboxFixture,
} from './outbox-fixture.js'

/**
 * SC-008: confirm an action with no agent connected, restart the app, and an
 * agent that shows up later still finds it, claims it, and completes it.
 *
 * This is the whole reason the outbox is a table rather than a message pushed at
 * whoever happens to be listening. MCP transport is client-initiated: at the
 * moment the operator clicks confirm there may be no agent in existence to tell.
 * Push is an accelerator; the queue is the contract (FR-065).
 */

let f: OutboxFixture

beforeEach(() => {
  f = outboxFixture()
})

afterEach(() => {
  f.close()
})

describe('an action confirmed with nobody listening', () => {
  it('survives a restart and is picked up afterwards', () => {
    const action = confirmAndEnqueue(f, { to: 'Done' }, 0)
    expect(action.state).toBe('pending')

    // No agent has ever connected. The app closes.
    f.restart()

    // An agent starts an hour later and asks for work.
    const pending = f.service.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe(action.id)
    expect(pending[0]?.payload).toEqual({ to: 'Done' })

    const claimed = f.service.claim({ id: action.id }, ctx(3600, 'claude-code'))
    expect(claimed.state).toBe('claimed')
    expect(claimed.claimedBy).toBe('claude-code')

    const done = f.service.complete(
      { id: action.id, result: 'MERC-1184 moved to Done' },
      ctx(3620, 'claude-code'),
    )

    expect(done.state).toBe('complete')
    expect(done.result).toBe('MERC-1184 moved to Done')
    expect(done.completedAt).toBe(at(3620))
  })

  it('keeps the confirmation record across the restart', () => {
    const action = confirmAndEnqueue(f, { to: 'Done' }, 0)
    f.restart()

    const after = f.service.get(action.id)
    // `confirmedAt` and `confirmedVia` are what make this action legitimate. If
    // a restart could lose them the row would be an unconfirmed write request,
    // which XVI says cannot exist.
    expect(after?.confirmedAt).toBe(at(0))
    expect(after?.confirmedVia).toBe('ipc')
  })

  it('does not carry the confirmation token across the restart', () => {
    const payload = { to: 'Done' }
    const { token } = f.service.mintConfirmation(
      { subjectKey: SUBJECT, kind: 'transition-ticket', payload },
      ctx(0),
    )

    f.restart()

    // Tokens live in memory and a restart is meant to lose them (XI). An
    // authorisation that outlives the window it was granted in is not one — the
    // operator confirmed something in a session that no longer exists.
    expect(() =>
      f.service.enqueue(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload, confirmationToken: token },
        ctx(10),
      ),
    ).toThrow()

    expect(f.service.list({})).toHaveLength(0)
  })
})

describe('the history', () => {
  it('records every transition, in order, and is only ever appended to', () => {
    const action = confirmAndEnqueue(f, { to: 'Done' }, 0)
    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))
    const done = f.service.complete({ id: action.id, result: 'ok' }, ctx(20, 'claude-code'))

    expect(done.history.map((h) => `${h.from ?? 'nothing'}->${h.to}`)).toEqual([
      'nothing->pending',
      'pending->claimed',
      'claimed->complete',
    ])
    expect(done.history.map((h) => h.actor)).toEqual(['operator', 'claude-code', 'claude-code'])
    // Monotonic: an audit trail out of order is not an audit trail.
    expect(done.history.map((h) => h.at)).toEqual([at(0), at(10), at(20)])
  })

  it('records a failure with its reason rather than dropping the attempt', () => {
    const action = confirmAndEnqueue(f)
    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))
    const failed = f.service.fail(
      { id: action.id, reason: 'Jira rejected the transition: no such workflow step' },
      ctx(20, 'claude-code'),
    )

    expect(failed.state).toBe('failed')
    expect(failed.failureReason).toContain('no such workflow step')
    // Terminal. An automatic retry would be a second provider write from one
    // confirmation, and once means once (XVI).
    expect(failed.claimedBy).toBeNull()
    expect(f.service.pending()).toHaveLength(0)
  })
})

describe('cancelling', () => {
  it('withdraws a pending action', () => {
    const action = confirmAndEnqueue(f)
    const cancelled = f.service.cancel({ id: action.id }, ctx(10))

    expect(cancelled.state).toBe('cancelled')
    expect(f.service.pending()).toHaveLength(0)
  })

  it('refuses to cancel an action an agent is already executing', () => {
    const action = confirmAndEnqueue(f)
    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))

    try {
      f.service.cancel({ id: action.id }, ctx(20))
      throw new Error('expected a refusal')
    } catch (e) {
      // Nothing here can reach into a running agent and stop it. Recording the
      // action as cancelled while it completes would be a false record, which
      // is worse than a refusal the operator can see.
      expect(isOperationError(e) && e.code).toBe('precondition_failed')
    }

    expect(f.service.get(action.id)?.state).toBe('claimed')
  })
})
