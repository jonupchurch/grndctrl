import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { detectDrift } from '../../src/drift/rules.js'
import type { DriftRule } from '../../src/domain/types.js'
import {
  hoursAgo,
  input,
  pullRequest,
  session,
  settings,
  ticket,
  workspace,
  NOW,
} from '../correlation/builders.js'
import type { CorrelationInput } from '../../src/correlation/join.js'

/**
 * Constitution XVIII: every drift rule gets a test that produces it and a test
 * that correctly declines to.
 *
 * The declining half is not symmetry for its own sake. A rule with only a
 * firing test can fire on everything and still pass — and a false "your ticket
 * is in review but the PR merged" is worse than showing nothing, because the
 * operator will act on it.
 */

function rulesFor(over: Partial<CorrelationInput>): DriftRule[] {
  const correlationInput = input(over)
  const { workItems, dangling } = correlate(correlationInput)
  return detectDrift({
    workItems,
    dangling,
    settings: correlationInput.settings,
    now: correlationInput.now,
  }).map((f) => f.rule)
}

const fires = (rule: DriftRule, over: Partial<CorrelationInput>) =>
  expect(rulesFor(over)).toContain(rule)

const declines = (rule: DriftRule, over: Partial<CorrelationInput>) =>
  expect(rulesFor(over)).not.toContain(rule)

// ---------------------------------------------------------------------------

describe('D1 — ticket not done, work is', () => {
  it('fires when every PR merged more than the grace period ago', () => {
    fires('D1', {
      tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(72) })],
    })
  })

  // The grace period exists because a ticket transition trails a merge by
  // minutes in a healthy team. Firing immediately would flag normal work.
  it('declines inside the grace period', () => {
    declines('D1', {
      tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(2) })],
    })
  })

  // The deviation from the literal spec text, asserted: with one PR still open
  // the work is not finished, and telling the operator to close would be wrong.
  it('declines when one of several PRs is still open', () => {
    declines('D1', {
      tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
      pullRequests: [
        pullRequest({ number: 451, state: 'merged', mergedAt: hoursAgo(72) }),
        pullRequest({ number: 452, state: 'open', headSha: 'other' }),
      ],
    })
  })

  it('declines when the ticket is already done', () => {
    declines('D1', {
      tickets: [ticket({ statusName: 'Done', statusCategory: 'done' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(72) })],
    })
  })
})

describe('D2 — work started, ticket says it has not', () => {
  it('fires when a backlog ticket has an active session', () => {
    fires('D2', {
      tickets: [ticket({ statusName: 'Todo', statusCategory: 'new' })],
      sessions: [session()],
    })
  })

  it('fires when a backlog ticket has a pull request', () => {
    fires('D2', {
      tickets: [ticket({ statusName: 'Todo', statusCategory: 'new' })],
      pullRequests: [pullRequest()],
    })
  })

  it('declines for a backlog ticket with no work anywhere', () => {
    declines('D2', { tickets: [ticket({ statusName: 'Todo', statusCategory: 'new' })] })
  })
})

describe('D3 — ticket in progress, nothing to show for it', () => {
  it('fires past the lane threshold with no branch, PR, or session', () => {
    fires('D3', {
      tickets: [
        ticket({ statusCategory: 'indeterminate', lastStatusChangeAt: hoursAgo(200) }),
      ],
    })
  })

  it('declines when a branch exists', () => {
    declines('D3', {
      tickets: [ticket({ statusCategory: 'indeterminate', lastStatusChangeAt: hoursAgo(200) })],
      workspaces: [workspace()],
    })
  })

  // Unknown history is not evidence of neglect. Firing here would flag every
  // ticket whose changelog failed to fetch (research R2).
  it('declines when the status-change time is unknown', () => {
    declines('D3', {
      tickets: [ticket({ statusCategory: 'indeterminate', lastStatusChangeAt: null })],
    })
  })
})

