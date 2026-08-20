import type { ReactElement, ReactNode } from 'react'
import { ProjectChip } from './ProjectChip.js'
import { StaleBar } from './StaleBar.js'
import type { StalenessBand } from './StaleBar.js'
import { CorrelationBadge, StatusMark, type CorrelationKind, type Severity } from './StatusMark.js'
import type { SortColumn, SortState } from '../lanes/sort.js'

/**
 * One 34px primitive, serving every lane (T134).
 *
 * The slots are **fixed-width and always present**, and that is the design
 * decision the whole lane rests on. Columns align down the lane, so the eye
 * reads a column rather than re-parsing each row — and an empty slot reads as an
 * absence rather than shifting everything after it. "Assigned to me, nothing
 * started" is a row with three hairline placeholders, which is a sentence; the
 * same row with the badges omitted is just a shorter row.
 *
 * **The row was a `<button>` and is now a `<div>` holding one** (T150). Opening
 * the provider page is still the row's primary action and still a real button
 * with a focus ring, keyboard activation, and an announced role — but the note
 * badge is a *second* action on the same row, and a `<button>` inside a
 * `<button>` is invalid HTML: the click bubbles, so opening the notes would
 * also open GitHub, and the inner control is not reliably reachable. So the
 * primary action is an absolutely-positioned button covering the row, the
 * content sits in the grid beneath it as static text, and the badge sits above
 * it. Nothing about the row's appearance or keyboard behaviour changes.
 *
 * **Three slots are opt-in, and that is a departure worth naming.** Sprint,
 * priority and story points exist on a ticket and nowhere else. Every other slot
 * is unconditional because an empty one is a *fact* about that row ("no agent on
 * it"); these three would be a fact about the lane, and a column that can never
 * hold anything is noise rather than absence. So a lane either has them for all
 * its rows or has them for none, `.lane[data-metrics]` widens the grid to match,
 * and one prop decides all three — which is what stops the markup and the column
 * count disagreeing.
 *
 * **There is no age column any more**, and it did not go quietly. It was opt-out
 * — dropped on the ticket lane to pay for the sprint column, kept on the pull
 * request and branch lanes where "stale past 24h" was the whole point. 006
 * removed both of those lanes, so the flag had exactly one setting left and the
 * column had no caller: a prop whose only remaining value is `false` is a
 * capability nothing can reach, and this file already carries two comments about
 * fields that were declared on both sides and wired on neither. The fact is not
 * lost — the staleness bar in the leftmost track is derived from the same
 * timestamp, states it in colour, and carries the exact age in its `title`.
 *
 * Height comes from `--row-h`, which density switches between 34px and 28px
 * (T131). Nothing here knows which.
 */

export type BallInCourt = 'you' | 'them' | 'agent'

/*
 * The row's own glyph map went with the court column on 2026-08-20.
 * `components/BallInCourt.tsx` keeps its own, which is the one the panel draws.
 * The **type** stays exported from here: the panel, the filter and the work item
 * all name it.
 */

/**
 * What can be correlated with a ticket, which is now one thing.
 *
 * It was four — branch, pull request, CI check, agent — and three of them came
 * from the code host and the local checkout that 006 removes. Kept as a list of
 * one rather than collapsed into a bare conditional, because the slot's value is
 * that it is a *fixed grid of presence marks*: an absent badge is a hairline
 * placeholder holding its column, not a gap. One entry still renders that way,
 * and a second is one line away if there is ever another thing to correlate.
 */
const CORRELATION_ORDER: CorrelationKind[] = ['agent']

