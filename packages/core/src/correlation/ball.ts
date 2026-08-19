import type { BallInCourt } from '../domain/types.js'

/**
 * Whose move is it?
 *
 * FR-032 lists the conditions and the order they are evaluated in, and the
 * order is load-bearing: several are true at once on a busy work item, and
 * without a fixed sequence the answer would depend on iteration order and the
 * board would flicker between "you" and "them" across refreshes (FR-024).
 *
 * The bias is deliberate: when the operator has *anything* to do, the answer is
 * "you". A board that under-reports your own court is a board you stop trusting
 * to tell you when you are the bottleneck — which is the one question it exists
 * to answer.
 *
 * **Three of the seven conditions are gone and the order of the rest is
 * unchanged**, which is the property to check here rather than assume. The three
 * were the operator's own blocked pull request, a review requested *of* the
 * operator, and a pull request awaiting somebody else's review. Two of those
 * produced `you` and one produced `them`.
 *
 * `them` is the one worth naming, because it is the bucket that could have
 * silently emptied: it was reachable three ways and two of them were pull
 * requests. What is left is a ticket assigned to somebody else, which is a
 * ticket-only signal and untouched — so the bucket still fills, and
 * `ball.test.ts` asserts that specifically rather than leaving it to be noticed.
 */

export interface BallInput {
  /** A question-for-human note is open on this item. */
  hasOpenQuestion: boolean

  ticket: {
    assignedToOperator: boolean
    assignedToSomeoneElse: boolean
    /** A status where the assignee is expected to act, rather than to wait. */
    actionable: boolean
  } | null

  /** A live agent session is reporting against this item. */
  hasLiveSession: boolean
}

export interface BallResult {
  ball: BallInCourt
  because: string
}

export function ballInCourt(input: BallInput): BallResult {
  // 1. An outstanding question outranks everything. An agent that stopped to
  //    ask is blocked on the operator by definition, and nothing else on the
  //    item can proceed past it.
  if (input.hasOpenQuestion) {
    return { ball: 'you', because: 'an agent is waiting on your answer' }
  }

  // 2 and 3 were here and are gone with the code host: the operator's own pull
  // request needing the operator (a failing required check, or requested
  // changes), and a review requested *of* the operator. Both produced `you`, and
  // both sat above ticket assignment because a review is small, immediate and
  // unblocking, and burying it under a long-running assignment is how reviews sit
  // for days. Nothing else moves up to take their place: the numbering below is
  // the original numbering, so a future reader comparing this against FR-032 can
  // see which rules left rather than wondering why it starts at four.

  // 4. A ticket assigned to the operator in a status that expects action.
  if (input.ticket?.assignedToOperator === true && input.ticket.actionable) {
    return { ball: 'you', because: 'the ticket is assigned to you and is actionable' }
  }

  // 5 was "waiting on a review from someone else", which outranked a running
  // agent because a review is a human action nothing else can unblock. It went
  // with the pull requests, and it was one of the two ways `them` was reachable.

  // 6. An agent is actively working. Deliberately above "assigned to someone
  //    else": an assignee is bookkeeping, and a running agent is the thing
  //    actually moving the work. Reporting "them" while an agent types would
  //    point the operator at a person who is not the bottleneck.
  if (input.hasLiveSession) {
    return { ball: 'agent', because: 'an agent is working on this' }
  }

  // 7. Nothing is happening, and it belongs to somebody else.
  if (input.ticket?.assignedToSomeoneElse === true) {
    return { ball: 'them', because: 'the ticket is assigned to someone else' }
  }

  // Nothing is waiting on anyone else, so it is the operator's to pick up.
  // Defaulting to "them" here would quietly hide unassigned, unstarted work,
  // which is exactly the work that goes missing.
  return { ball: 'you', because: 'nobody else is holding this' }
}
