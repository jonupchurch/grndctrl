import { correlate } from '../correlation/join.js'
import type { Project, ResourceKind, Settings, WorkItem } from '../domain/types.js'
import { envelope, freshnessView, type Envelope, type FreshnessView } from '../registry/envelope.js'
import type { MirrorRepository } from '../store/mirror/repository.js'

/**
 * Assembling the board.
 *
 * Reads both stores, correlates, and wraps the result in a freshness envelope.
 * This is the one place the two tiers are joined, and it is done deliberately in
 * code rather than by a SQL join — there is no join to write, because no
 * foreign key crosses the database files (XIII).
 *
 * **This ran correlation twice and now runs it once.** The second pass existed
 * because severity depended on drift participation (FR-029): the first produced
 * the work items, drift ran over them, and the second recomputed severity with
 * the findings known. Without drift there is nothing to feed back, and a second
 * identical pass would be a cost with no output.
 */

export interface BoardInputs {
  mirror: MirrorRepository
  projects: readonly Project[]
  noteCounts: Readonly<Record<string, number>>
  openQuestionSubjects: readonly string[]
  sessions: Parameters<typeof correlate>[0]['sessions']
  settings: Settings
  now: Date
}

export interface Board {
  workItems: WorkItem[]
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

  const { workItems } = correlate({
    projects: inputs.projects,
    tickets: mirror.listTickets(),
    sessions: inputs.sessions,
    noteCounts: inputs.noteCounts,
    openQuestionSubjects: inputs.openQuestionSubjects,
    operatorAccountIds,
    failedResourceKinds,
    settings: inputs.settings,
    now: inputs.now,
  })

  return { workItems }
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
  }

  const kinds: ResourceKind[] = ['tickets']

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
