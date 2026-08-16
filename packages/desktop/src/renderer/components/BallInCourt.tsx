import type { ReactElement } from 'react'
import type { BallInCourt as Court, WorkItem } from '../types.js'

/**
 * Who is holding each thing up (T143).
 *
 * Three buckets, and the honest one is the middle. **You** is the pile to work
 * through. **Agent** is running and needs nothing. **Them** is the pile that will
 * not move on its own and is the one people forget — a review requested four
 * days ago is not "in progress", it is stopped, and it stays stopped until
 * somebody chases it. A board that only showed your own work would let it sit
 * there indefinitely, which is precisely how a week disappears.
 *
 * Rendered as counts with the same glyph vocabulary the rows use, so scanning a
 * lane and reading this panel are the same skill.
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
    <section className="court" aria-label="Ball in court">
      <header className="lane__head">
        <span>Ball in court</span>
        <span className="lane__count">{items.length}</span>
      </header>

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
    </section>
  )
}
