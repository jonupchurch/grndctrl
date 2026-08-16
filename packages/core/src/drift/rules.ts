import type { DriftFinding, DriftRule, Settings, WorkItem } from '../domain/types.js'
import type { DanglingReference } from '../correlation/join.js'
import { findingId } from './id.js'

/**
 * The nine v1 drift rules (FR-035).
 *
 * A drift finding is the product's whole reason to exist: nothing else the
 * operator uses knows that the ticket and the PR contradict each other. Which
 * also makes this the one place a subtle bug produces confident, plausible,
 * wrong output — a false "your ticket is in review but the PR merged" is worse
 * than showing nothing, because the user will act on it.
 *
 * So every rule here is a pure function of a work item and the settings, and
 * every one has both a test that fires it and a test that correctly declines
 * (constitution XVIII). A rule with only a firing test can fire on everything
 * and still pass.
 */

export interface DriftInput {
  workItems: readonly WorkItem[]
  dangling: readonly DanglingReference[]
  settings: Settings
  now: Date
}

export function detectDrift(input: DriftInput): DriftFinding[] {
  const findings: DriftFinding[] = []

  for (const item of input.workItems) {
    for (const rule of RULES) {
      const finding = rule(item, input)
      if (finding !== null) findings.push(finding)
    }
  }

  findings.push(...d6UnknownKey(input))

  // Sorted so ten runs over identical input are byte-identical (FR-024).
  return findings.sort((a, b) => a.id.localeCompare(b.id))
}

type Rule = (item: WorkItem, input: DriftInput) => DriftFinding | null

const hoursBetween = (from: string | null, now: Date): number | null => {
  if (from === null) return null
  const t = Date.parse(from)
  return Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000
}

const secondsSince = (from: string | null, now: Date): number => {
  if (from === null) return 0
  const t = Date.parse(from)
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now.getTime() - t) / 1000))
}

function make(
  rule: DriftRule,
  item: Pick<WorkItem, 'key' | 'projectId'>,
  parts: {
    summary: string
    evidence: DriftFinding['evidence']
    ageSec: number
    suggestedAction: DriftFinding['suggestedAction']
    dispatchable: boolean
  },
): DriftFinding {
  return {
    id: findingId(rule, item.key),
    rule,
    subjectKey: item.key,
    projectId: item.projectId,
    ...parts,
  }
}

/**
 * D1 — the ticket is not done, but the work is.
 *
 * **Deviation from FR-035, deliberate.** The spec says "its *only* PR merged".
 * Implemented as "every PR merged, and at least one exists": with three PRs
 * where two merged and one is still open, the work is not finished and telling
 * the operator to close the ticket would be wrong. The literal reading fires on
 * fewer real situations and gets one of them actively wrong.
 */
