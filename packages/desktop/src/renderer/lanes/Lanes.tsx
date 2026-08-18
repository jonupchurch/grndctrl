import type { ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { LaneStatus } from '../components/LaneStatus.js'
import { Row, RowHeadings } from '../components/Row.js'
import { paletteIndexOf } from '../components/ProjectChip.js'
import type { Severity } from '../components/StatusMark.js'
import { launch } from '../launch.js'
import type { FreshnessView } from '../query.js'
import type { Project, WorkItem } from '../types.js'

/**
 * The three lanes (T140), each a projection of the same correlated work items.
 *
 * They are projections rather than three separate fetches on purpose. A pull
 * request is not an independent thing here — it is part of a work item that also
 * has a ticket, a branch, and possibly an agent on it — and fetching the lanes
 * separately would mean three snapshots that can disagree, so a PR could appear
 * in its lane while the ticket it belongs to had already gone from the other.
 *
 * Each lane keeps **its own count, its own threshold, and its own empty state**.
 * The thresholds differ because the lanes measure different things: a ticket
 * untouched for three days is normal in most teams, a pull request untouched for
 * twenty-four hours is someone waiting.
 *
 * They also keep **their own column headings**, for the same reason: the third
 * column is a ticket's summary, a pull request's title, and a branch's ticket —
 * one heading across all three would have to be vague enough to be true of all
 * of them, which is a heading that tells the operator nothing.
 */

interface LaneShellProps {
  title: string
  threshold: string
  count: number
  freshness: FreshnessView | null
  resource: string
  /** What this lane calls its id, title and status columns. */
  columns: { identifier: string; title: string; status: string }
  /**
   * Whether the rows carry priority and story points.
   *
   * One flag drives both the heading and `data-metrics` on the section, which
   * is what widens the grid in CSS. The rows are handed their own `metrics`
   * separately, so the two could in principle disagree — this is the reason
   * the ticket lane is the only place that sets either.
   */
  metrics?: boolean
  children: ReactElement | ReactElement[] | null
  empty: ReactElement
  now?: Date
}

function Lane({
  title,
  threshold,
  count,
  freshness,
  resource,
  columns,
  metrics = false,
  children,
  empty,
  now,
}: LaneShellProps): ReactElement {
  return (
    <section className="lane" aria-label={title} data-metrics={metrics}>
      <header className="lane__head">
        <span>{title}</span>
        <span className="lane__count">{count}</span>
        <span className="lane__threshold">{threshold}</span>
        <LaneStatus freshness={freshness} resource={resource} {...(now === undefined ? {} : { now })} />
      </header>
      {/* Only over rows. Headings above an empty state would label columns that
          are not there, which reads as a lane that failed to load. */}
      {count === 0 ? (
        empty
      ) : (
        <>
          <RowHeadings {...columns} metrics={metrics} />
          {children}
        </>
      )}
    </section>
  )
}

/**
 * What each lane needs to draw a note badge (T150).
 *
 * Passed in rather than fetched per lane. One `notes.counts` call covers the
 * whole board — the operation takes up to a thousand keys precisely so a lane of
 * badges is one query — and three lanes fetching their own would put three
 * snapshots of the same table on one screen.
 */
export interface NotesAccess {
  /** Count per subject key. A key that is absent has no notes. */
  counts: Readonly<Record<string, number>>
  /** Subjects with at least one unanswered `question-for-human`. */
  asking: ReadonlySet<string>
  open(subjectKey: string, label: string): void
}

interface LaneProps {
  items: readonly WorkItem[]
  projects: readonly Project[]
  freshness: FreshnessView | null
  /** Absent while the counts are still loading; badges simply do not appear. */
  notes?: NotesAccess | undefined
  now?: Date
}

/**
 * The note-badge props for one row, or nothing at all.
 *
 * Spread rather than passed as individual optional props so that "notes are not
 * available yet" is one absence rather than three, and `exactOptionalPropertyTypes`
 * stays satisfied without a cast.
 */
function noteSlot(
  notes: NotesAccess | undefined,
  subjectKey: string,
  label: string,
): { noteCount: number; hasOpenQuestion: boolean; onOpenNotes: () => void } | Record<string, never> {
  if (notes === undefined) return {}

  return {
    noteCount: notes.counts[subjectKey] ?? 0,
    hasOpenQuestion: notes.asking.has(subjectKey),
    onOpenNotes: () => notes.open(subjectKey, label),
  }
}

const slot = (
  projectId: string | null,
  projects: readonly Project[],
): { project?: { id: string; code: string; paletteIndex: number; name: string } } => {
  if (projectId === null) return {}
  const project = projects.find((p) => p.id === projectId)
  if (project === undefined) return {}

  return {
    project: {
      id: project.id,
      code: project.code,
      paletteIndex: paletteIndexOf(project, projects.map((p) => p.id)),
      name: project.name,
    },
  }
}

export function Tickets({ items, projects, freshness, notes, now }: LaneProps): ReactElement {
  const withTickets = items.filter((i) => i.ticket !== null)

  return (
    <Lane
      title="Tickets"
      threshold="stale past 3d"
      count={withTickets.length}
      freshness={freshness}
      resource="Tickets"
      columns={{ identifier: 'Ticket', title: 'Summary', status: 'Status' }}
      metrics
      {...(now === undefined ? {} : { now })}
      empty={
        <EmptyState title="No tickets">
          Tickets assigned to you in the bound Jira project appear here, with the branch and pull
          request each one is connected to.
        </EmptyState>
      }
    >
      {withTickets.map((item) => (
        <Row
          key={item.key}
          identifier={item.ticket?.issueKey ?? item.key}
          title={item.ticket?.summary ?? ''}
          severity={item.severity}
          staleness={item.staleness}
          lastRealActivityAt={item.lastRealActivityAt}
          ballInCourt={item.ballInCourt}
          correlations={{
            branch: item.workspaces.length > 0,
            'pull-request': item.pullRequests.length > 0,
            check: item.checks.length > 0,
            agent: item.sessions.length > 0,
          }}
          {...(item.ticket === null ? {} : { status: item.ticket.statusName })}
          // Always passed on this lane, because the lane is what declares the
          // columns: a row that omitted them would leave two tracks empty and
          // slide its own correlation badges under the "Priority" heading.
          // `withTickets` has already excluded the null ticket; the fallback is
          // here so a change to that filter cannot silently misalign the grid.
          metrics={{
            priority: item.ticket?.priority ?? null,
            points: item.ticket?.storyPoints ?? null,
          }}
          {...slot(item.projectId, projects)}
          {...noteSlot(notes, item.ticket?.key ?? item.key, item.ticket?.issueKey ?? item.key)}
          {...(now === undefined ? {} : { now })}
          onOpen={() => void launch(item.key, 'ticket')}
        />
      ))}
    </Lane>
  )
}

export function PullRequests({
  items,
  projects,
  freshness,
  notes,
  now,
}: LaneProps): ReactElement {
  // Flattened, because one work item can carry several pull requests — a ticket
  // with three PRs is one work item (decision 11) but three rows here.
  const rows = items.flatMap((item) =>
    item.pullRequests.map((pr) => ({ item, pr })),
  )

  return (
    <Lane
      title="Pull requests"
      threshold="stale past 24h"
      count={rows.length}
      freshness={freshness}
      resource="Pull requests"
      columns={{ identifier: 'PR', title: 'Title', status: 'Review' }}
      {...(now === undefined ? {} : { now })}
      empty={
        <EmptyState title="No open pull requests">
          Pull requests you opened, or that are waiting on your review, appear here with their CI
          state and the ticket they belong to.
        </EmptyState>
      }
    >
      {rows.map(({ item, pr }) => (
        <Row
          key={pr.key}
          identifier={`#${pr.number}`}
          title={pr.title}
          severity={severityOfPull(pr, item.severity)}
          staleness={item.staleness}
          lastRealActivityAt={pr.lastRealActivityAt ?? item.lastRealActivityAt}
          ballInCourt={item.ballInCourt}
          correlations={{
            branch: item.workspaces.length > 0,
            'pull-request': true,
            check: item.checks.length > 0,
            agent: item.sessions.length > 0,
          }}
          status={describePull(pr)}
          {...slot(item.projectId, projects)}
          {...noteSlot(notes, pr.key, `#${pr.number}`)}
          {...(now === undefined ? {} : { now })}
          onOpen={() => void launch(pr.key, 'pull-request')}
        />
      ))}
    </Lane>
  )
}

export function Branches({ items, projects, freshness, notes, now }: LaneProps): ReactElement {
  const rows = items.flatMap((item) => item.workspaces.map((ws) => ({ item, ws })))

  return (
    <Lane
      title="Open branches"
      threshold="stale past 3d"
      count={rows.length}
      freshness={freshness}
      resource="Branches"
      columns={{ identifier: 'Branch', title: 'Ticket', status: 'Local state' }}
      {...(now === undefined ? {} : { now })}
      empty={
        <EmptyState title="No open branches">
          Branches in your local checkouts appear here — with whether they are ahead of or behind
          the base, and whether anything is uncommitted.
        </EmptyState>
      }
    >
      {rows.map(({ item, ws }) => (
        <Row
          key={ws.key}
          identifier={ws.branch}
          title={item.ticket?.summary ?? '(no ticket)'}
          severity={item.severity}
          staleness={item.staleness}
          lastRealActivityAt={item.lastRealActivityAt}
          ballInCourt={item.ballInCourt}
          correlations={{
            branch: true,
            'pull-request': item.pullRequests.length > 0,
            check: item.checks.length > 0,
            agent: item.sessions.length > 0,
          }}
          status={describeWorkspace(ws, comparisonFor(item, ws))}
          {...slot(item.projectId, projects)}
          {...noteSlot(notes, ws.key, ws.branch)}
          {...(now === undefined ? {} : { now })}
          // A branch the host has never seen has no branch page, and
          // `links.resolve` falls back to the repository (FR-076).
          onOpen={() => void launch(ws.key, 'branch')}
        />
      ))}
    </Lane>
  )
}

/**
 * These compare against core's normalised `ReviewDecision`, not GitHub's raw
 * GraphQL enum. They used to read `CHANGES_REQUESTED` and `APPROVED`, which the
 * provider normalises to `changesRequested` and `approved` before anything
 * leaves it — so neither branch could ever be taken. Every pull request was
 * rendered "In review" at its fallback severity, including ones with changes
 * requested, which is precisely the state this lane exists to surface.
 */
export function severityOfPull(pr: WorkItem['pullRequests'][number], fallback: Severity): Severity {
  if (pr.reviewDecision === 'changesRequested') return 'serious'
  if (pr.unresolvedThreadCount > 0) return 'warning'
  return fallback
}

export function describePull(pr: WorkItem['pullRequests'][number]): string {
  if (pr.isDraft) return 'Draft'
  if (pr.reviewDecision === 'changesRequested') return 'Changes requested'
  if (pr.reviewDecision === 'approved') return 'Approved'
  if (pr.unresolvedThreadCount > 0) return `${pr.unresolvedThreadCount} unresolved`
  return 'In review'
}

/**
 * What local git alone knows.
 *
 * Ahead/behind comes from GitHub, so it is `null` for a branch that has never
 * been pushed — and `null` is rendered as "unpushed", never as zero. "No commits
 * ahead" and "we have no idea" are different answers and only one of them is
 * true here (FR-018).
 */
/** The code host's view of this branch, or nothing if it has never seen it. */
function comparisonFor(
  item: WorkItem,
  ws: WorkItem['workspaces'][number],
): WorkItem['comparisons'][number] | undefined {
  const key = `repo:${ws.canonicalRemote}#${ws.branch}`
  return item.comparisons.find((c) => c.branchKey === key)
}

/**
 * What is true about this checkout.
 *
 * Ahead/behind comes from the code host, so it is absent for a branch that was
 * never pushed — and absent is reported as unknown, never as zero. "No commits
 * ahead" and "we have no idea" are different answers and only one of them is
 * true here (FR-018).
 *
 * This used to read ahead/behind off the workspace itself, where the renderer's
 * hand-written type claimed they lived and core had never sent them. Every
 * branch fell through to the numeric arm, compared `undefined ?? 0` against
 * zero, found nothing to report, and printed "in sync".
 */
export function describeWorkspace(
  ws: WorkItem['workspaces'][number],
  comparison: WorkItem['comparisons'][number] | undefined,
): string {
  const parts: string[] = []
  if (ws.hasUncommittedChanges) parts.push('uncommitted')

  // Null is core's way of saying there is no upstream at all, which is a
  // different fact from "nothing to push" and outranks it.
  if (ws.unpushedCommitCount === null) parts.push('no upstream')
  else if (ws.unpushedCommitCount > 0) parts.push(`${ws.unpushedCommitCount} unpushed`)

  if (comparison === undefined || (comparison.aheadBy === null && comparison.behindBy === null)) {
    parts.push('unknown vs base')
  } else {
    if ((comparison.aheadBy ?? 0) > 0) parts.push(`${comparison.aheadBy} ahead`)
    if ((comparison.behindBy ?? 0) > 0) parts.push(`${comparison.behindBy} behind`)
  }

  return parts.length === 0 ? 'in sync' : parts.join(' · ')
}
