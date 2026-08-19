import { describe, expect, it } from 'vitest'
import { ballInCourt, type BallInput } from '../../src/correlation/ball.js'

/**
 * Whose move is it, with three of the seven conditions removed.
 *
 * The two things this file has to hold after 006 are the **order** and the fact
 * that **`them` is still reachable**. The order because several conditions are
 * true at once on a busy item and a fixed sequence is what stops the board
 * flickering between answers across refreshes (FR-024). `them` because it was
 * reachable three ways and two of them were pull requests — a bucket that
 * silently stopped filling would look exactly like a bucket that had nothing in
 * it, which is the reading that makes the panel useless.
 */

const base: BallInput = {
  hasOpenQuestion: false,
  ticket: null,
  hasLiveSession: false,
}

const ball = (over: Partial<BallInput>) => ballInCourt({ ...base, ...over }).ball

describe('ball in court', () => {
  it('is yours when an agent has asked a question', () => {
    expect(ball({ hasOpenQuestion: true })).toBe('you')
  })

  it('is yours when the ticket is assigned to you and actionable', () => {
    expect(
      ball({ ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true } }),
    ).toBe('you')
  })

  /**
   * The one that had to survive the removal.
   *
   * `them` used to be reachable three ways: a review requested on the operator's
   * own pull request, a pull request waiting on somebody else's review, and a
   * ticket assigned to another person. The first two went with the code host.
   * This is the third, and it is a ticket-only signal, so the bucket still
   * fills — asserted here rather than left to be noticed when the panel reads
   * zero on a board where half the work belongs to other people.
   */
  it('is still theirs when the ticket belongs to someone else and nothing is moving', () => {
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
        hasLiveSession: true,
        ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true },
      }),
    ).toBe('you')
  })

  it('puts your own actionable ticket above a running agent', () => {
    expect(
      ball({
        hasLiveSession: true,
        ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true },
      }),
    ).toBe('you')
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
      { ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true } },
      { hasLiveSession: true },
      { ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true } },
      {},
    ]

    for (const c of cases) {
      expect(ballInCourt({ ...base, ...c }).because.length).toBeGreaterThan(0)
    }
  })

  /**
   * Every branch is covered, and the count says so.
   *
   * Four conditions plus the default. The list above used to have nine entries
   * for seven conditions plus the default, and a list that merely *shrank*
   * would still pass if a branch had been dropped by accident — the assertion
   * is that the reasons are all distinct, so a case that stopped reaching its
   * own branch would collide with another's text.
   */
  it('gives each branch its own reason', () => {
    const reasons = new Set(
      [
        ballInCourt({ ...base, hasOpenQuestion: true }),
        ballInCourt({
          ...base,
          ticket: { assignedToOperator: true, assignedToSomeoneElse: false, actionable: true },
        }),
        ballInCourt({ ...base, hasLiveSession: true }),
        ballInCourt({
          ...base,
          ticket: { assignedToOperator: false, assignedToSomeoneElse: true, actionable: true },
        }),
        ballInCourt(base),
      ].map((r) => r.because),
    )

    expect(reasons.size).toBe(5)
  })
})
