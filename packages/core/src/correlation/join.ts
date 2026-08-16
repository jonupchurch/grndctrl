import { branchKey as makeBranchKey, type NaturalKey } from '../domain/keys.js'
import { sessionStateOf } from '../domain/sessions.js'
import type {
  AgentSession,
  BranchRef,
  CheckResult,
  Comparison,
  LocalWorkspace,
  Project,
  PullRequest,
  ResourceKind,
  Settings,
  Ticket,
  WorkItem,
} from '../domain/types.js'
import { workItemActivity } from './activity.js'
import { ballInCourt } from './ball.js'
import { matchBranch, matchPullRequest, type MatchSource } from './match.js'
import { severityOf } from './severity.js'
import { stalenessBand, thresholdMultiple } from './staleness.js'

/**
 * The join: ticket ↔ workspace ↔ PR ↔ commits ↔ CI, into work items.
 *
 * Pure. No I/O, no clock of its own, no provider types — plain domain data in,
 * plain data out. That is what constitution XVIII requires and what makes the
 * fixture suite possible with no network, no display, and Electron uninstalled.
 *
 * Two rules shape everything here:
 *
 *   **One unit of work is one row.** A ticket with three PRs is one work item
 *   with three PRs (FR-020), keyed on the ticket. Work with no ticket keys on
 *   its branch, so a PR and the local checkout of the same branch land together
 *   rather than as two half-rows.
 *
 *   **A key that matches no ticket is a finding, not a work item** (FR-022).
 *   Rendering it as work would invent a row for a typo.
 */

export interface DanglingReference {
  /** The ticket key that was referenced but does not exist. */
  issueKey: string
  source: MatchSource
  /** The PR or branch that referenced it. */
  fromKey: NaturalKey
  projectId: string
}

export interface CorrelationInput {
  projects: readonly Project[]
  tickets: readonly Ticket[]
  pullRequests: readonly PullRequest[]
  checks: readonly CheckResult[]
  branches: readonly BranchRef[]
  comparisons: readonly Comparison[]
  workspaces: readonly LocalWorkspace[]
  sessions: readonly AgentSession[]
  /** Note count per subject natural key. */
  noteCounts: Readonly<Record<string, number>>
  /** Subjects carrying an unresolved `question-for-human` note. */
  openQuestionSubjects: readonly string[]
  /** Provider account ids that are the operator. Resolved per account (FR-033). */
  operatorAccountIds: readonly string[]
  /** Finding ids currently raised, so severity can see drift participation. */
  driftSubjects?: readonly string[]
  /** Resource kinds whose last refresh failed — drives `partial` (XV). */
  failedResourceKinds?: readonly ResourceKind[]
  settings: Settings
  now: Date
}

export interface CorrelationOutput {
  workItems: WorkItem[]
  dangling: DanglingReference[]
}