const d1: Rule = (item, { settings, now }) => {
  if (item.ticket === null || item.ticket.statusCategory === 'done') return null
  if (item.pullRequests.length === 0) return null
  if (!item.pullRequests.every((pr) => pr.state === 'merged')) return null

  const mergedAts = item.pullRequests.map((pr) => pr.mergedAt).filter((m): m is string => m !== null)
  if (mergedAts.length === 0) return null

  const mostRecent = mergedAts.sort().at(-1) ?? null
  const hours = hoursBetween(mostRecent, now)
  if (hours === null || hours < settings.driftGraceHours) return null

  const pr = item.pullRequests[0]!

  return make('D1', item, {
    summary: `${item.ticket.issueKey} is ${item.ticket.statusName}, but ${
      item.pullRequests.length === 1 ? `PR #${pr.number}` : 'every PR'
    } merged ${Math.floor(hours / 24)}d ago.`,
    evidence: [
      { side: 'ticket', fact: `status is ${item.ticket.statusName}`, at: item.ticket.lastStatusChangeAt },
      { side: 'pull request', fact: 'merged', at: mostRecent },
    ],
    ageSec: secondsSince(mostRecent, now),
    suggestedAction: { kind: 'transition-ticket', label: 'Move to Done' },
    dispatchable: true,
  })
}

/** D2 — work is underway but the ticket still says it has not started. */
const d2: Rule = (item, { now }) => {
  if (item.ticket === null || item.ticket.statusCategory !== 'new') return null

  const hasWork =
    item.pullRequests.length > 0 ||
    item.workspaces.length > 0 ||
    item.sessions.some((s) => s.endedAt === null)
  if (!hasWork) return null

  const evidenceAt =
    item.sessions.find((s) => s.endedAt === null)?.startedAt ??
    item.pullRequests[0]?.lastRealActivityAt ??
    item.workspaces[0]?.readAt ??
    null

  return make('D2', item, {
    summary: `${item.ticket.issueKey} is ${item.ticket.statusName}, but work has started on it.`,
    evidence: [
      { side: 'ticket', fact: `status is ${item.ticket.statusName}`, at: item.ticket.lastStatusChangeAt },
      {
        side: 'work',
        fact: describeWork(item),
        at: evidenceAt,
      },
    ],
    ageSec: secondsSince(evidenceAt, now),
    suggestedAction: { kind: 'transition-ticket', label: 'Move to In Progress' },
    dispatchable: true,
  })
}

/** D3 — the ticket says it is being worked on, and nothing anywhere agrees. */
const d3: Rule = (item, { settings, now }) => {
  if (item.ticket === null || item.ticket.statusCategory !== 'indeterminate') return null
  if (item.pullRequests.length > 0 || item.workspaces.length > 0) return null
  if (item.sessions.length > 0) return null

  const hours = hoursBetween(item.ticket.lastStatusChangeAt, now)
  // Unknown history is not evidence of neglect. Firing here would flag every
  // ticket whose changelog failed to fetch (R2).
  if (hours === null || hours < settings.laneThresholdHours.tickets) return null

  return make('D3', item, {
    summary: `${item.ticket.issueKey} has been ${item.ticket.statusName} for ${Math.floor(
      hours / 24,
    )}d with no branch, PR, or session.`,
    evidence: [
      { side: 'ticket', fact: `status is ${item.ticket.statusName}`, at: item.ticket.lastStatusChangeAt },
      { side: 'code', fact: 'no branch, pull request, or agent session found', at: null },
    ],
    ageSec: secondsSince(item.ticket.lastStatusChangeAt, now),
    suggestedAction: { kind: 'investigate', label: 'Investigate' },
    dispatchable: false,
  })
}

/** D4 — the ticket was closed while its pull request is still open. */
const d4: Rule = (item, { now }) => {
  if (item.ticket === null || item.ticket.statusCategory !== 'done') return null

  const open = item.pullRequests.filter((pr) => pr.state === 'open')
  if (open.length === 0) return null

  const pr = open[0]!

  return make('D4', item, {
    summary: `${item.ticket.issueKey} is ${item.ticket.statusName}, but PR #${pr.number} is still open.`,
    evidence: [
      { side: 'ticket', fact: `status is ${item.ticket.statusName}`, at: item.ticket.lastStatusChangeAt },
      { side: 'pull request', fact: `#${pr.number} is open`, at: pr.lastRealActivityAt },
    ],
    ageSec: secondsSince(item.ticket.lastStatusChangeAt, now),
    suggestedAction: { kind: 'investigate', label: 'Reopen or close the PR' },
    dispatchable: false,
  })
}

/** D5 — the PR merged, and a local checkout still holds work that never went in. */
const d5: Rule = (item, { now }) => {
  const merged = item.pullRequests.filter((pr) => pr.state === 'merged')
  if (merged.length === 0) return null

  const stranded = item.workspaces.filter(
    (ws) => ws.hasUncommittedChanges || (ws.unpushedCommitCount ?? 0) > 0,
  )
  if (stranded.length === 0) return null

  const ws = stranded[0]!
  const mergedAt = merged.map((pr) => pr.mergedAt).filter((m): m is string => m !== null).sort().at(-1) ?? null

  return make('D5', item, {
    summary: `PR #${merged[0]!.number} merged, but ${ws.branch} still has ${
      ws.hasUncommittedChanges ? 'uncommitted changes' : `${ws.unpushedCommitCount} unpushed commits`
    }.`,
    evidence: [
      { side: 'pull request', fact: 'merged', at: mergedAt },
      {
        side: 'workspace',
        fact: ws.hasUncommittedChanges
          ? `uncommitted changes in ${ws.repoPath}`
          : `${ws.unpushedCommitCount} unpushed commits in ${ws.repoPath}`,
        at: ws.readAt,
      },
    ],
    ageSec: secondsSince(mergedAt, now),
    suggestedAction: { kind: 'cleanup-workspace', label: 'Clean up the workspace' },
    dispatchable: true,
  })
}

/**
 * D6 — a branch or PR names a ticket that does not exist.
 *
 * Operates on dangling references rather than work items, because by
 * construction these produced no work item (FR-022).
 */
function d6UnknownKey({ dangling, now }: DriftInput): DriftFinding[] {
  const seen = new Set<string>()
  const findings: DriftFinding[] = []

  for (const d of dangling) {
    const id = findingId('D6', d.fromKey)
    if (seen.has(id)) continue
    seen.add(id)

    findings.push({
      id,
      rule: 'D6',
      subjectKey: d.fromKey,
      projectId: d.projectId,
      summary: `${d.fromKey} references ${d.issueKey}, which exists in no bound project.`,
      evidence: [
        { side: 'code', fact: `${d.source} names ${d.issueKey}`, at: null },
        { side: 'ticket', fact: 'no such ticket in any bound project', at: null },
      ],
      ageSec: secondsSince(null, now),
      suggestedAction: { kind: 'investigate', label: 'Correct the key or bind the project' },
      dispatchable: false,
    })
  }

  return findings
}

