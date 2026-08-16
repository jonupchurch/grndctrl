import type { ReactElement } from 'react'
import { StatusMark } from './StatusMark.js'

/**
 * The four numbers across the top (T139 — FR-073).
 *
 * They answer, in order: what is mine, what disagrees, what has stopped moving,
 * and what is an agent doing. That order is the question an operator actually
 * arrives with, and it is why "Your court" is first and is the only one that is
 * also a *control*.
 *
 * **The first tile is a toggle.** Pressing it filters the whole board to the
 * operator's own work. That is the single most common thing anyone wants from
 * this screen, and making the number that reports it also the control that
 * applies it means the answer and the action are the same object. It is a
 * `button` with `aria-pressed`, so the toggle state is announced rather than
 * conveyed by a background colour.
 *
 * The other three read as buttons too but are not toggles yet — the drift and
 * stalled filters are worth having and are not in this slice. They are rendered
 * as plain figures rather than dead buttons, because a control that does nothing
 * when pressed is worse than no control.
 */

export interface StatTilesProps {
  yourCourt: number
  drifting: number
  stalled: number
  agentsLive: number
  totalSessions: number
  mineOnly: boolean
  onToggleMine(): void
}

export function StatTiles({
  yourCourt,
  drifting,
  stalled,
  agentsLive,
  totalSessions,
  mineOnly,
  onToggleMine,
}: StatTilesProps): ReactElement {
  return (
    <div className="tiles">
      <button
        type="button"
        className="tile tile--toggle"
        aria-pressed={mineOnly}
        onClick={onToggleMine}
      >
        <span className="tile__label">Your court</span>
        <span className="tile__value">{yourCourt}</span>
        <span className="tile__sub">
          {mineOnly ? 'showing only yours — press to show all' : 'press to show only yours'}
        </span>
      </button>

      <Figure
        label="Drifting"
        value={drifting}
        sub={drifting === 0 ? 'the systems agree' : 'two sources disagree'}
        severity={drifting === 0 ? 'good' : 'critical'}
      />

      <Figure
        label="Stalled"
        value={stalled}
        sub="no real activity in 3 days"
        severity={stalled === 0 ? 'good' : 'serious'}
      />

      <Figure
        label="Agents live"
        value={agentsLive}
        sub={`of ${totalSessions} session${totalSessions === 1 ? '' : 's'}`}
        severity="good"
        accent
      />
    </div>
  )
}

function Figure({
  label,
  value,
  sub,
  severity,
  accent = false,
}: {
  label: string
  value: number
  sub: string
  severity: 'good' | 'warning' | 'serious' | 'critical'
  accent?: boolean
}): ReactElement {
  return (
    <figure className="tile" data-accent={accent}>
      <figcaption className="tile__label">
        {/* Shape and label, so the tile is readable in greyscale like every
            other status on the board (SC-015). */}
        <StatusMark severity={severity} size={8} />
        {label}
      </figcaption>
      <span className="tile__value">{value}</span>
      <span className="tile__sub">{sub}</span>
    </figure>
  )
}
