import { afterEach, describe, expect, it } from 'vitest'
import { isOperationError } from '../../src/registry/errors.js'
import {
  at,
  confirmAndEnqueue,
  ctx,
  outboxFixture,
  type OutboxFixture,
} from './outbox-fixture.js'

/**
 * FR-062 and FR-063: one claimant wins, and a lease that lapses returns the work
 * to the queue with the attempt on the record.
 *
 * Two agents polling the same queue is the normal case, not the exotic one. If
 * both could believe they hold the same action, both would perform the same
 * provider write — turning one confirmation into two changes, which is the
 * failure XVI exists to prevent, arrived at by a different route.
 */

let f: OutboxFixture

afterEach(() => {
  f.close()
})

describe('two agents racing for the same action', () => {
  it('gives it to exactly one, and tells the other why', () => {
    f = outboxFixture()
    const action = confirmAndEnqueue(f)

    const won = f.service.claim({ id: action.id }, ctx(10, 'claude-code'))
    expect(won.claimedBy).toBe('claude-code')

    try {
      f.service.claim({ id: action.id }, ctx(10, 'other-agent'))
      throw new Error('expected the second claim to lose')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('conflict')
      // The loser gets the current row rather than a bare refusal, so it can
      // move on to the next item instead of retrying blind.
      const current = isOperationError(e) ? e.details.current : null
      expect(current).toMatchObject({ state: 'claimed', claimedBy: 'claude-code' })
    }

    expect(f.service.get(action.id)?.claimedBy).toBe('claude-code')
  })

  it('will not let a non-holder complete or fail it', () => {
    f = outboxFixture()
    const action = confirmAndEnqueue(f)
    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))

    for (const attempt of [
      () => f.service.complete({ id: action.id, result: 'done' }, ctx(20, 'other-agent')),
      () => f.service.fail({ id: action.id, reason: 'nope' }, ctx(20, 'other-agent')),
    ]) {
      try {
        attempt()
        throw new Error('expected a refusal')
      } catch (e) {
        // Otherwise an agent that lost its lease could report an outcome for
        // work another agent is now doing, and the history would record a
        // success belonging to nobody.
        expect(isOperationError(e) && e.code).toBe('precondition_failed')
      }
    }

    expect(f.service.get(action.id)?.state).toBe('claimed')
  })

  it('refuses to complete something that was never claimed', () => {
    f = outboxFixture()
    const action = confirmAndEnqueue(f)

    try {
      f.service.complete({ id: action.id }, ctx(10, 'claude-code'))
      throw new Error('expected a refusal')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('precondition_failed')
    }
  })
})

describe('a claim that lapses', () => {
  it('returns to the queue with the attempt recorded, never silently', () => {
    f = outboxFixture({ claimLeaseSec: 60 })
    const action = confirmAndEnqueue(f)

    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))
    // The agent is killed here. Nothing reports anything.

    // A minute and a half later, another agent asks for work. The sweep happens
    // on claim rather than on a timer: the moment work is asked for is exactly
    // when a lapsed claim should be available again, and it needs no scheduler
    // to be correct.
    const revived = f.service.claim({ id: action.id }, ctx(100, 'other-agent'))

    expect(revived.claimedBy).toBe('other-agent')
    expect(revived.history.map((h) => `${h.from ?? 'nothing'}->${h.to}`)).toEqual([
      'nothing->pending',
      'pending->claimed',
      // The expiry is on the record, naming who dropped it. Without this a
      // repeatedly-failing agent would be invisible (FR-063).
      'claimed->pending',
      'pending->claimed',
    ])

    const expiry = revived.history[2]
    expect(expiry).toMatchObject({ actor: 'claude-code', detail: 'claim expired' })
  })

  it('shows up in pending again after a sweep, with no second claimant needed', () => {
    f = outboxFixture({ claimLeaseSec: 60 })
    const action = confirmAndEnqueue(f)
    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))

    expect(f.service.pending()).toHaveLength(0)

    const { revived } = f.service.sweep(new Date(Date.parse(at(100))))
    expect(revived).toEqual([action.id])
    expect(f.service.pending().map((a) => a.id)).toEqual([action.id])
  })

  it('leaves a claim inside its lease alone', () => {
    f = outboxFixture({ claimLeaseSec: 300 })
    const action = confirmAndEnqueue(f)
    f.service.claim({ id: action.id }, ctx(10, 'claude-code'))

    const { revived } = f.service.sweep(new Date(Date.parse(at(200))))
    expect(revived).toEqual([])
    expect(f.service.get(action.id)?.claimedBy).toBe('claude-code')
  })
})

describe('an action nobody ever takes', () => {
  it('lapses after its time-to-live rather than waiting forever', () => {
    f = outboxFixture({ pendingTtlSec: 3600 })
    const action = confirmAndEnqueue(f, { to: 'Done' }, 0)

    // Still within the window: the outbox exists precisely so that "no agent
    // running right now" is survivable, so this must not expire eagerly.
    expect(f.service.sweep(new Date(Date.parse(at(3000)))).expired).toEqual([])
    expect(f.service.pending()).toHaveLength(1)

    // Past it. A confirmation the operator no longer remembers giving should
    // not fire the moment an agent happens to connect.
    expect(f.service.sweep(new Date(Date.parse(at(4000)))).expired).toEqual([action.id])

    const expired = f.service.get(action.id)
    expect(expired?.state).toBe('expired')
    expect(expired?.history.at(-1)).toMatchObject({ from: 'pending', to: 'expired', actor: 'system' })
  })

  it('cannot be claimed once it has expired', () => {
    f = outboxFixture({ pendingTtlSec: 3600 })
    const action = confirmAndEnqueue(f)
    f.service.sweep(new Date(Date.parse(at(4000))))

    try {
      f.service.claim({ id: action.id }, ctx(4100, 'claude-code'))
      throw new Error('expected a refusal')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('conflict')
    }
  })
})

describe('the queue order', () => {
  it('offers the action the operator has been waiting on longest', () => {
    f = outboxFixture()
    const first = confirmAndEnqueue(f, { to: 'Done' }, 0)
    const second = confirmAndEnqueue(f, { to: 'In Review' }, 60)
    const third = confirmAndEnqueue(f, { to: 'Blocked' }, 120)

    expect(f.service.pending().map((a) => a.id)).toEqual([first.id, second.id, third.id])
  })
})
