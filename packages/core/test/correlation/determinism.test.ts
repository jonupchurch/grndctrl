import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { detectDrift } from '../../src/drift/rules.js'
import {
  branch,
  check,
  hoursAgo,
  input,
  keys,
  project,
  pullRequest,
  session,
  settings,
  ticket,
  workspace,
  NOW,
} from './builders.js'

/**
 * SC-004: ten consecutive runs over identical inputs produce byte-identical
 * output, including finding identifiers.
 *
 * This is not a performance property, it is a correctness one. Correlation
 * output drives dismissals (keyed on finding id), note attachment (keyed on
 * natural key), and a UI that re-renders every poll. Non-determinism there
 * looks like a board that flickers and dismissals that evaporate — symptoms
 * nobody would trace back to iteration order.
 */

/** A board with every shape the engine handles, so the check has surface area. */
function busyBoard() {
  const projects = [
    project(),
    project({
      id: 'p-atls',
      code: 'ATLS',
      jiraProjectKey: 'ATLS',
      ticketKeyPattern: '(ATLS-\\d+)',
      repoOwner: 'acme',
      repoName: 'atlas',
    }),
  ]

  return input({
    projects,
    tickets: [
      ticket({ issueKey: 'MERC-1184', statusName: 'In Review' }),
      ticket({ issueKey: 'MERC-1190', statusCategory: 'new', statusName: 'Todo' }),
      ticket({ issueKey: 'MERC-9000', statusCategory: 'done', statusName: 'Done' }),
      ticket({ issueKey: 'MERC-7', lastStatusChangeAt: hoursAgo(400) }),
    ],
    pullRequests: [
      pullRequest({ number: 451, headBranch: 'feature/MERC-1184' }),
      pullRequest({ number: 452, headBranch: 'feature/MERC-1184', headSha: 'b2' }),
      pullRequest({ number: 453, headBranch: 'feature/MERC-1190', headSha: 'c3', state: 'merged', mergedAt: hoursAgo(80) }),
      pullRequest({ number: 454, headBranch: 'feature/MERC-9000', headSha: 'd4' }),
      pullRequest({ number: 455, headBranch: 'spike/no-ticket', headSha: 'e5', title: 'spike' }),
      pullRequest({ number: 456, headBranch: 'feature/MERC-9999', headSha: 'f6' }),
    ],
    checks: [check({ sha: 'a1b2c3', name: 'build', state: 'failure' }), check({ sha: 'b2', name: 'lint' })],
    branches: [branch({ name: 'feature/MERC-1184' }), branch({ name: 'spike/no-ticket' })],
    workspaces: [
      workspace({ branch: 'feature/MERC-1184', hasUncommittedChanges: true }),
      workspace({ branch: 'feature/MERC-1190' }),
      workspace({ branch: 'scratch/local', upstreamRef: null }),
    ],
    sessions: [session({ sessionId: 's1' }), session({ sessionId: 's2', lastHeartbeatAt: hoursAgo(5) })],
    noteCounts: { 'jira:acme.atlassian.net/MERC-1184': 3 },
    openQuestionSubjects: ['jira:acme.atlassian.net/MERC-1190'],
  })
}

describe('determinism', () => {
  it('produces byte-identical correlation output across ten runs', () => {
    const runs = Array.from({ length: 10 }, () => JSON.stringify(correlate(busyBoard())))
    expect(new Set(runs).size).toBe(1)
  })

  it('produces byte-identical drift findings across ten runs, including ids', () => {
    const runs = Array.from({ length: 10 }, () => {
      const ci = busyBoard()
      const { workItems, dangling } = correlate(ci)
      return JSON.stringify(detectDrift({ workItems, dangling, settings: settings(), now: NOW }))
    })

    expect(new Set(runs).size).toBe(1)
  })

  // Provider responses arrive in whatever order the API felt like. If input
  // order leaked into output order, the board would reshuffle every poll.
  it('is unaffected by the order the inputs arrive in', () => {
    const forward = busyBoard()
    const reversed = {
      ...forward,
      tickets: [...forward.tickets].reverse(),
      pullRequests: [...forward.pullRequests].reverse(),
      workspaces: [...forward.workspaces].reverse(),
      sessions: [...forward.sessions].reverse(),
      checks: [...forward.checks].reverse(),
      branches: [...forward.branches].reverse(),
    }

    expect(JSON.stringify(correlate(reversed))).toBe(JSON.stringify(correlate(forward)))
  })

  it('keeps finding ids stable when unrelated inputs change', () => {
    const before = busyBoard()
    const ci = correlate(before)
    const idsBefore = detectDrift({
      workItems: ci.workItems,
      dangling: ci.dangling,
      settings: settings(),
      now: NOW,
    }).map((f) => f.id)

    // A note count changing must not renumber anything -- a dismissal is keyed
    // on the id, and renaming it silently un-dismisses the finding.
    const after = { ...before, noteCounts: { ...before.noteCounts, 'gh:acme/mercury#451': 9 } }
    const ci2 = correlate(after)
    const idsAfter = detectDrift({
      workItems: ci2.workItems,
      dangling: ci2.dangling,
      settings: settings(),
      now: NOW,
    }).map((f) => f.id)

    expect(idsAfter).toEqual(idsBefore)
  })

  it('produces a non-trivial board, so the check has something to check', () => {
    const ci = correlate(busyBoard())
    const findings = detectDrift({
      workItems: ci.workItems,
      dangling: ci.dangling,
      settings: settings(),
      now: NOW,
    })

    // Guards against the failure mode where all ten runs agree on nothing.
    expect(ci.workItems.length).toBeGreaterThan(4)
    expect(findings.length).toBeGreaterThan(2)
  })
})

/**
 * `comparisons` was an input nothing read.
 *
 * The compare path — the aliased batch query R3 exists to make affordable —
 * fetched ahead/behind, stored it, and dropped it here. Nothing failed: the
 * field was simply never consulted, and the renderer printed "in sync" over the
 * gap. Correlation is the only place that can join it, because a comparison is
 * keyed by branch and a work item is keyed by ticket.
 */
describe('comparisons reach the work item', () => {
  const comparisonFixture = {
    branchKey: keys.branch('MERC-1184'),
    baseRef: 'main',
    aheadBy: 2,
    behindBy: 7,
    comparedAtSha: 'abc123',
    fetchedAt: hoursAgo(1),
  }

  it('attaches the comparison for a branch the item owns', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ issueKey: 'MERC-1184' })],
        workspaces: [workspace({ branch: 'MERC-1184' })],
        comparisons: [comparisonFixture],
      }),
    )

    const item = workItems.find((w) => w.ticket?.issueKey === 'MERC-1184')
    expect(item?.comparisons).toHaveLength(1)
    expect(item?.comparisons[0]).toMatchObject({ aheadBy: 2, behindBy: 7 })
  })

  it('leaves it empty for a branch the host has never seen', () => {
    const { workItems } = correlate(
      input({
        tickets: [ticket({ issueKey: 'MERC-1184' })],
        workspaces: [workspace({ branch: 'MERC-1184' })],
        comparisons: [],
      }),
    )

    // Empty, not zeroed. "We did not ask" and "no commits ahead" are different
    // answers and the interface has to be able to tell them apart (FR-018).
    expect(workItems.find((w) => w.ticket?.issueKey === 'MERC-1184')?.comparisons).toEqual([])
  })
})