export function correlate(input: CorrelationInput): CorrelationOutput {
  const failed = new Set(input.failedResourceKinds ?? [])
  const driftSubjects = new Set(input.driftSubjects ?? [])
  const operators = new Set(input.operatorAccountIds)
  const questions = new Set(input.openQuestionSubjects)

  const ticketsByIssueKey = new Map<string, Ticket>()
  for (const t of input.tickets) ticketsByIssueKey.set(t.issueKey.toUpperCase(), t)

  const remoteByProject = new Map<string, string>()
  for (const p of input.projects) {
    if (p.repoOwner !== null && p.repoName !== null) {
      remoteByProject.set(p.id, `github.com/${p.repoOwner}/${p.repoName}`.toLowerCase())
    }
  }

  interface Bucket {
    key: NaturalKey
    projectId: string | null
    ticket: Ticket | null
    /** True when a key matched but its ticket is absent — a partial resolution. */
    expectsMissingTicket: boolean
    pullRequests: PullRequest[]
    workspaces: LocalWorkspace[]
    branches: BranchRef[]
  }

  const buckets = new Map<string, Bucket>()
  const dangling: DanglingReference[] = []

  const bucketFor = (key: NaturalKey, projectId: string | null, ticket: Ticket | null): Bucket => {
    const existing = buckets.get(key)
    if (existing !== undefined) {
      if (existing.ticket === null && ticket !== null) existing.ticket = ticket
      if (existing.projectId === null && projectId !== null) existing.projectId = projectId
      return existing
    }
    const created: Bucket = {
      key,
      projectId,
      ticket,
      expectsMissingTicket: false,
      pullRequests: [],
      workspaces: [],
      branches: [],
    }
    buckets.set(key, created)
    return created
  }

  // Every ticket gets a bucket, even one with no code attached. A ticket with
  // no branch and no PR is not nothing -- it is drift rule D3.
  for (const ticket of input.tickets) {
    const project = input.projects.find(
      (p) => p.jiraProjectKey !== null && ticket.issueKey.startsWith(`${p.jiraProjectKey}-`),
    )
    bucketFor(ticket.key, project?.id ?? null, ticket)
  }

  for (const pr of input.pullRequests) {
    const { match } = matchPullRequest(pr, input.projects)

    if (match === null) {
      // Unlinked work (FR-022's companion case): real work, no ticket. Keyed on
      // the branch so the local checkout of the same branch joins it.
      const remote = remoteFromPullRequestKey(pr.key)
      const key = remote === null ? pr.key : makeBranchKey(remote, pr.headBranch)
      bucketFor(key, projectForRemote(input.projects, remoteByProject, remote), null).pullRequests.push(pr)
      continue
    }

    const ticket = ticketsByIssueKey.get(match.issueKey)
    if (ticket === undefined) {
      dangling.push({
        issueKey: match.issueKey,
        source: match.source,
        fromKey: pr.key,
        projectId: match.projectId,
      })

      // The ticket may be absent because Jira failed rather than because the
      // key is wrong. In that case the work still exists and must still render,
      // marked partial (XV) -- hiding it would read as "no work".
      if (failed.has('tickets')) {
        const remote = remoteFromPullRequestKey(pr.key)
        const key = remote === null ? pr.key : makeBranchKey(remote, pr.headBranch)
        const bucket = bucketFor(key, match.projectId, null)
        bucket.expectsMissingTicket = true
        bucket.pullRequests.push(pr)
      }
      continue
    }

    bucketFor(ticket.key, match.projectId, ticket).pullRequests.push(pr)
  }

  for (const ws of input.workspaces) {
    const { match } = matchBranch(ws.branch, input.projects)
    const ownKey = makeBranchKey(ws.canonicalRemote, ws.branch)

    if (match === null) {
      bucketFor(ownKey, projectForRemote(input.projects, remoteByProject, ws.canonicalRemote), null).workspaces.push(ws)
      continue
    }

    const ticket = ticketsByIssueKey.get(match.issueKey)
    if (ticket === undefined) {
      dangling.push({
        issueKey: match.issueKey,
        source: 'branch',
        fromKey: ws.key,
        projectId: match.projectId,
      })
      if (failed.has('tickets')) {
        const bucket = bucketFor(ownKey, match.projectId, null)
        bucket.expectsMissingTicket = true
        bucket.workspaces.push(ws)
      }
      continue
    }

    bucketFor(ticket.key, match.projectId, ticket).workspaces.push(ws)
  }

  // Ahead/behind, joined onto the item that owns the branch.
  //
  // `comparisons` was an input nothing read. The whole compare path -- the
  // aliased batch query R3 exists to make affordable -- fetched, stored, and
  // then dropped its answers on the floor, and the renderer reported "in sync"
  // for a branch eighty-three commits behind.
  const comparisonByBranch = new Map(input.comparisons.map((c) => [c.branchKey, c]))

  const comparisonsFor = (bucket: { workspaces: LocalWorkspace[]; pullRequests: PullRequest[] }): Comparison[] => {
    const keys = new Set<string>()
    for (const ws of bucket.workspaces) keys.add(makeBranchKey(ws.canonicalRemote, ws.branch))
    for (const pr of bucket.pullRequests) {
      const remote = remoteFromPullRequestKey(pr.key)
      if (remote !== null) keys.add(makeBranchKey(remote, pr.headBranch))
    }

    return [...keys].flatMap((key) => {
      const found = comparisonByBranch.get(key as NaturalKey)
      return found === undefined ? [] : [found]
    })
  }

  // Branch refs attach to whichever bucket already holds their branch, rather
  // than creating buckets of their own -- every open branch at the host would
  // otherwise become a work item.
  for (const ref of input.branches) {
    for (const bucket of buckets.values()) {
      const owns =
        bucket.pullRequests.some((pr) => pr.headBranch === ref.name) ||
        bucket.workspaces.some((ws) => ws.branch === ref.name)
      if (owns) bucket.branches.push(ref)
    }
  }

  const sessionsByBucket = groupSessions(input.sessions, buckets.keys())
  const checksByPr = groupChecks(input.checks, input.pullRequests)

  const workItems: WorkItem[] = []

  for (const bucket of buckets.values()) {
    const sessions = sessionsByBucket.get(bucket.key) ?? []
    const checks = bucket.pullRequests.flatMap((pr) => checksByPr.get(pr.key) ?? [])

    const lastRealActivityAt = workItemActivity({
      ticket: bucket.ticket,
      pullRequests: bucket.pullRequests,
      checks,
      sessionActivity: sessions.map((s) => s.lastRealActivityAt),
    })

    const threshold = thresholdFor(bucket, input.settings)
    const multiple = thresholdMultiple(lastRealActivityAt, input.now, threshold)

    const prSeverityInputs = bucket.pullRequests.map((pr) => ({
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      requiredChecksFailing: (checksByPr.get(pr.key) ?? []).some(
        (c) => c.isRequired && c.state === 'failure',
      ),
    }))

    const sessionStatesByKey = new Map(
      sessions.map((s) => [s.key, sessionStateOf(s, input.now, input.settings.heartbeatMissMultiplier, false)]),
    )
    /**
     * "Live" means *running*, not merely un-ended.
     *
     * A silent agent is precisely the case where nobody is home, so counting it
     * as live would report uncommitted changes as "an agent is editing this"
     * — the reassuring reading — when the truth is that a process died holding
     * the user's work.
     */
    const runningSessions = sessions.filter((s) => sessionStatesByKey.get(s.key) === 'running')

    const branchNames = new Set(bucket.branches.map((b) => b.name))
    const workspaceSeverityInputs = bucket.workspaces.map((ws) => ({
      hasUncommittedChanges: ws.hasUncommittedChanges,
      // Orphaned only when the host's branch list was actually fetched. With
      // `branches` failed or never synced, an empty list is absence of
      // evidence, and calling every workspace orphaned would light the board up.
      orphaned:
        !ws.worktreePresent ||
        (ws.upstreamRef !== null && bucket.branches.length > 0 && !branchNames.has(ws.branch)),
      hasLiveSession: runningSessions.some(
        (s) => s.workspaceKey === ws.key || s.workspaceKey === null,
      ),
    }))

    const hasOpenQuestion =
      questions.has(bucket.key) ||
      bucket.pullRequests.some((pr) => questions.has(pr.key)) ||
      bucket.workspaces.some((ws) => questions.has(ws.key)) ||
      sessions.some((s) => questions.has(s.key))

    const sessionStates = sessions.map((s) => ({ state: sessionStateOf(s, input.now, input.settings.heartbeatMissMultiplier, hasOpenQuestion) }))

    const { severity } = severityOf({
      inDrift: driftSubjects.has(bucket.key),
      ticket:
        bucket.ticket === null
          ? null
          : {
              isBlocked: bucket.ticket.isBlocked,
              awaitingOtherParty: isAwaitingOthers(bucket.ticket),
            },
      pullRequests: prSeverityInputs,
      workspaces: workspaceSeverityInputs,
      sessions: sessionStates,
      thresholdMultiple: multiple,
    })

    const authored = bucket.pullRequests.filter(
      (pr) => pr.author !== null && operators.has(pr.author.accountId),
    )

    const { ball } = ballInCourt({
      hasOpenQuestion,
      authoredPullRequests: authored.map((pr) => ({
        reviewDecision: pr.reviewDecision,
        requiredChecksFailing: (checksByPr.get(pr.key) ?? []).some(
          (c) => c.isRequired && c.state === 'failure',
        ),
        isDraft: pr.isDraft,
      })),
      reviewRequestedOfOperator: bucket.pullRequests.some(
        (pr) => pr.state === 'open' && pr.requestedReviewers.some((r) => operators.has(r.accountId)),
      ),
      ticket:
        bucket.ticket === null
          ? null
          : {
              assignedToOperator:
                bucket.ticket.assignee !== null && operators.has(bucket.ticket.assignee.accountId),
              assignedToSomeoneElse:
                bucket.ticket.assignee !== null && !operators.has(bucket.ticket.assignee.accountId),
              actionable: bucket.ticket.statusCategory !== 'done' && !bucket.ticket.isBlocked,
            },
      awaitingOthersReview: bucket.pullRequests.some(
        (pr) =>
          pr.state === 'open' &&
          pr.reviewDecision === 'reviewRequired' &&
          !pr.requestedReviewers.some((r) => operators.has(r.accountId)),
      ),
      hasLiveSession: runningSessions.length > 0,
    })

    workItems.push({
      key: bucket.key,
      projectId: bucket.projectId,
      ticket: bucket.ticket,
      workspaces: sortBy(bucket.workspaces, (w) => w.key),
      pullRequests: sortBy(bucket.pullRequests, (p) => p.key),
      checks: sortBy(checks, (c) => c.key),
      comparisons: sortBy(comparisonsFor(bucket), (c) => c.branchKey),
      sessions: sortBy(sessions, (s) => s.key),
      noteCount: countNotes(input.noteCounts, bucket),
      severity,
      staleness: stalenessBand(lastRealActivityAt, input.now),
      ballInCourt: ball,
      lastRealActivityAt,
      resolution: resolutionOf(bucket, failed),
    })
  }

  return {
    // Sorted by key so ten runs over identical inputs are byte-identical
    // (FR-024, SC-004). Presentation ordering is the caller's business.
    workItems: sortBy(workItems, (w) => w.key),
    dangling: sortBy(dangling, (d) => `${d.issueKey}|${d.fromKey}`),
  }
}

