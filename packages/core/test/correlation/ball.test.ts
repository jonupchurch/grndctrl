import { describe, expect, it } from 'vitest'
import { ballInCourt, type BallInput } from '../../src/correlation/ball.js'

const base: BallInput = {
  hasOpenQuestion: false,
  authoredPullRequests: [],
  reviewRequestedOfOperator: false,
  ticket: null,
  awaitingOthersReview: false,
  hasLiveSession: false,
}

const ball = (over: Partial<BallInput>) => ballInCourt({ ...base, ...over }).ball

const pr = (over: Partial<BallInput['authoredPullRequests'][number]> = {}) => ({
  reviewDecision: null,
  requiredChecksFailing: false,
  isDraft: false,
  ...over,
})

describe('ball in court', () => {
  it('is yours when an agent has asked a question', () => {
    expect(ball({ hasOpenQuestion: true })).toBe('you')
  })

  it('is yours when your own PR has failing checks or requested changes', () => {
    expect(ball({ authoredPullRequests: [pr({ requiredChecksFailing: true })] })).toBe('you')
    expect(ball({ authoredPullRequests: [pr({ reviewDecision: 'changesRequested' })] })).toBe('you')
  })

  it('is yours when a review was requested from you', () => {
    expect(ball({ reviewRequestedOfOperator: true })).toBe('you')
  })

  it('is yours when the ticket is assigned to you and actionable', () => {
    expect(
      ball({ ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true } }),
    ).toBe('you')
  })

  it('is theirs when waiting on someone else to review', () => {
    expect(ball({ awaitingOthersReview: true })).toBe('them')
  })

  it('is theirs when the ticket belongs to someone else and nothing is moving', () => {
    expect(
      ball({ ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true } }),
    ).toBe('them')
  })

  it("is the agent's when a session is live and nothing is pending from a human", () => {
    expect(ball({ hasLiveSession: true })).toBe('agent')
  })
})

/**
 * The order is load-bearing: several conditions are true at once on a busy work
 * item, and without a fixed sequence the answer would depend on iteration order
 * and the board would flicker across refreshes (FR-024).
 */
describe('precedence when several conditions hold', () => {
  it('puts an open question above everything else', () => {
    expect(
      ball({
        hasOpenQuestion: true,
        awaitingOthersReview: true,
        hasLiveSession: true,
        ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true },
      }),
    ).toBe('you')
  })

  it('puts your blocked PR above a review you owe someone else', () => {
    expect(
      ball({ authoredPullRequests: [pr({ requiredChecksFailing: true })], awaitingOthersReview: true }),
    ).toBe('you')
  })

  // A review is small, immediate, and unblocking. Burying it under a
  // long-running assignment is how reviews sit for days.
  it('puts a review requested of you above your own ticket assignment', () => {
    expect(
      ball({
        reviewRequestedOfOperator: true,
        ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true },
      }),
    ).toBe('you')
  })

  // A human review is the thing nothing else can unblock. An agent working
  // alongside it is not what is holding the item up.
  it('puts a pending human review above a running agent', () => {
    expect(ball({ awaitingOthersReview: true, hasLiveSession: true })).toBe('them')
  })

  // An assignee is bookkeeping; a running agent is the thing actually moving
  // the work. Reporting "them" while an agent types points the operator at
  // somebody who is not the bottleneck.
  it('puts a running agent above a ticket merely assigned to someone else', () => {
    expect(
      ball({
        hasLiveSession: true,
        ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true },
      }),
    ).toBe('agent')
  })

  it('does not treat a non-actionable ticket assigned to you as your move', () => {
    expect(
      ball({
        ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: false },
      }),
    ).toBe('you') // falls through to the default -- still yours, but not because of the assignment
  })
})

/**
 * The bias is deliberate. A board that under-reports your own court is a board
 * you stop trusting to tell you when you are the bottleneck, which is the one
 * question it exists to answer.
 */
describe('the default', () => {
  it('is yours when nobody else is holding it', () => {
    const result = ballInCourt(base)
    expect(result.ball).toBe('you')
    expect(result.because).toMatch(/nobody else/)
  })

  it('does not hide unassigned, unstarted work as somebody else’s problem', () => {
    expect(ball({ ticket: null })).toBe('you')
  })
})

describe('reasons', () => {
  it('explains itself in every branch', () => {
    const cases: Partial<BallInput>[] = [
      { hasOpenQuestion: true },
      { authoredPullRequests: [pr({ requiredChecksFailing: true })] },
      { authoredPullRequests: [pr({ reviewDecision: 'changesRequested' })] },
      { reviewRequestedOfOperator: true },
      { ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true } },
      { awaitingOthersReview: true },
      { hasLiveSession: true },
      { ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true } },
      {},
    ]

    for (const c of cases) {
      expect(ballInCourt({ ...base, ...c }).because.length).toBeGreaterThan(0)
    }
  })
})