describe('D4 — ticket closed, PR still open', () => {
  it('fires when a done ticket has an open PR', () => {
    fires('D4', {
      tickets: [ticket({ statusName: 'Done', statusCategory: 'done' })],
      pullRequests: [pullRequest({ state: 'open' })],
    })
  })

  it('declines when the PR merged too', () => {
    declines('D4', {
      tickets: [ticket({ statusName: 'Done', statusCategory: 'done' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(50) })],
    })
  })
})

describe('D5 — PR merged, local work stranded', () => {
  it('fires when a workspace still holds uncommitted changes', () => {
    fires('D5', {
      tickets: [ticket()],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(30) })],
      workspaces: [workspace({ hasUncommittedChanges: true })],
    })
  })

  it('fires when a workspace still holds unpushed commits', () => {
    fires('D5', {
      tickets: [ticket()],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(30) })],
      workspaces: [workspace({ unpushedCommitCount: 3 })],
    })
  })

  it('declines when the workspace is clean', () => {
    declines('D5', {
      tickets: [ticket()],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(30) })],
      workspaces: [workspace({ hasUncommittedChanges: false, unpushedCommitCount: 0 })],
    })
  })
})

describe('D6 — a key that names no ticket', () => {
  it('fires for a branch referencing a ticket that does not exist', () => {
    fires('D6', { pullRequests: [pullRequest({ headBranch: 'feature/MERC-9999' })] })
  })

  it('declines when the ticket exists', () => {
    declines('D6', { tickets: [ticket()], pullRequests: [pullRequest()] })
  })

  // A branch with no key at all is D9's business, not D6's.
  it('declines for a branch carrying no key', () => {
    declines('D6', { pullRequests: [pullRequest({ headBranch: 'spike/x', title: 'spike' })] })
  })
})

describe('D7 — agent running, ticket never moved', () => {
  it('fires when a long-running session has produced no transition', () => {
    fires('D7', {
      tickets: [ticket({ lastStatusChangeAt: hoursAgo(100) })],
      sessions: [session({ startedAt: hoursAgo(50) })],
    })
  })

  // Reads the status change specifically, not any activity: a comment is not a
  // transition, and treating it as one would silence the rule constantly.
  it('declines when the ticket moved after the session started', () => {
    declines('D7', {
      tickets: [ticket({ lastStatusChangeAt: hoursAgo(10) })],
      sessions: [session({ startedAt: hoursAgo(50) })],
    })
  })

  it('declines for a session that has only just started', () => {
    declines('D7', {
      tickets: [ticket({ lastStatusChangeAt: hoursAgo(100) })],
      sessions: [session({ startedAt: hoursAgo(1) })],
    })
  })
})

describe('D8 — in review, nobody asked to review', () => {
  it('fires when an open PR has no requested reviewers', () => {
    fires('D8', {
      tickets: [ticket({ statusName: 'In Review' })],
      pullRequests: [pullRequest({ state: 'open', requestedReviewers: [] })],
    })
  })

  it('declines when a reviewer was requested', () => {
    declines('D8', {
      tickets: [ticket({ statusName: 'In Review' })],
      pullRequests: [
        pullRequest({
          state: 'open',
          requestedReviewers: [{ accountId: 'them', displayName: 'Sam', email: null }],
        }),
      ],
    })
  })

  // A draft is not asking for review yet, so nobody is missing.
  it('declines for a draft PR', () => {
    declines('D8', {
      tickets: [ticket({ statusName: 'In Review' })],
      pullRequests: [pullRequest({ state: 'open', isDraft: true })],
    })
  })

  it('declines when the PR is already approved', () => {
    declines('D8', {
      tickets: [ticket({ statusName: 'In Review' })],
      pullRequests: [pullRequest({ state: 'open', reviewDecision: 'approved' })],
    })
  })
})

