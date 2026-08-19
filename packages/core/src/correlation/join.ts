import type { NaturalKey } from '../domain/keys.js'
import { sessionStateOf } from '../domain/sessions.js'
import type {
  AgentSession,
  Project,
  ResourceKind,
  Settings,
  Ticket,
  WorkItem,
} from '../domain/types.js'
import { workItemActivity } from './activity.js'
import { ballInCourt } from './ball.js'
import { severityOf } from './severity.js'
import { stalenessBand, thresholdMultiple } from './staleness.js'

/**
 * The join: ticket ↔ agent session, into work items.
 *
 * Pure. No I/O, no clock of its own, no provider types — plain domain data in,
 * plain data out. That is what constitution XVIII requires and what makes the
 * fixture suite possible with no network, no display, and Electron uninstalled.
 *
 * **This file was the join, and it is now barely one.** It correlated ticket ↔
 * workspace ↔ pull request ↔ commits ↔ CI across three providers; two of those
 * providers are gone, so what remains is a ticket with any agent sessions
 * reporting against it. Kept as its own module rather than folded into the board
 * service, because the two rules below still hold and both are still load-bearing
 * — and because 007 adds a second source of rows to correlate.
 *
 * The two rules, and what happened to each:
 *
 *   **One unit of work is one row.** A ticket is one work item, keyed on the
 *   ticket (FR-020). The clause that followed — "work with no ticket keys on its
 *   branch, so a PR and the local checkout of the same branch land together" —
 *   described the case that no longer exists. **Every work item now has a
 *   ticket** (FR-106), which is the substantive change here rather than a
 *   consequence of one: the row is the ticket.
 *
 *   **A key that matches no ticket is a finding, not a work item** (FR-022).
 *   Also gone, and worth saying why rather than deleting quietly: the keys that
 *   could dangle were branch names and pull request titles naming a ticket that
 *   did not exist, which was usually a typo. Nothing names a ticket from outside
 *   Jira any more, so there is no reference left to dangle — and `dangling` was
 *   the input to two drift rules that go with it.
 */

export interface CorrelationInput {
  projects: readonly Project[]
  tickets: readonly Ticket[]
  sessions: readonly AgentSession[]
  /** Note count per subject natural key. */
  noteCounts: Readonly<Record<string, number>>
  /** Subjects carrying an unresolved `question-for-human` note. */
  openQuestionSubjects: readonly string[]
  /** Provider account ids that are the operator. Resolved per account (FR-033). */
  operatorAccountIds: readonly string[]
  /** Resource kinds whose last refresh failed — drives `partial` (XV). */
  failedResourceKinds?: readonly ResourceKind[]
  settings: Settings
  now: Date
}

export interface CorrelationOutput {
  workItems: WorkItem[]
}

export function correlate(input: CorrelationInput): CorrelationOutput {
  const failed = new Set(input.failedResourceKinds ?? [])
  const operators = new Set(input.operatorAccountIds)
  const questions = new Set(input.openQuestionSubjects)

  /**
   * A bucket's ticket is a `Ticket`, not `Ticket | null`.
   *
   * That is the whole shape change. A bucket used to be created by a ticket, a
   * pull request or a workspace, and only the first of those brought a ticket
   * with it; every field downstream then had to handle the null. Buckets are
   * created in one place now, from `input.tickets`, so there is no path that
   * produces one without.
   */
  interface Bucket {
    key: NaturalKey
    projectId: string | null
    ticket: Ticket
  }

  const buckets = new Map<string, Bucket>()

  for (const ticket of input.tickets) {
    const project = input.projects.find(
      (p) => p.jiraProjectKey !== null && ticket.issueKey.startsWith(`${p.jiraProjectKey}-`),
    )
    buckets.set(ticket.key, { key: ticket.key, projectId: project?.id ?? null, ticket })
  }

  const sessionsByBucket = groupSessions(input.sessions, buckets.keys())

  const workItems: WorkItem[] = []

  for (const bucket of buckets.values()) {
    const sessions = sessionsByBucket.get(bucket.key) ?? []

    const lastRealActivityAt = workItemActivity({
      ticket: bucket.ticket,
      sessionActivity: sessions.map((s) => s.lastRealActivityAt),
    })

    const multiple = thresholdMultiple(
      lastRealActivityAt,
      input.now,
      input.settings.laneThresholdHours.tickets,
    )

    const hasOpenQuestion =
      questions.has(bucket.key) || sessions.some((s) => questions.has(s.key))

    const sessionStates = sessions.map((s) => ({
      state: sessionStateOf(s, input.now, input.settings.heartbeatMissMultiplier, hasOpenQuestion),
    }))

    /**
     * "Live" means *running*, not merely un-ended.
     *
     * A silent agent is precisely the case where nobody is home. This used to
     * also decide whether uncommitted changes read as "an agent is editing this"
     * — the reassuring reading — or as a dead process holding the operator's
     * work; that distinction went with the local checkout. It still decides
     * whether the ball is with an agent, where the same argument applies: a
     * crashed agent must not hold the ball, because nothing will ever hand it
     * back.
     */
    const runningSessions = sessions.filter(
      (s) => sessionStateOf(s, input.now, input.settings.heartbeatMissMultiplier, false) === 'running',
    )

    const { severity } = severityOf({
      ticket: {
        isBlocked: bucket.ticket.isBlocked,
        awaitingOtherParty: isAwaitingOthers(bucket.ticket),
      },
      sessions: sessionStates,
      thresholdMultiple: multiple,
    })

    const { ball } = ballInCourt({
      hasOpenQuestion,
      ticket: {
        assignedToOperator:
          bucket.ticket.assignee !== null && operators.has(bucket.ticket.assignee.accountId),
        assignedToSomeoneElse:
          bucket.ticket.assignee !== null && !operators.has(bucket.ticket.assignee.accountId),
        actionable: bucket.ticket.statusCategory !== 'done' && !bucket.ticket.isBlocked,
      },
      hasLiveSession: runningSessions.length > 0,
    })

    workItems.push({
      key: bucket.key,
      projectId: bucket.projectId,
      ticket: bucket.ticket,
      sessions: sortBy(sessions, (s) => s.key),
      // The subject list was the bucket key plus every pull request and every
      // workspace on it. One subject now, and the row's own — which is what the
      // note badge always claimed to be counting.
      noteCount: input.noteCounts[bucket.key] ?? 0,
      severity,
      staleness: stalenessBand(lastRealActivityAt, input.now),
      ballInCourt: ball,
      lastRealActivityAt,
      // `partial` had four causes and has one: a ticket rendered from the mirror
      // while the last refresh of tickets failed. The row is real, and what it
      // says about itself may be behind (XV).
      resolution: failed.has('tickets') ? 'partial' : 'full',
    })
  }

  return {
    // Sorted by key so ten runs over identical inputs are byte-identical
    // (FR-024, SC-004). Presentation ordering is the caller's business.
    workItems: sortBy(workItems, (w) => w.key),
  }
}

// ---------------------------------------------------------------------------

function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)))
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

function isAwaitingOthers(ticket: Ticket): boolean {
  return /review|qa|verify|waiting/i.test(ticket.statusName)
}
