import { correlate, type CorrelationOutput } from '../correlation/join.js'
import { applyDismissals } from '../drift/dismiss.js'
import { detectDrift } from '../drift/rules.js'
import type {
  DriftFinding,
  FindingDismissal,
  Project,
  ResourceKind,
  Settings,
  WorkItem,
} from '../domain/types.js'
import { envelope, freshnessView, type Envelope, type FreshnessView } from '../registry/envelope.js'
import type { MirrorRepository } from '../store/mirror/repository.js'

/**
 * Assembling the board.
 *
 * Reads both stores, correlates, detects drift, and wraps the result in a
 * freshness envelope. This is the one place the two tiers are joined, and it is
 * done deliberately in code rather than by a SQL join — there is no join to
 * write, because no foreign key crosses the database files (XIII).
 *
 * Drift is computed *before* work items are returned, because severity depends
 * on drift participation (FR-029) and the two would otherwise disagree about
 * the same row.
 */

export interface BoardInputs {
  mirror: MirrorRepository
  projects: readonly Project[]
  noteCounts: Readonly<Record<string, number>>
  openQuestionSubjects: readonly string[]
  sessions: Parameters<typeof correlate>[0]['sessions']
  dismissals: readonly FindingDismissal[]
  settings: Settings
  now: Date
}

export interface Board {
  workItems: WorkItem[]
  findings: DriftFinding[]
  dangling: CorrelationOutput['dangling']
}

export function buildBoard(inputs: BoardInputs): Board {
  const { mirror } = inputs

  const freshness = mirror.listFreshness()
  const failedResourceKinds = freshness
    .filter((f) => f.lastFailureAt !== null && (f.lastSuccessAt === null || f.lastFailureAt > f.lastSuccessAt))
    .map((f) => f.resourceKind)

  const operatorAccountIds = mirror
    .listConnections()
    .map((c) => c.viewerIdentity?.accountId)
    .filter((id): id is string => id !== undefined && id !== null)

  const base = {
    projects: inputs.projects,
    tickets: mirror.listTickets(),
    pullRequests: mirror.listPullRequests(),
    checks: mirror.listChecks(),
    branches: mirror.listBranches(),
    comparisons: mirror.listComparisons(),
    workspaces: mirror.listWorkspaces(),
    sessions: inputs.sessions,
    noteCounts: inputs.noteCounts,
    openQuestionSubjects: inputs.openQuestionSubjects,
    operatorAccountIds,
    failedResourceKinds,
    settings: inputs.settings,
    now: inputs.now,
  }

  // Two passes, on purpose. Drift needs correlated work items, and severity
  // needs to know which items are in drift -- so the first pass produces the
  // items, and the second recomputes severity with drift participation known.
  const first = correlate(base)
  const rawFindings = detectDrift({
    workItems: first.workItems,
    dangling: first.dangling,
    settings: inputs.settings,
    now: inputs.now,
  })
  const findings = applyDismissals(rawFindings, inputs.dismissals)

  const second = correlate({ ...base, driftSubjects: findings.map((f) => f.subjectKey) })

  return { workItems: second.workItems, findings, dangling: second.dangling }
}

/** Freshness views for every resource kind, keyed for the envelope. */
export function freshnessFor(
  mirror: MirrorRepository,
  now: Date,
  settings: Settings,
): Partial<Record<ResourceKind, FreshnessView>> {
  const records = mirror.listFreshness()
  const views: Partial<Record<ResourceKind, FreshnessView>> = {}

  const staleAfter: Record<string, number> = {
    tickets: settings.pollIntervalSec.jira * 3,
    pulls: settings.pollIntervalSec.github * 3,
    checks: settings.pollIntervalSec.github * 3,
    branches: settings.pollIntervalSec.github * 3,
    comparisons: settings.pollIntervalSec.github * 3,
    local: settings.pollIntervalSec.github * 3,
  }

  const kinds: ResourceKind[] = ['tickets', 'pulls', 'checks', 'branches', 'comparisons', 'local']

  for (const kind of kinds) {
    // Worst case across connections. With two Jira sites and one broken, the
    // ticket lane is not fresh -- reporting the healthy one's age would hide a
    // dead connection behind a working one (XV).
    const forKind = records.filter((r) => r.resourceKind === kind)
    const view = forKind
      .map((r) => freshnessView(r, now.getTime(), staleAfter[kind] ?? 300))
      .sort((a, b) => rankState(b.state) - rankState(a.state))[0]

    views[kind] = view ?? freshnessView(undefined, now.getTime(), staleAfter[kind] ?? 300)
  }

  return views
}

function rankState(state: FreshnessView['state']): number {
  return { fresh: 0, stale: 1, never: 2, failed: 3 }[state]
}

export function envelopeBoard<T>(
  data: T,
  mirror: MirrorRepository,
  now: Date,
  settings: Settings,
): Envelope<T> {
  return envelope(data, freshnessFor(mirror, now, settings))
}
