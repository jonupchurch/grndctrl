import { useState, type ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { LaneStatus } from '../components/LaneStatus.js'
import { Row, RowHeadings } from '../components/Row.js'
import { paletteIndexOf } from '../components/ProjectChip.js'
import { launch } from '../launch.js'
import type { FreshnessView } from '../query.js'
import type { Project, WorkItem } from '../types.js'
import {
  applySort,
  nextSort,
  priorityOrder,
  sortableColumns,
  type SortAccessors,
  type SortColumn,
  type SortState,
} from './sort.js'

/**
 * The work lane — a projection of the correlated work items (T140).
 *
 * **There were three of these** (tickets, pull requests, open branches) and now
 * there is one. The other two read a code host and a local git checkout, and
 * 006 removed both providers: a company GitHub that refuses the API is not a
 * degraded lane, it is a lane that can never have anything in it, and a lane
 * that is permanently empty teaches the operator to stop looking at the board.
 *
 * `Lane` stays a shell taking its title, threshold, columns and empty state as
 * props rather than collapsing into `Tickets`, because it is about to have a
 * second caller again: [007](../../../../specs/007-agent-console/spec.md) adds
 * the lane of work that was handed off. Inlining it now and un-inlining it in a
 * fortnight is churn, not simplification.
 *
 * The lane keeps **its own count, its own threshold, and its own empty state**,
 * and it keeps **its own column headings** — the third column is a ticket's
 * summary here and will be something else in the next lane, and one heading
 * across both would have to be vague enough to be true of either.
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
   * Whether the rows carry sprint, priority and story points.
   *
   * One flag drives both the headings and `data-metrics` on the section, which
   * is what widens the grid in CSS. The rows are handed their own `metrics`
   * separately, so the two could in principle disagree — this is the reason
   * the ticket lane is the only place that sets either.
   */
  metrics?: boolean
  /** The lane's sort state and the columns it can sort by. */
  sort: {
    state: SortState | null
    columns: readonly SortColumn[]
    onSort: (column: SortColumn) => void
  }
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
  sort,
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
          <RowHeadings {...columns} metrics={metrics} sort={sort} />
          {children}
        </>
      )}
    </section>
  )
}

/**
 * A lane's sort state, and the props its headings need to change it.
 *
 * Per lane rather than per board. It mattered more when there were three lanes
 * — sorting tickets by story points says nothing about how the operator wants
 * their branches ordered — and it still matters, because 007 adds a second lane
 * whose interesting order is "most recently taken off my plate" and whose
 * columns are not these.
 *
 * **Not persisted, deliberately, for now.** The project filter is saved because
 * it is a standing choice about what the board is *for*; a sort is a question
 * asked of the board as it stands, and one restored from last week would present
 * itself as the natural order of things. If that turns out to be wrong in use it
 * is a settings field and an invalidation, not a redesign.
 */
function useLaneSort<T>(accessors: SortAccessors<T>): {
  rows: (items: readonly T[]) => readonly T[]
  props: { state: SortState | null; columns: readonly SortColumn[]; onSort: (c: SortColumn) => void }
} {
  const [state, setState] = useState<SortState | null>(null)

  return {
    rows: (items) => applySort(items, state, accessors),
    props: {
      state,
      columns: sortableColumns(accessors),
      onSort: (column) => setState((current) => nextSort(current, column)),
    },
  }
}

/**
 * What each lane needs to draw a note badge (T150).
 *
 * Passed in rather than fetched per lane. One `notes.counts` call covers the
 * whole board — the operation takes up to a thousand keys precisely so a lane of
 * badges is one query — and two lanes fetching their own would put two snapshots
 * of the same table on one screen.
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
  // Still filtered, and still necessary at this point in 006: core has not
  // narrowed yet, so it can still produce a work item built from a branch with
  // no ticket on it. FR-106 makes `ticket` non-nullable at M4 and this filter
  // becomes a no-op; it is removed then, with the type that permitted it.
  const withTickets = items.filter((i) => i.ticket !== null)

  // No `age` accessor, because this lane has no age column to click. The lane's
  // sortable set is read off exactly this object, so the two cannot disagree.
  const sort = useLaneSort<WorkItem>({
    identifier: (i) => i.ticket?.issueKey ?? i.key,
    title: (i) => i.ticket?.summary ?? '',
    status: (i) => i.ticket?.statusName ?? null,
    sprint: (i) => i.ticket?.sprint ?? null,
    // The one column whose sort key is not what the cell shows — `Highest` has
    // to come before `High`, which no alphabetical order produces. See
    // `priorityOrder`: it orders and never relabels.
    priority: (i) => priorityOrder(i.ticket?.priority ?? null),
    points: (i) => i.ticket?.storyPoints ?? null,
  })

  return (
    <Lane
      title="Tickets"
      threshold="stale past 3d"
      count={withTickets.length}
      freshness={freshness}
      resource="Tickets"
      columns={{ identifier: 'Ticket', title: 'Summary', status: 'Status' }}
      metrics
      sort={sort.props}
      {...(now === undefined ? {} : { now })}
      empty={
        <EmptyState title="No tickets">
          Tickets assigned to you in the bound Jira project appear here, with any agent that is
          working on one.
        </EmptyState>
      }
    >
      {sort.rows(withTickets).map((item) => (
        <Row
          key={item.key}
          identifier={item.ticket?.issueKey ?? item.key}
          title={item.ticket?.summary ?? ''}
          severity={item.severity}
          staleness={item.staleness}
          lastRealActivityAt={item.lastRealActivityAt}
          ballInCourt={item.ballInCourt}
          correlations={{ agent: item.sessions.length > 0 }}
          {...(item.ticket === null ? {} : { status: item.ticket.statusName })}
          // Always passed on this lane, because the lane is what declares the
          // columns: a row that omitted them would leave three tracks empty and
          // slide its own correlation badges under the "Priority" heading.
          // `withTickets` has already excluded the null ticket; the fallback is
          // here so a change to that filter cannot silently misalign the grid.
          metrics={{
            sprint: item.ticket?.sprint ?? null,
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
