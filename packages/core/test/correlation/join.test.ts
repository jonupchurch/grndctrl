import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { input, keys, session, THEM, ticket, hoursAgo } from './builders.js'

/**
 * The join, with two of its three providers removed.
 *
 * Most of this file described joining a ticket to a pull request, its checks and
 * its local checkout, and those cases are gone rather than adapted — there is
 * nothing to join them to. What is left is deliberately not just the residue:
 * the properties that were *stated* through those cases are re-stated through
 * the ones that remain, because they are still the properties that matter.
 *
 * - **One unit of work is one row** (FR-020) — asserted through a ticket with
 *   several sessions, where it used to be a ticket with several pull requests.
 * - **A row degrades rather than blanking** (XV) — asserted through a stale
 *   ticket rendered while the last refresh failed.
 * - **Output is deterministic** (FR-024) — unchanged.
 *
 * One property has genuinely gone rather than moved: a key matching no ticket
 * used to raise a dangling reference and *not* a work item, so a typo in a
 * branch name could not invent a row (FR-022). Nothing names a ticket from
 * outside Jira now, so there is no reference that could dangle.
 */

describe('the join', () => {
  it('builds one work item per ticket', () => {
    const { workItems } = correlate(input({ tickets: [ticket()] }))

    expect(workItems).toHaveLength(1)
    const item = workItems[0]!
    expect(item.key).toBe(keys.ticket('MERC-1184'))
    expect(item.ticket.issueKey).toBe('MERC-1184')
    expect(item.sessions).toHaveLength(0)
  })

  /**
   * FR-020, restated through the one thing that can still be several.
   *
   * It was "a ticket with three pull requests is one work item". Two agents on
   * one ticket is the same claim about the same rule: the number of rows is the
   * number of things you are working on, not the number of artefacts they made.
   */
  it('keeps a ticket with two agents on it as one work item', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        sessions: [session({ sessionId: 's1' }), session({ sessionId: 's2' })],
      }),
    )

    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.sessions).toHaveLength(2)
  })

  /**
   * A session reporting against a ticket that is not on the board is dropped.
   *
   * This is what is left of FR-022's shape: an agent can name any `workItemKey`
   * it likes, and one naming a ticket the operator does not have must not invent
   * a row for it. It is the same rule the dangling-reference machinery enforced
   * for branch names, at the one remaining place a key arrives from outside.
   */
  it('drops a session whose work item is not on the board, rather than inventing one', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ issueKey: 'MERC-1184' })],
        sessions: [session({ workItemKey: keys.ticket('MERC-9999') })],
      }),
    )

    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.key).toBe(keys.ticket('MERC-1184'))
    expect(workItems[0]!.sessions).toHaveLength(0)
  })

  it('gives a ticket with no agent on it a work item of its own', () => {
    const { workItems } = correlate(input({ tickets: [ticket()] }))
    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.sessions).toHaveLength(0)
  })

  /**
   * The note count is the row's own subject and nothing else.
   *
   * It used to sum the ticket, every pull request and every workspace on the
   * item — which is what the badge on a pull request row got wrong, showing the
   * whole item's total and then opening one subject's notes. There is one
   * subject per row now, so the count and what it opens cannot disagree.
   */
  it('counts notes on the ticket and not on anything else', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        noteCounts: {
          [keys.ticket('MERC-1184')]: 2,
          [keys.ticket('MERC-9999')]: 7,
        },
      }),
    )

    expect(workItems[0]!.noteCount).toBe(2)
  })

  it('sorts output deterministically', () => {
    const build = () =>
      correlate(
        input({
          tickets: [ticket({ issueKey: 'MERC-3' }), ticket({ issueKey: 'MERC-1' }), ticket({ issueKey: 'MERC-2' })],
        }),
      ).workItems.map((w) => w.key)

    expect(build()).toEqual(build())
    expect(build()).toEqual([
      keys.ticket('MERC-1'),
      keys.ticket('MERC-2'),
      keys.ticket('MERC-3'),
    ])
  })
})

/**
 * Constitution XV: a lane that blanks itself reads as "no work", which is the
 * opposite of true.
 *
 * The demonstration used to be richer — a work item whose *ticket* could not be
 * fetched still showed its branches, pull requests and notes. There is nothing
 * left to show without a ticket, so what `partial` marks is narrower: the rows
 * are the last ones that arrived, and what they say about themselves may be
 * behind.
 */
describe('partial resolution when the provider fails', () => {
  it('still renders cached tickets when the last refresh failed, and says so', () => {
    const { workItems } = correlate(
      input({ tickets: [ticket()], failedResourceKinds: ['tickets'] }),
    )

    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.resolution).toBe('partial')
    expect(workItems[0]!.ticket.issueKey).toBe('MERC-1184')
  })

  it('reports full resolution when the refresh succeeded', () => {
    const { workItems } = correlate(input({ tickets: [ticket()] }))
    expect(workItems[0]!.resolution).toBe('full')
  })
})

describe('sessions and ball-in-court', () => {
  it('reports the agent when a session is live and nothing is pending from a human', () => {
    const { workItems } = correlate(
      input({ tickets: [ticket({ assignee: THEM })], sessions: [session()] }),
    )

    expect(workItems[0]!.ballInCourt).toBe('agent')
  })

  it('moves ball-in-court to the operator when a question is open', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ assignee: THEM })],
        sessions: [session()],
        openQuestionSubjects: [keys.ticket('MERC-1184')],
      }),
    )

    expect(workItems[0]!.ballInCourt).toBe('you')
  })

  /**
   * FR-121, from the correlation side.
   *
   * A question opened on the *session* rather than on the ticket still reaches
   * the operator. 006 removed the region that displayed these, and this is one
   * of the two things that kept reading `notes.questions` — so it is asserted
   * here rather than assumed to have survived the deletion.
   */
  it('moves ball-in-court to the operator for a question opened on the session', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ assignee: THEM })],
        sessions: [session({ sessionId: 's1' })],
        openQuestionSubjects: [keys.session('s1')],
      }),
    )

    expect(workItems[0]!.ballInCourt).toBe('you')
  })

  it('marks a session silent after the heartbeat window and raises severity', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        // 60s interval x3 = 180s. Two hours of silence is well past it.
        sessions: [session({ lastHeartbeatAt: hoursAgo(2) })],
      }),
    )

    expect(workItems[0]!.severity).toBe('serious')
  })

  it('rolls activity up from the session, not just from the ticket', () => {
    const stale = ticket({ lastRealActivityAt: hoursAgo(200) })

    const withoutAgent = correlate(input({ tickets: [stale] })).workItems[0]!
    const withAgent = correlate(
      input({ tickets: [stale], sessions: [session({ lastRealActivityAt: hoursAgo(1) })] }),
    ).workItems[0]!

    // The ticket has not moved in over a week; the work has. This is the last
    // remaining case of activity happening somewhere the tracker cannot see it,
    // and it is the reason `workItemActivity` is still a maximum over sources.
    expect(withoutAgent.lastRealActivityAt).toBe(stale.lastRealActivityAt)
    expect(withAgent.lastRealActivityAt).toBe(hoursAgo(1))
    expect(withAgent.staleness).not.toBe(withoutAgent.staleness)
  })
})
