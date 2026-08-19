import type { ReactElement } from 'react'
import { Section } from './Section.js'
import type { BallInCourt as Court, WorkItem } from '../types.js'

/**
 * Who is holding each thing up (T143).
 *
 * Three buckets, and the honest one is the middle. **You** is the pile to work
 * through. **Agent** is running and needs nothing. **Them** is the pile that will
 * not move on its own and is the one people forget — a ticket sitting in a
 * review status is not "in progress", it is stopped, and it stays stopped until
 * somebody chases it. A board that only showed your own work would let it sit
 * there indefinitely, which is precisely how a week disappears.
 *
 * **The middle bucket narrowed and did not empty**, which is the thing to check
 * here rather than assume. It used to be reachable three ways: a review
 * requested on your pull request, a pull request approved and waiting for you to
 * merge, and a ticket in a status that belongs to someone else. 006 removed the
 * first two with the code host. The third is a ticket-only signal and is
 * untouched, so `them` still fills — see `ball.ts`, where the evaluation order
 * that decides it is fixed and tested.
 *
 * Rendered as counts with the same glyph vocabulary the rows use, so scanning a
 * lane and reading this panel are the same skill. All three rows are drawn even
 * at zero: the panel accounts for every item on the board, and a bucket that
 * vanished when empty would make "nothing is waiting on anyone else" look
 * exactly like "this panel forgot a category".
 */

const COURT: { key: Court; glyph: string; label: string; sub: string }[] = [
  { key: 'you', glyph: '●', label: 'You', sub: 'waiting on you' },
  { key: 'them', glyph: '○', label: 'Them', sub: 'waiting on someone else' },
  { key: 'agent', glyph: '◆', label: 'Agent', sub: 'an agent is on it' },
]

export interface BallInCourtProps {
  items: readonly WorkItem[]
  /** Narrows the board to one bucket. Absent until the filter accepts it. */
  onSelect?: ((court: Court) => void) | undefined
  selected?: Court | null
}

export function BallInCourt({ items, onSelect, selected }: BallInCourtProps): ReactElement {
  const counts = { you: 0, them: 0, agent: 0 }
  for (const item of items) counts[item.ballInCourt] += 1

  return (
    <Section id="court" title="Ball in court" className="court" count={items.length}>
      <div className="court__rows">
        {COURT.map((court) => (
          <div
            key={court.key}
            className="court__row"
            data-court={court.key}
            data-selected={selected === court.key}
          >
            <span className="court__glyph" aria-hidden="true">
              {court.glyph}
            </span>
            <span className="court__label">{court.label}</span>
            <span className="court__sub">{court.sub}</span>
            <span className="court__count">{counts[court.key]}</span>
            {onSelect !== undefined && (
              <button type="button" className="court__select" onClick={() => onSelect(court.key)}>
                Show
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  )
}
