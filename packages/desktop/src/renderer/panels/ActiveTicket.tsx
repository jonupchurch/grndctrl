import type { ReactElement } from 'react'
import { Document } from '../components/Document.js'
import { EmptyState } from '../components/EmptyState.js'
import { Section } from '../components/Section.js'
import { formatAge } from '../components/StaleBar.js'
import { launch } from '../launch.js'
import type { WorkItem } from '../types.js'

/**
 * The one ticket being worked (FR-127, FR-128, FR-131).
 *
 * **Everything here comes from the snapshot the board already holds.** There is
 * no per-key read and there must not be one: FR-131 says an active ticket the
 * mirror does not hold is shown as what is known plus what is not, and **does
 * not trigger a fetch**. The pointer is settable by an agent over MCP, so a
 * panel that fetched on it would make an agent's input into a network call the
 * operator did not ask for — against a ticket that may not even be theirs.
 *
 * **Three states, not two, and the third is the one that gets forgotten.**
 *
 * - the board has arrived and holds this ticket — summary and status render
 * - the board has arrived and does not hold it — say so, plainly, and still
 *   offer the link, because `links.resolve` builds a tracker URL from the key
 *   and the project binding without needing the row
 * - **the board has not arrived yet** — say nothing about absence at all
 *
 * Collapsing the last two gives a panel that announces "not on your board" for
 * the first second of every launch, about a ticket that is on it. This codebase
 * has met that shape before: it is why note subject presence is `present` /
 * `absent` / `unknown` rather than a boolean, and the two-state version reported
 * every note as orphaned on first run.
 *
 * **It does not obey the project filter.** Every lane does; this is not a lane.
 * The filter narrows *the board* to a project, and the active ticket is a single
 * pointer to what is happening now — blanking it because the operator pressed a
 * chip would read as "nothing is active", which is a different and false claim.
 */

export interface ActiveTicketView {
  ticketKey: string
  setBy: 'user' | 'agent'
  setById: string | null
  setAt: string
}

export interface ActiveTicketProps {
  /** `null` means nothing is set. `undefined` means the read has not answered. */
  active: ActiveTicketView | null | undefined
  /**
   * The **unfiltered** board snapshot — see the note above on the filter.
   * `undefined` until it arrives, which is what distinguishes "not on the board"
   * from "the board is not here yet".
   */
  items: readonly WorkItem[] | undefined
  onClear(): void
  now?: Date
}

/**
 * `formatAge` answers "now" for anything under a minute, which reads as "now
 * ago" if it is concatenated blindly. Every other caller renders it in a column
 * of its own where the bare word is right; this one puts it in a sentence.
 */
function setAge(at: string, now: Date | undefined): string {
  const age = formatAge(at, now)
  return age === 'now' ? 'just now' : `${age} ago`
}

export function ActiveTicket({ active, items, onClear, now }: ActiveTicketProps): ReactElement {
  const item = active === null || active === undefined
    ? undefined
    : items?.find((candidate) => candidate.ticket.key === active.ticketKey)

  return (
    <Section id="active-ticket" title="Active ticket" className="lane panel">
      {active === null || active === undefined ? (
        <EmptyState title="Nothing is being worked">
          An agent sets this when it picks a ticket up, through <code>grndctrl-mcp</code>. You can
          also set it yourself from any row in the ticket lane.
        </EmptyState>
      ) : (
        <div className="active" data-known={item !== undefined}>
          <button
            type="button"
            className="active__key"
            onClick={() => void launch(active.ticketKey, 'ticket')}
          >
            {/*
              The issue key when the board has the row, and the natural key when
              it does not. The natural key is uglier and it is what is *known* —
              inventing a prettier identifier out of a string this file is not
              allowed to parse would be a guess rendered as a fact (see
              `domain/keys.ts`: keys are opaque, nothing parses them).
            */}
            {item?.ticket.issueKey ?? active.ticketKey}
          </button>

          {item === undefined ? (
            items === undefined ? (
              // The board has not answered yet. Deliberately silent about
              // whether this ticket is on it — the sentence below would be a
              // claim, and for the first second of every launch a false one.
              <p className="active__summary muted">Loading the board…</p>
            ) : (
              <p className="active__summary muted">
                Not on your board — its summary and status are not here. That is expected for a
                ticket that is not assigned to you, or one set before the next sync. Opening it
                still goes to the tracker.
              </p>
            )
          ) : (
            <>
              <p className="active__summary">{item.ticket.summary}</p>
              <p className="active__status">{item.ticket.statusName}</p>
              {/*
                Three states again, and the same rule as above: say nothing you
                were not told.

                `null` is "no description has reached this mirror" — which is
                true of a ticket written before the column existed, and of every
                ticket on a connection that has never successfully synced. Saying
                "no description" there would be a claim about the ticket made
                from an absence of data about the ticket.

                `[]` is "the tracker says there is none", which *is* a fact and
                is worth stating, because a description section that is simply
                missing reads as a panel that failed to render.
              */}
              {item.ticket.description === null ? null : item.ticket.description.length === 0 ? (
                <p className="active__summary muted">No description.</p>
              ) : (
                <Document nodes={item.ticket.description} />
              )}
            </>
          )}

          <p className="active__meta">
            Set by {active.setBy === 'agent' ? (active.setById ?? 'an agent') : 'you'}
            {', '}
            {setAge(active.setAt, now)}
          </p>

          <button type="button" className="active__clear" onClick={onClear}>
            Clear
          </button>
        </div>
      )}
    </Section>
  )
}