export interface RowProps {
  /** Identifier shown in the id slot — `MERC-1184`, `#482`, a branch name. */
  identifier: string
  title: string
  severity: Severity
  staleness: StalenessBand
  lastRealActivityAt: string | null
  /** Which correlations exist. Absent kinds render as placeholders, not gaps. */
  correlations: Partial<Record<CorrelationKind, boolean>>
  project?: { id: string; code: string; paletteIndex: number; name?: string } | undefined
  /** Provider status text — "In Review", "checks failing". */
  status?: string | undefined
  /**
   * The ticket-only columns, or nothing at all.
   *
   * One optional object rather than three optional fields, because the three
   * travel together: the lane's grid has all of them or none, and a row that
   * rendered one of them would put every slot after it in the wrong column.
   * `null` inside it is an ordinary value — unknown — and renders as a
   * placeholder. `0` points is not unknown and renders as `0`.
   */
  metrics?: { sprint: string | null; priority: string | null; points: number | null } | undefined
  /**
   * Notes on **this row's own subject** (T150).
   *
   * Deliberately not `WorkItem.noteCount`, which is the total across the whole
   * item — ticket, every pull request, every branch, every session. On a ticket
   * row those coincide; on one of three pull request rows the aggregate would
   * put 6 on all three and then the modal would open showing one. A count that
   * disagrees with what it opens is worse than no count.
   */
  noteCount?: number | undefined
  /** True when one of them is an unanswered question. Earns the badge colour. */
  hasOpenQuestion?: boolean | undefined
  /** Absent means notes are unavailable and the badge is not drawn. */
  onOpenNotes?: (() => void) | undefined
  /** Anything else for the trailing slot. Rendered after the note badge. */
  trailing?: ReactNode
  onOpen(): void
  now?: Date
}

/**
 * An en dash where a value would be, hidden from assistive technology.
 *
 * The same discipline as the correlation placeholders and the empty project
 * chip: the column has to hold its width or every row below it stops lining up.
 * It is `aria-hidden` because the slot's `title` already says "not set" — a
 * screen reader announcing a dash would be reading the ruling, not the data.
 */
function Absent(): ReactElement {
  return (
    <span className="row__absent" aria-hidden="true">
      –
    </span>
  )
}

/**
 * The column headings, on the row's own grid (T134).
 *
 * A separate component rather than a `<th>` row, because the lane is not a
 * `<table>` — it is a list of rows each carrying a button, and turning it into
 * a table to gain a header would change how every row is announced.
 *
 * **The headings are the lane's sort control**, and that is why the container is
 * no longer `aria-hidden`. It was, deliberately: a screen reader does not read
 * this layout as a grid, so decorative headings arrived as eight bare nouns
 * before the list and then never again — no more use than reading the ruled
 * lines. But `aria-hidden` over a focusable control is worse than useless, it is
 * a keyboard trap in reverse: the button still takes tab focus and announces
 * nothing when it gets there. So the sortable headings are real buttons that say
 * what they do and what the current order is, and the cells that are still only
 * labels — Links, Court, and the two blank tracks — carry `aria-hidden`
 * individually, exactly as before.
 *
 * It carries **`lane__headings` and not `row`**, which is not cosmetic. It was
 * `row row--head` first, and that made it a row to everything that looks for
 * one: `document.querySelectorAll('.row')` is how the performance test counts
 * the board and how the greyscale test finds severity marks, and a two-hundred
 * item board suddenly had two hundred and two rows in it. It borrows the row's
 * *grid* — the one thing it genuinely shares — and none of its identity.
 *
 * The labels are passed in because the same three columns mean different things
 * per lane — a ticket has a summary, a pull request has a title, and "Status" on
 * a branch is what local git can see.
 */
export interface RowHeadingsProps {
  identifier: string
  title: string
  status: string
  /** Draws the three ticket-only headings. Must match the rows' `metrics`. */
  metrics?: boolean
  /**
   * What this lane can be sorted by, and how it currently is.
   *
   * Absent means the headings are labels only — which is what they were before
   * T157, and is still the honest rendering for a lane that has no comparator
   * for its columns. `columns` comes from the lane's own accessors, so a heading
   * cannot be made clickable without something behind it to sort by.
   */
  sort?:
    | { state: SortState | null; columns: readonly SortColumn[]; onSort: (column: SortColumn) => void }
    | undefined
}

/** Which direction the caret points, or nothing when this column is not sorted. */
const CARET: Record<'asc' | 'desc', string> = { asc: '▲', desc: '▼' }

