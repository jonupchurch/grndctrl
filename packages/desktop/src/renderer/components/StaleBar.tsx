import type { ReactElement } from 'react'

/**
 * The staleness gauge: a leading bar on every row, five bands (T135).
 *
 * It grows and then changes colour, which is two channels for one quantity on
 * purpose — the height is readable in peripheral vision while scanning a lane,
 * and the colour is what makes the last two bands stop being ignorable.
 *
 * **Measured from the last *real* activity, never from a heartbeat.** That
 * distinction is the whole reason `lastRealActivityAt` exists separately in the
 * domain: an agent that has crashed mid-task keeps its heartbeat going in some
 * runtimes, and a row that says "active 20 seconds ago" because a zombie is
 * still breathing is worse than no gauge at all. It would hide precisely the
 * situation the board exists to surface.
 */

export type StalenessBand = 'idle' | 'recent' | 'aging' | 'stale' | 'abandoned'

/** Heights and roles from the design system, in band order. */
const BANDS: Record<StalenessBand, { height: number; tone: string; age: string; label: string }> = {
  idle: { height: 3, tone: 'var(--line-strong)', age: '0–4h', label: 'Under 4 hours' },
  recent: { height: 6, tone: 'var(--warning)', age: '4–24h', label: 'Same day' },
  aging: { height: 9, tone: 'var(--warning)', age: '1–3d', label: 'Two to three days' },
  stale: { height: 12, tone: 'var(--serious)', age: '3–7d', label: 'Past the lane threshold' },
  abandoned: { height: 12, tone: 'var(--critical)', age: '7d+', label: 'Abandoned' },
}

export interface StaleBarProps {
  band: StalenessBand
  /**
   * When the subject was last *really* active. `null` means never — which is a
   * distinct thing from "a long time ago" and is described as such.
   */
  lastRealActivityAt: string | null
  now?: Date
}

export function StaleBar({ band, lastRealActivityAt, now }: StaleBarProps): ReactElement {
  const { height, tone, age, label } = BANDS[band]

  /**
   * Described in words, not in ISO.
   *
   * This string is the row's accessible name, because the bar is the row's first
   * child — so a screen reader announcing a ticket used to open with
   * "2026-08-11T08:00:00Z", read digit by digit, before reaching the ticket key.
   * Caught by reading a Playwright failure message, which prints the accessible
   * name and made it impossible not to notice.
   */
  const description =
    lastRealActivityAt === null
      ? `${label} — no activity recorded`
      : `${label} (${age}), last active ${formatAge(lastRealActivityAt, now)} ago`

  return (
    <span className="stale-bar" data-band={band} title={description}>
      <span
        className="stale-bar__fill"
        style={{ height: `${height}px`, background: tone }}
        aria-hidden="true"
      />
      <span className="visually-hidden">{description}</span>
    </span>
  )
}

/**
 * "3d 04h" — the age text that sits in the row's last slot.
 *
 * Coarse on purpose. The board is glanced at, and a minute-accurate age on a
 * three-day-old ticket is precision about a number nobody is going to act on to
 * the minute. Under an hour it says minutes, because that range is the one where
 * the difference matters.
 */
export function formatAge(from: string | null, now: Date = new Date()): string {
  if (from === null) return '—'

  const startedMs = Date.parse(from)
  if (Number.isNaN(startedMs)) return '—'

  const seconds = Math.max(0, Math.floor((now.getTime() - startedMs) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`

  const hours = Math.floor(seconds / 3600)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  // Two units below a week, one above: "9d 03h" is more digits than meaning.
  return days < 7 ? `${days}d ${String(hours % 24).padStart(2, '0')}h` : `${days}d`
}
