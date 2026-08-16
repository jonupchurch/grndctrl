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
 */

export interface BallInput {
  /** A question-for-human note is open on this item. */
  hasOpenQuestion: boolean

  /** PRs the operator authored. */
  authoredPullRequests: readonly {
    reviewDecision: 'approved' | 'changesRequested' | 'reviewRequired' | null
    requiredChecksFailing: boolean
    isDraft: boolean
  }[]

  /** The operator is a requested reviewer on at least one open PR. */
  reviewRequestedOfOperator: boolean

  ticket: {
    assignedToOperator: boolean
    assignedToSomeoneElse: boolean
    /** A status where the assignee is expected to act, rather than to wait. */
    actionable: boolean
  } | null

  /** At least one PR is open and waiting on a review from someone else. */
  awaitingOthersReview: boolean

  /** A live agent session owns a workspace on this item. */
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

  // 2. The operator's own PR needs the operator: a failing required check or
  //    requested changes is work only the author can clear.
  const blockedOwnPr = input.authoredPullRequests.find(
    (pr) => pr.requiredChecksFailing || pr.reviewDecision === 'changesRequested',
  )
  if (blockedOwnPr !== undefined) {
    return {
      ball: 'you',
      because: blockedOwnPr.requiredChecksFailing
        ? 'checks are failing on a pull request you opened'
        : 'changes were requested on a pull request you opened',
    }
  }

  // 3. A review requested of the operator. Checked before ticket assignment
  //    because a review is a small, immediate, and unblocking task, and burying
  //    it under a long-running assignment is how reviews sit for days.
  if (input.reviewRequestedOfOperator) {
    return { ball: 'you', because: 'a review was requested from you' }
  }

  // 4. A ticket assigned to the operator in a status that expects action.
  if (input.ticket?.assignedToOperator === true && input.ticket.actionable) {
    return { ball: 'you', because: 'the ticket is assigned to you and is actionable' }
  }

  // 5. Waiting on a review from someone else. This outranks a running agent:
  //    a review is a human action that nothing else can unblock, and the agent
  //    working alongside it is not the thing holding the item up.
  if (input.awaitingOthersReview) {
    return { ball: 'them', because: 'waiting on a review from someone else' }
  }

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
