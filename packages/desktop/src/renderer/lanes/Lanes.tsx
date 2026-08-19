import { useState, type ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { LaneStatus } from '../components/LaneStatus.js'
import { Section } from '../components/Section.js'
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
  /** The persisted region id. A stable literal, never derived from the title. */
  id: string
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
  id,
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
    <Section
      id={id}
      title={title}
      className="lane"
      metrics={metrics}
      count={count}
      meta={threshold}
      status={
        <LaneStatus
          freshness={freshness}
          resource={resource}
          {...(now === undefined ? {} : { now })}
        />
      }
    >
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
    </Section>
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
  /** Absent means the row draws no focus control at all. */
  focus?: FocusAccess | undefined
  now?: Date
}

/**
 * Setting the active ticket from the lane (FR-127, US1 scenario 6).
 *
 * The panel is populated by MCP in the normal case, and an empty panel with no
 * way to fill it by hand is a dead region — so the row is the operator's half
 * of the same pointer.
 *
 * `activeKey` is here so the control can render as a *state* rather than only as
 * an action: one row in the lane is the active one, and a control that looked
 * identical on all of them would make the operator read the panel to find out
 * which. It is the natural key, matching what `focus.get` returns, because that
 * is the field the two sides agree on.
 */
export interface FocusAccess {
  activeKey: string | null
  set(ticketKey: string): void
  clear(): void
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

/**
 * The row's half of the active-ticket pointer.
 *
 * It goes in the **trailing slot**, beside the note badge, which is the only
 * track on the row that holds controls rather than facts <E> and the slot is a
 * flex row with a gap, so a second control was already anticipated there. The
 * track widens for this lane alone (`--trailing-w` under `.lane[data-metrics]`),
 * because the ticket lane is the only one with a ticket to make active.
 *
 * **The same control both sets and clears.** Pressing the active row again puts
 * the board down, which is the gesture people try first; a separate clear that
 * lived only in the panel would mean the lane could turn focus on and not off.
 *
 * The click is stopped for the same reason the note badge stops it: the row's
 * primary action spans the whole row, and without this the operator would set
 * the active ticket *and* get a browser tab on Jira.
 */
function focusControl(focus: FocusAccess, ticketKey: string, label: string): ReactElement {
  const active = focus.activeKey === ticketKey

  return (
    <button
      type="button"
      className="row__focus"
      data-active={active ? 'true' : 'false'}
      onClick={(event) => {
        event.stopPropagation()
        if (active) focus.clear()
        else focus.set(ticketKey)
      }}
      aria-pressed={active}
      aria-label={active ? `Stop working ${label}` : `Work ${label}`}
    >
      {/* Geometric primitives only, per the design system. Filled is the one
          being worked; the ring is every other row. */}
      <span aria-hidden="true">{active ? '◉' : '◎'}</span>
    </button>
  )
}

export function Tickets({ items, projects, freshness, notes, focus, now }: LaneProps): ReactElement {
  // No `withTickets` filter, and no `?.` below. Every work item has a ticket
  // (FR-106), so both were guarding against a state the type no longer permits
  // — and a filter whose predicate is always true is a filter a future reader
  // has to prove is dead.
  //
  // No `age` accessor either, because this lane has no age column to click. The
  // lane's sortable set is read off exactly this object, so the two cannot
  // disagree.
  const sort = useLaneSort<WorkItem>({
    identifier: (i) => i.ticket.issueKey,
    title: (i) => i.ticket.summary,
    status: (i) => i.ticket.statusName,
    sprint: (i) => i.ticket.sprint,
    // The one column whose sort key is not what the cell shows — `Highest` has
    // to come before `High`, which no alphabetical order produces. See
    // `priorityOrder`: it orders and never relabels.
    priority: (i) => priorityOrder(i.ticket.priority),
    points: (i) => i.ticket.storyPoints,
  })

  return (
    <Lane
      id="tickets"
      title="Tickets"
      threshold="stale past 3d"
      count={items.length}
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
      {sort.rows(items).map((item) => (
        <Row
          key={item.key}
          identifier={item.ticket.issueKey}
          title={item.ticket.summary}
          severity={item.severity}
          staleness={item.staleness}
          lastRealActivityAt={item.lastRealActivityAt}
          ballInCourt={item.ballInCourt}
          correlations={{ agent: item.sessions.length > 0 }}
          status={item.ticket.statusName}
          // Always passed on this lane, because the lane is what declares the
          // columns: a row that omitted them would leave three tracks empty and
          // slide its own correlation badges under the "Priority" heading.
          metrics={{
            sprint: item.ticket.sprint,
            priority: item.ticket.priority,
            points: item.ticket.storyPoints,
          }}
          {...slot(item.projectId, projects)}
          {...noteSlot(notes, item.ticket.key, item.ticket.issueKey)}
          {...(focus === undefined
            ? {}
            : { trailing: focusControl(focus, item.ticket.key, item.ticket.issueKey) })}
          {...(now === undefined ? {} : { now })}
          onOpen={() => void launch(item.key, 'ticket')}
        />
      ))}
    </Lane>
  )
}
