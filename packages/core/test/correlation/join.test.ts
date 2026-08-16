import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import {
  branch,
  check,
  input,
  keys,
  ME,
  pullRequest,
  session,
  THEM,
  ticket,
  workspace,
  hoursAgo,
} from './builders.js'

describe('the join', () => {
  it('joins a ticket, its branch, its PR, and its checks into one work item', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        pullRequests: [pullRequest()],
        checks: [check()],
        branches: [branch()],
        workspaces: [workspace()],
      }),
    )

    expect(workItems).toHaveLength(1)
    const item = workItems[0]!
    expect(item.key).toBe(keys.ticket('MERC-1184'))
    expect(item.ticket?.issueKey).toBe('MERC-1184')
    expect(item.pullRequests).toHaveLength(1)
    expect(item.workspaces).toHaveLength(1)
    expect(item.checks).toHaveLength(1)
  })

  // FR-020. The number of rows on the board should be the number of things you
  // are working on, not the number of artifacts they produced.
  it('keeps a ticket with three PRs as one work item', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        pullRequests: [
          pullRequest({ number: 451 }),
          pullRequest({ number: 452, headSha: 'd4e5f6' }),
          pullRequest({ number: 453, headSha: '778899' }),
        ],
      }),
    )

    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.pullRequests).toHaveLength(3)
  })

  // FR-022. A typo in a branch name must not invent a row.
  it('raises a dangling reference for a key matching no ticket, and no work item', () => {
    const { workItems, dangling } = correlate(
      input({
        tickets: [],
        pullRequests: [pullRequest({ headBranch: 'feature/MERC-9999' })],
      }),
    )

    expect(workItems).toHaveLength(0)
    expect(dangling).toHaveLength(1)
    expect(dangling[0]).toMatchObject({ issueKey: 'MERC-9999', source: 'branch' })
  })

  it('keys unlinked work on its branch so the PR and the local checkout land together', () => {
    const { workItems } = correlate(
      input({
        pullRequests: [pullRequest({ headBranch: 'spike/no-ticket', title: 'spike' })],
        workspaces: [workspace({ branch: 'spike/no-ticket' })],
      }),
    )

    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.key).toBe(keys.branch('spike/no-ticket'))
    expect(workItems[0]!.ticket).toBeNull()
    expect(workItems[0]!.pullRequests).toHaveLength(1)
    expect(workItems[0]!.workspaces).toHaveLength(1)
  })

  // A ticket with no code attached is not nothing — it is drift rule D3.
  it('gives a ticket with no branch and no PR a work item of its own', () => {
    const { workItems } = correlate(input({ tickets: [ticket()] }))
    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.pullRequests).toHaveLength(0)
  })

  it('matches on the branch before the PR title', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ issueKey: 'MERC-1184' }), ticket({ issueKey: 'MERC-2000' })],
        pullRequests: [
          pullRequest({ headBranch: 'feature/MERC-1184', title: 'relates to MERC-2000' }),
        ],
      }),
    )

    const withPr = workItems.find((w) => w.pullRequests.length > 0)
    expect(withPr?.key).toBe(keys.ticket('MERC-1184'))
  })

  it('attaches checks by head SHA, not by branch name', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        pullRequests: [pullRequest({ headSha: 'current' })],
        // A run from a commit that was force-pushed away. It must not be shown
        // as the current state of the PR.
        checks: [check({ sha: 'stale-force-pushed', name: 'build' })],
      }),
    )

    expect(workItems[0]!.checks).toHaveLength(0)
  })

  it('rolls note counts up from the ticket, its PRs, and its workspaces', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        pullRequests: [pullRequest()],
        workspaces: [workspace()],
        noteCounts: {
          [keys.ticket('MERC-1184')]: 2,
          [keys.pr(451)]: 1,
          [keys.workspace('feature/MERC-1184')]: 3,
        },
      }),
    )

    expect(workItems[0]!.noteCount).toBe(6)
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
 * Constitution XV: a work item whose ticket cannot be fetched still shows its
 * branches, PRs, and notes, marked partially resolved rather than hidden. A
 * lane that blanks itself reads as "no work", which is the opposite of true.
 */
describe('partial resolution when a provider fails', () => {
  it('still renders the work when the ticket provider failed', () => {
    const { workItems } = correlate(
      input({
        tickets: [],
        pullRequests: [pullRequest()],
        workspaces: [workspace()],
        failedResourceKinds: ['tickets'],
      }),
    )

    expect(workItems).toHaveLength(1)
    expect(workItems[0]!.resolution).toBe('partial')
    expect(workItems[0]!.pullRequests).toHaveLength(1)
    expect(workItems[0]!.workspaces).toHaveLength(1)
  })

  it('marks an item partial when a provider it draws from failed', () => {
    const { workItems } = correlate(
      input({ tickets: [ticket()], pullRequests: [pullRequest()], failedResourceKinds: ['pulls'] }),
    )
    expect(workItems[0]!.resolution).toBe('partial')
  })

  it('reports full resolution when everything succeeded', () => {
    const { workItems } = correlate(input({ tickets: [ticket()], pullRequests: [pullRequest()] }))
    expect(workItems[0]!.resolution).toBe('full')
  })

  // Absence of evidence is not evidence of orphaning. With the branch list
  // unfetched, calling every workspace orphaned would light the whole board up.
  it('does not call a workspace orphaned when the branch list was never fetched', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket()],
        workspaces: [workspace()],
        branches: [],
        failedResourceKinds: ['branches'],
      }),
    )

    expect(workItems[0]!.severity).not.toBe('critical')
  })
})

describe('sessions and ball-in-court', () => {
  it('reports the agent when a session is live and nothing is pending from a human', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ assignee: THEM })],
        sessions: [session()],
      }),
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

  it('reports the operator when a review was requested of them', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ assignee: THEM })],
        pullRequests: [pullRequest({ author: THEM, requestedReviewers: [ME] })],
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
})