/** D7 — an agent has been running for a long time and the ticket never moved. */
const d7: Rule = (item, { settings, now }) => {
  if (item.ticket === null) return null

  const live = item.sessions.filter((s) => s.endedAt === null)
  if (live.length === 0) return null

  const session = live.sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]!
  const runningHours = hoursBetween(session.startedAt, now)
  if (runningHours === null || runningHours < settings.laneThresholdHours.pulls) return null

  // The question is whether the *ticket moved*, so this reads the status change
  // rather than any activity -- a comment is not a transition.
  const movedSinceStart =
    item.ticket.lastStatusChangeAt !== null &&
    Date.parse(item.ticket.lastStatusChangeAt) >= Date.parse(session.startedAt)
  if (movedSinceStart) return null

  return make('D7', item, {
    summary: `An agent has been working on ${item.ticket.issueKey} for ${Math.floor(
      runningHours,
    )}h with no ticket transition.`,
    evidence: [
      { side: 'session', fact: `${session.agentId} started`, at: session.startedAt },
      {
        side: 'ticket',
        fact: `still ${item.ticket.statusName}`,
        at: item.ticket.lastStatusChangeAt,
      },
    ],
    ageSec: secondsSince(session.startedAt, now),
    suggestedAction: { kind: 'investigate', label: 'Check the session' },
    dispatchable: false,
  })
}

/** D8 — the ticket is in review and nobody was ever asked to review it. */
const d8: Rule = (item, { now }) => {
  if (item.ticket === null) return null
  if (!isReviewStatus(item.ticket.statusName)) return null

  const open = item.pullRequests.filter((pr) => pr.state === 'open' && !pr.isDraft)
  if (open.length === 0) return null

  const unrequested = open.filter(
    (pr) => pr.requestedReviewers.length === 0 && pr.reviewDecision !== 'approved',
  )
  if (unrequested.length === 0) return null

  const pr = unrequested[0]!

  return make('D8', item, {
    summary: `${item.ticket.issueKey} is ${item.ticket.statusName}, but PR #${pr.number} has no reviewer requested.`,
    evidence: [
      { side: 'ticket', fact: `status is ${item.ticket.statusName}`, at: item.ticket.lastStatusChangeAt },
      { side: 'pull request', fact: `#${pr.number} has no requested reviewers`, at: pr.lastRealActivityAt },
    ],
    ageSec: secondsSince(item.ticket.lastStatusChangeAt, now),
    suggestedAction: { kind: 'request-review', label: 'Request a review' },
    dispatchable: true,
  })
}

/** D9 — real work with no ticket behind it. */
const d9: Rule = (item, { now }) => {
  if (item.ticket !== null) return null
  if (item.pullRequests.length === 0 && item.workspaces.length === 0) return null

  // A local branch nobody has pushed is a scratch branch, not drift. Flagging
  // every experiment would train the operator to ignore this rule.
  const hasPushedWork =
    item.pullRequests.length > 0 || item.workspaces.some((ws) => ws.upstreamRef !== null)
  if (!hasPushedWork) return null

  const at = item.pullRequests[0]?.lastRealActivityAt ?? item.workspaces[0]?.readAt ?? null

  return make('D9', item, {
    summary: `${describeWork(item)} with no ticket key.`,
    evidence: [
      { side: 'code', fact: describeWork(item), at },
      { side: 'ticket', fact: 'no ticket key in the branch name, PR title, or body', at: null },
    ],
    ageSec: secondsSince(at, now),
    suggestedAction: { kind: 'investigate', label: 'Link it to a ticket' },
    dispatchable: false,
  })
}

const RULES: readonly Rule[] = [d1, d2, d3, d4, d5, d7, d8, d9]

function describeWork(item: WorkItem): string {
  const parts: string[] = []
  if (item.pullRequests.length > 0) {
    parts.push(`PR #${item.pullRequests.map((p) => p.number).join(', #')}`)
  }
  if (item.workspaces.length > 0) parts.push(`branch ${item.workspaces[0]!.branch}`)
  if (item.sessions.some((s) => s.endedAt === null)) parts.push('an agent session')
  return parts.join(' and ') || 'work'
}

/**
 * Status-name matching, and the one place the rules do it.
 *
 * Everywhere else reads `statusCategory`, because a name match breaks the
 * moment a team renames a column. Jira has no category for "in review" — it is
 * `indeterminate` like every other in-progress state — so D8 has no alternative.
 * A per-project override is the escape hatch when the heuristic is wrong.
 */
function isReviewStatus(statusName: string): boolean {
  return /review|qa|verify/i.test(statusName)
}