export function RowHeadings({
  identifier,
  title,
  status,
  metrics = false,
  sort,
}: RowHeadingsProps): ReactElement {
  /**
   * One heading cell: a sort button when the lane can sort by it, plain text
   * when it cannot.
   *
   * The class stays on the outermost element either way. It is what the grid
   * template and two end-to-end alignment assertions address the cell by, so a
   * heading that moved its class onto an inner span would keep looking right and
   * stop being checked.
   */
  const heading = (column: SortColumn, label: string): ReactElement => {
    const className = `row__${column === 'identifier' ? 'id' : column}`

    if (sort === undefined || !sort.columns.includes(column)) {
      return (
        <span className={className} aria-hidden="true">
          {label}
        </span>
      )
    }

    const active = sort.state?.column === column ? sort.state.direction : null

    return (
      <button
        type="button"
        className={`${className} lane__sort`}
        data-sorted={active ?? 'no'}
        onClick={() => sort.onSort(column)}
        // Spelled out rather than left to `aria-sort`, which needs a real
        // `grid`/`table` role to mean anything — and giving this list one would
        // change how all two hundred rows beneath it are announced.
        aria-label={
          active === null
            ? `Sort by ${label}`
            : `Sort by ${label}, currently ${active === 'asc' ? 'ascending' : 'descending'}`
        }
      >
        <span className="lane__sort-label">{label}</span>
        {/* Only on the sorted column. A caret on every heading is a row of
            arrows that all look equally true, and the one that is has to be
            found by shade. */}
        {active !== null && (
          <span className="lane__sort-caret" aria-hidden="true">
            {CARET[active]}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="lane__headings">
      {/* Two empty tracks: the staleness bar and the project chip are marks
          rather than columns, and naming them would label a colour. */}
      <span aria-hidden="true" />
      <span aria-hidden="true" />

      {heading('identifier', identifier)}
      {heading('title', title)}
      {heading('status', status)}

      {metrics && (
        <>
          {heading('sprint', 'Sprint')}
          {heading('priority', 'Priority')}
          {heading('points', 'Points')}
        </>
      )}

      {/* "Links" when it named four systems; the column holds one presence mark
          now and is named for what that mark is about: *has an agent been on
          this ticket*.

          **The court column sat beside it until 2026-08-20 and is gone**, to
          give the summary back the width the wider side rail took. What it
          showed is not gone with it: ball-in-court still sorts the lane, still
          drives the "Your court" tile and its filter, and still has a panel of
          its own in the rail. This was the third place the same fact appeared,
          and the only one that cost a column on every row. */}
      <span className="row__correlation" aria-hidden="true">
        Agent
      </span>

      {/* The trailing slot holds the note control, and the severity mark closes
          the row. Both are their own labels; neither takes a heading. */}
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  )
}

export function Row({
  identifier,
  title,
  severity,
  staleness,
  lastRealActivityAt,
  correlations,
  project,
  status,
  metrics,
  noteCount,
  hasOpenQuestion,
  onOpenNotes,
  trailing,
  onOpen,
  now,
}: RowProps): ReactElement {
  const notes = noteCount ?? 0

  return (
    <div className="row" data-severity={severity}>
      {/*
        Opening the row, as one real button covering it.

        Absolutely positioned, so it consumes no grid track — the ten slots
        below are exactly as they were when the row was itself a button. It
        carries no text, so the name is spelled out here.

        **This costs drag-selecting the row title**, which `.row__title` used to
        opt into so a ticket title could be pasted into a message: an invisible
        button over the text swallows the drag. The alternative — no pointer
        events on the button and the click handler on the `<div>` — keeps the
        selection but makes the row's primary action a non-interactive element
        with an onClick, and the button then exists only for keyboard. One real
        button beats a div that behaves like one, so the selection goes. The
        title is still selectable wherever it appears outside a row — the
        notes dialog shows the subject label as ordinary text.
      */}
      <button
        type="button"
        className="row__open"
        onClick={onOpen}
        aria-label={`Open ${identifier}${title === '' ? '' : `: ${title}`}`}
      />

      <StaleBar band={staleness} lastRealActivityAt={lastRealActivityAt} {...(now === undefined ? {} : { now })} />

      <span className="row__project">
        {project === undefined ? (
          // The placeholder, not a collapsed slot: a work item with no project
          // binding is a real state, and the column must still line up.
          <span className="project-chip project-chip--empty" aria-hidden="true" />
        ) : (
          <ProjectChip
            projectId={project.id}
            code={project.code}
            paletteIndex={project.paletteIndex}
            {...(project.name === undefined ? {} : { name: project.name })}
          />
        )}
      </span>

      <span className="row__id">{identifier}</span>
      <span className="row__title">{title}</span>
      <span className="row__status">{status ?? ''}</span>

      {metrics !== undefined && (
        <>
          {/*
            The sprint the ticket is *in*, chosen at ingest out of the several a
            carried-over ticket carries — see `Ticket.sprint` in core. Null is a
            ticket in no sprint, or a site with no sprint field, and both are the
            placeholder: naming it "Backlog" would be a word this code invented.
          */}
          <span className="row__sprint" title={`Sprint: ${metrics.sprint ?? 'none'}`}>
            {metrics.sprint ?? <Absent />}
          </span>

          {/*
            The tracker's own word, unmapped — see `Ticket.priority` in core.
            `title` carries the column's name because the heading row is
            decorative: it tells a screen reader what "Highest" is a Highest of.
          */}
          <span className="row__priority" title={`Priority: ${metrics.priority ?? 'not set'}`}>
            {metrics.priority ?? <Absent />}
          </span>

          {/*
            Never `metrics.points || …` — that renders a genuine zero-point
            ticket as unestimated. Only null is the placeholder.
          */}
          <span
            className="row__points"
            title={metrics.points === null ? 'Not estimated' : `${metrics.points} story points`}
          >
            {metrics.points === null ? <Absent /> : metrics.points}
          </span>
        </>
      )}

      <span className="row__correlation">
        {CORRELATION_ORDER.map((kind) => (
          <CorrelationBadge key={kind} kind={kind} present={correlations[kind] === true} />
        ))}
      </span>

      {/*
        Decision 18, settled: the note badge takes the **trailing slot**, which
        displaces nothing — the slot was reserved for it and has been empty
        since T134. The alternatives all cost something the row cannot spare:
        the status slot carries the provider's own words, the correlation slot
        is the four-badge grid whose whole value is that it is always four, and
        the age slot is the number the staleness bar is measured against.

        **The control is always drawn; only its emphasis changes.** Drawing it
        only when a note exists was the first version, and it made the first
        note on any subject unwritable from the board — the affordance appeared
        exactly once it was no longer needed. But a badge reading `0` is a
        claim, and forty of them down a lane is noise competing with the row
        content. So an empty one is a hairline `+` that lifts on hover or focus:
        present in the DOM and reachable by keyboard at all times, quiet until
        the operator is on that row. Same discipline as the correlation
        placeholders, applied to a control rather than to a mark.
      */}
      <span className="row__trailing">
        {onOpenNotes !== undefined && (
          <button
            type="button"
            className="row__notes"
            data-asking={hasOpenQuestion === true ? 'true' : 'false'}
            data-empty={notes === 0 ? 'true' : 'false'}
            // Stopped, or the click also reaches the row and the operator gets
            // the notes dialog *and* a browser tab on the provider's page.
            onClick={(event) => {
              event.stopPropagation()
              onOpenNotes()
            }}
            aria-label={
              notes === 0
                ? `Add a note to ${identifier}`
                : hasOpenQuestion === true
                  ? `${notes} note${notes === 1 ? '' : 's'} on ${identifier}, one unanswered question`
                  : `${notes} note${notes === 1 ? '' : 's'} on ${identifier}`
            }
          >
            {notes === 0 ? (
              <span aria-hidden="true">+</span>
            ) : (
              <>
                <span aria-hidden="true">{hasOpenQuestion === true ? '?' : '·'}</span>
                <span aria-hidden="true">{notes}</span>
              </>
            )}
          </button>
        )}
        {trailing}
      </span>

      {/* The severity shape travels with the row for greyscale legibility, but
          the row's own colour already carries it visually — so it sits at the
          end, small, rather than competing with the identifier. */}
      <StatusMark severity={severity} />
    </div>
  )
}
