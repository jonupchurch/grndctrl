import type { ReactElement, ReactNode } from 'react'
import { ProjectChip } from './ProjectChip.js'
import { StaleBar, formatAge } from './StaleBar.js'
import type { StalenessBand } from './StaleBar.js'
import { CorrelationBadge, StatusMark, type CorrelationKind, type Severity } from './StatusMark.js'

/**
 * One 34px primitive, serving all three lanes (T134).
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
 * **Two slots are opt-in, and that is a departure worth naming.** Priority and
 * story points exist on a ticket and nowhere else — a branch has no priority and
 * a pull request is not estimated. Every other slot is unconditional because an
 * empty one is a *fact* about that row ("no branch yet"); these two would be a
 * fact about the lane, and two columns that can never hold anything are noise
 * rather than absence. So a lane either has them for all its rows or has them
 * for none, `.lane[data-metrics]` widens the grid to match, and one prop decides
 * both — which is what stops the markup and the column count disagreeing.
 *
 * Height comes from `--row-h`, which density switches between 34px and 28px
 * (T131). Nothing here knows which.
 */

export type BallInCourt = 'you' | 'them' | 'agent'

const COURT: Record<BallInCourt, { glyph: string; label: string }> = {
  // Geometric primitives only, per the design system: no pictograms, no emoji.
  you: { glyph: '●', label: 'You' },
  them: { glyph: '○', label: 'Them' },
  agent: { glyph: '◆', label: 'Agent' },
}

const CORRELATION_ORDER: CorrelationKind[] = ['branch', 'pull-request', 'check', 'agent']

export interface RowProps {
  /** Identifier shown in the id slot — `MERC-1184`, `#482`, a branch name. */
  identifier: string
  title: string
  severity: Severity
  staleness: StalenessBand
  lastRealActivityAt: string | null
  ballInCourt: BallInCourt
  /** Which correlations exist. Absent kinds render as placeholders, not gaps. */
  correlations: Partial<Record<CorrelationKind, boolean>>
  project?: { id: string; code: string; paletteIndex: number; name?: string } | undefined
  /** Provider status text — "In Review", "checks failing". */
  status?: string | undefined
  /**
   * The ticket-only columns, or nothing at all.
   *
   * One optional object rather than two optional fields, because the two travel
   * together: the lane's grid has both columns or neither, and a row that
   * rendered one of them would put every slot after it in the wrong column.
   * `null` inside it is an ordinary value — unknown — and renders as a
   * placeholder. `0` points is not unknown and renders as `0`.
   */
  metrics?: { priority: string | null; points: number | null } | undefined
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
 * It is **`aria-hidden`, deliberately**. A screen reader does not read this
 * layout as a grid, so the headings would arrive as eight bare nouns before the
 * list and then never again — no more use than reading the ruled lines. Every
 * cell that needs naming is named where it sits: the row's button spells out
 * what it opens, and the court, priority and points slots carry a `title`.
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
  /** Draws the two ticket-only headings. Must match the rows' `metrics`. */
  metrics?: boolean
}

export function RowHeadings({
  identifier,
  title,
  status,
  metrics = false,
}: RowHeadingsProps): ReactElement {
  return (
    <div className="lane__headings" aria-hidden="true">
      {/* Two empty tracks: the staleness bar and the project chip are marks
          rather than columns, and naming them would label a colour. */}
      <span />
      <span />

      <span className="row__id">{identifier}</span>
      <span className="row__title">{title}</span>
      <span className="row__status">{status}</span>

      {metrics && (
        <>
          <span className="row__priority">Priority</span>
          <span className="row__points">Points</span>
        </>
      )}

      <span className="row__correlation">Links</span>
      <span className="row__court">Court</span>
      <span className="row__age">Age</span>

      {/* The trailing slot holds the note control, and the severity mark closes
          the row. Both are their own labels; neither takes a heading. */}
      <span />
      <span />
    </div>
  )
}

export function Row({
  identifier,
  title,
  severity,
  staleness,
  lastRealActivityAt,
  ballInCourt,
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
  const court = COURT[ballInCourt]
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
        title is still selectable wherever it appears outside a row: the
        Attention strips, and the confirmation dialog.
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

      <span className="row__court" data-court={ballInCourt} title={`Ball in court: ${court.label}`}>
        <span aria-hidden="true">{court.glyph}</span>
        <span className="row__court-label">{court.label}</span>
      </span>

      <span className="row__age">{formatAge(lastRealActivityAt, now)}</span>

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