describe('D9 — work with no ticket', () => {
  it('fires for a pull request with no ticket key anywhere', () => {
    fires('D9', {
      pullRequests: [pullRequest({ headBranch: 'spike/limiter', title: 'spike: limiter' })],
    })
  })

  // A local branch nobody has pushed is a scratch branch. Flagging every
  // experiment would train the operator to ignore this rule.
  it('declines for an unpushed local scratch branch', () => {
    declines('D9', {
      workspaces: [workspace({ branch: 'scratch/idea', upstreamRef: null })],
    })
  })

  it('declines when the work has a ticket', () => {
    declines('D9', { tickets: [ticket()], pullRequests: [pullRequest()] })
  })
})

// ---------------------------------------------------------------------------

describe('the rule set as a whole', () => {
  it('produces nothing for a healthy work item', () => {
    expect(
      rulesFor({
        tickets: [ticket({ statusName: 'In Progress', statusCategory: 'indeterminate' })],
        pullRequests: [pullRequest({ state: 'open', requestedReviewers: [] })],
        workspaces: [workspace()],
      }),
    ).toEqual([])
  })

  it('has both a firing and a declining case for every rule', () => {
    const ALL: DriftRule[] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9']
    // Sanity check on this file itself: each rule is demonstrably reachable.
    const reachable = new Set([
      ...rulesFor({
        tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
        pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(72) })],
      }),
      ...rulesFor({ tickets: [ticket({ statusCategory: 'new' })], sessions: [session()] }),
      ...rulesFor({ tickets: [ticket({ lastStatusChangeAt: hoursAgo(200) })] }),
      ...rulesFor({
        tickets: [ticket({ statusCategory: 'done' })],
        pullRequests: [pullRequest({ state: 'open' })],
      }),
      ...rulesFor({
        tickets: [ticket()],
        pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(30) })],
        workspaces: [workspace({ hasUncommittedChanges: true })],
      }),
      ...rulesFor({ pullRequests: [pullRequest({ headBranch: 'feature/MERC-9999' })] }),
      ...rulesFor({
        tickets: [ticket({ lastStatusChangeAt: hoursAgo(100) })],
        sessions: [session({ startedAt: hoursAgo(50) })],
      }),
      ...rulesFor({
        tickets: [ticket({ statusName: 'In Review' })],
        pullRequests: [pullRequest({ state: 'open' })],
      }),
      ...rulesFor({ pullRequests: [pullRequest({ headBranch: 'spike/x', title: 'spike' })] }),
    ])

    expect([...reachable].sort()).toEqual(ALL)
  })

  it('respects a configured grace period', () => {
    const over = {
      tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(48) })],
    }

    expect(rulesFor({ ...over, settings: settings({ driftGraceHours: 24 }) })).toContain('D1')
    expect(rulesFor({ ...over, settings: settings({ driftGraceHours: 72 }) })).not.toContain('D1')
  })

  it('is deterministic across runs', () => {
    const build = () =>
      rulesFor({
        tickets: [
          ticket({ issueKey: 'MERC-1', statusCategory: 'done' }),
          ticket({ issueKey: 'MERC-2', statusCategory: 'new' }),
        ],
        pullRequests: [
          pullRequest({ number: 1, headBranch: 'feature/MERC-1', state: 'open' }),
          pullRequest({ number: 2, headBranch: 'feature/MERC-2', headSha: 'b2' }),
        ],
      })

    expect(build()).toEqual(build())
  })

  it('carries both sides of the evidence with timestamps', () => {
    const correlationInput = input({
      tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(72) })],
    })
    const { workItems, dangling } = correlate(correlationInput)
    const findings = detectDrift({ workItems, dangling, settings: settings(), now: NOW })
    const d1 = findings.find((f) => f.rule === 'D1')

    expect(d1?.evidence).toHaveLength(2)
    expect(d1?.evidence.map((e) => e.side)).toEqual(['ticket', 'pull request'])
    expect(d1?.evidence[1]?.at).toBe(hoursAgo(72))
    expect(d1?.suggestedAction?.kind).toBe('transition-ticket')
    expect(d1?.dispatchable).toBe(true)
  })
})