// ---------------------------------------------------------------------------

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)))
}

function remoteFromPullRequestKey(key: NaturalKey): string | null {
  // `gh:owner/repo#number` -> `github.com/owner/repo`. Local to this module and
  // the one place a key is decomposed, because the alternative is threading the
  // remote through every PR.
  const m = /^gh:([^/]+)\/([^#]+)#\d+$/.exec(key)
  if (m === null) return null
  return `github.com/${m[1]}/${m[2]}`
}

function projectForRemote(
  projects: readonly Project[],
  remoteByProject: ReadonlyMap<string, string>,
  remote: string | null,
): string | null {
  if (remote === null) return null
  for (const p of projects) {
    if (remoteByProject.get(p.id) === remote) return p.id
  }
  return null
}

function groupSessions(
  sessions: readonly AgentSession[],
  bucketKeys: Iterable<string>,
): Map<string, AgentSession[]> {
  const keys = new Set(bucketKeys)
  const grouped = new Map<string, AgentSession[]>()

  for (const s of sessions) {
    const target = s.workItemKey !== null && keys.has(s.workItemKey) ? s.workItemKey : null
    if (target === null) continue
    const list = grouped.get(target) ?? []
    list.push(s)
    grouped.set(target, list)
  }

  return grouped
}

/**
 * Attach CI results to pull requests by head commit.
 *
 * A check belongs to a SHA, not to a PR, and matching on anything looser —
 * branch name, say — would attribute a stale run from a force-pushed-away
 * commit to the current head. A PR whose head SHA is unknown gets no checks
 * rather than a guess.
 */
function groupChecks(
  checks: readonly CheckResult[],
  pullRequests: readonly PullRequest[],
): Map<string, CheckResult[]> {
  const bySha = new Map<string, CheckResult[]>()
  for (const c of checks) {
    if (c.sha === '') continue
    const list = bySha.get(c.sha) ?? []
    list.push(c)
    bySha.set(c.sha, list)
  }

  const byPr = new Map<string, CheckResult[]>()
  for (const pr of pullRequests) {
    byPr.set(pr.key, pr.headSha === '' ? [] : (bySha.get(pr.headSha) ?? []))
  }

  return byPr
}

function isAwaitingOthers(ticket: Ticket): boolean {
  return /review|qa|verify|waiting/i.test(ticket.statusName)
}

function thresholdFor(
  bucket: { ticket: Ticket | null; pullRequests: readonly PullRequest[] },
  settings: Settings,
): number {
  if (bucket.ticket !== null) return settings.laneThresholdHours.tickets
  if (bucket.pullRequests.length > 0) return settings.laneThresholdHours.pulls
  return settings.laneThresholdHours.branches
}

function countNotes(
  noteCounts: Readonly<Record<string, number>>,
  bucket: {
    key: string
    pullRequests: readonly PullRequest[]
    workspaces: readonly LocalWorkspace[]
  },
): number {
  const subjects = [
    bucket.key,
    ...bucket.pullRequests.map((p) => p.key),
    ...bucket.workspaces.map((w) => w.key),
  ]
  return [...new Set(subjects)].reduce((sum, k) => sum + (noteCounts[k] ?? 0), 0)
}

function resolutionOf(
  bucket: {
    ticket: Ticket | null
    expectsMissingTicket: boolean
    pullRequests: readonly PullRequest[]
    workspaces: readonly LocalWorkspace[]
  },
  failed: ReadonlySet<ResourceKind>,
): 'full' | 'partial' {
  if (bucket.expectsMissingTicket) return 'partial'
  if (bucket.ticket !== null && failed.has('tickets')) return 'partial'
  if (bucket.pullRequests.length > 0 && (failed.has('pulls') || failed.has('checks'))) return 'partial'
  if (bucket.workspaces.length > 0 && failed.has('local')) return 'partial'
  return 'full'
}
