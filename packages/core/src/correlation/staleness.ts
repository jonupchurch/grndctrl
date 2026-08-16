import type { StalenessBand, Timestamp } from '../domain/types.js'

/**
 * Two different measures of "how long has this been sitting", deliberately kept
 * apart. Conflating them was the bug this separation prevents.
 *
 *   **The gauge** (here) is absolute: five fixed bands from the design, so a
 *   row's leading bar means the same thing in every lane. Four hours is four
 *   hours whether it is a PR or a ticket.
 *
 *   **The severity contribution** (severity.ts) is relative to that lane's
 *   threshold, because 24 hours is unremarkable for a ticket and overdue for a
 *   pull request.
 *
 * A single "staleness" number would have to pick one, and would then be wrong
 * for whichever half it did not pick.
 */

interface Band {
  /** Upper bound in hours, exclusive. */
  maxHours: number
  band: StalenessBand
}

const BANDS: readonly Band[] = [
  { maxHours: 4, band: 'idle' },
  { maxHours: 24, band: 'recent' },
  { maxHours: 72, band: 'aging' },
  { maxHours: 168, band: 'stale' },
  { maxHours: Number.POSITIVE_INFINITY, band: 'abandoned' },
]

export function hoursSince(from: Timestamp | null, now: Date): number | null {
  if (from === null) return null
  const t = Date.parse(from)
  if (Number.isNaN(t)) return null
  return Math.max(0, (now.getTime() - t) / 3_600_000)
}

/**
 * The gauge band for a work item.
 *
 * Unknown activity reads as `idle`, not `abandoned`. An unknown is not evidence
 * of neglect, and rendering it as the most alarming band would make every
 * ticket whose history failed to fetch scream for attention (R2: the changelog
 * is a separate call and can fail on its own).
 */
export function stalenessBand(lastRealActivityAt: Timestamp | null, now: Date): StalenessBand {
  const hours = hoursSince(lastRealActivityAt, now)
  if (hours === null) return 'idle'

  for (const b of BANDS) {
    if (hours < b.maxHours) return b.band
  }
  return 'abandoned'
}

/**
 * How many multiples of its lane threshold a work item has exceeded.
 *
 * `0` means inside the threshold. Feeds the staleness row of the severity table
 * (FR-029), where ≥1× is a warning, ≥2× serious, ≥3× critical.
 */
export function thresholdMultiple(
  lastRealActivityAt: Timestamp | null,
  now: Date,
  thresholdHours: number,
): number {
  const hours = hoursSince(lastRealActivityAt, now)
  if (hours === null || thresholdHours <= 0) return 0
  return Math.floor(hours / thresholdHours)
}
