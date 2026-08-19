import type { ActivityAuthorKind, Ticket, TicketActivity, Timestamp } from '../domain/types.js'

/**
 * "Last real activity" — the number the whole staleness display rests on.
 *
 * FR-026 says what counts: a state change made by a human or an agent. FR-027
 * says what does not, and that half is the point. A ticket touched hourly by an
 * automation rule looks alive on `updated_at` and is in fact abandoned; a board
 * that believes `updated_at` will confidently report the most neglected work as
 * the freshest.
 */

/** Fields whose change is a real state change when a human or agent makes it. */
const REAL_FIELDS = new Set([
  'status',
  'assignee',
  'resolution',
  'comment',
  'description',
  'summary',
  'priority',
  'sprint',
  'fixVersion',
  'attachment',
  'link',
])

/**
 * Fields that never count, whoever touches them.
 *
 * `labels` is here because label churn is how automation announces itself, and
 * `rank` because a backlog grooming drag reorders a hundred tickets without
 * anyone doing any work on any of them.
 */
const NEVER_REAL_FIELDS = new Set(['labels', 'rank', 'watchers', 'votes', 'timespent', 'worklogId'])

/**
 * Decide once, at ingest, whether a changelog entry counts.
 *
 * Stored alongside the entry rather than recomputed, so the staleness a user is
 * looking at can be traced back to the rule that produced it months later
 * (data-model: `countsAsReal`).
 */
export function countsAsRealActivity(entry: {
  authorKind: ActivityAuthorKind
  field: string
}): boolean {
  if (entry.authorKind !== 'human') return false
  if (NEVER_REAL_FIELDS.has(entry.field)) return false
  return REAL_FIELDS.has(entry.field)
}

/**
 * The most recent real activity, or `null` when there is none to be found.
 *
 * `null` means **unknown** and is rendered as unknown. It is never backfilled
 * from `updated_at`: that is the field FR-027 exists to distrust, and silently
 * substituting it would turn "we could not fetch the history" into a confident
 * wrong answer — the exact failure the freshness rules are built to prevent.
 */
export function lastRealActivity(entries: readonly TicketActivity[]): Timestamp | null {
  let latest: number | null = null
  let latestRaw: Timestamp | null = null

  for (const e of entries) {
    if (!e.countsAsReal) continue
    const t = Date.parse(e.at)
    if (Number.isNaN(t)) continue
    if (latest === null || t > latest) {
      latest = t
      latestRaw = e.at
    }
  }

  return latestRaw
}

/**
 * Roll a work item's activity up from everything that contributes to it.
 *
 * The maximum across the ticket and its agent sessions. It used to also take
 * pull request activity and check completion times, and the argument for the
 * roll-up was theirs: a ticket nobody has touched in a fortnight is not stale if
 * an agent pushed to its branch an hour ago, because the work is moving just not
 * where the tracker can see it.
 *
 * **That argument survives with one source instead of three**, and it is why
 * this is still a maximum rather than a field read. An agent reporting activity
 * through `sessions.activity` is the remaining case of work moving somewhere the
 * tracker cannot see, and it is the one this product is actually about.
 */
export function workItemActivity(parts: {
  ticket?: Ticket | null
  sessionActivity?: readonly (Timestamp | null)[]
}): Timestamp | null {
  return latestOf([parts.ticket?.lastRealActivityAt, ...(parts.sessionActivity ?? [])])
}

export function latestOf(timestamps: readonly (Timestamp | null | undefined)[]): Timestamp | null {
  let best: number | null = null
  let raw: Timestamp | null = null

  for (const ts of timestamps) {
    if (ts === null || ts === undefined) continue
    const t = Date.parse(ts)
    if (Number.isNaN(t)) continue
    if (best === null || t > best) {
      best = t
      raw = ts
    }
  }

  return raw
}

/**
 * Clamp a reported timestamp to the moment it was received.
 *
 * An agent with a skewed clock reporting a time in the future would otherwise
 * sort to the top of the board and stay there forever, and would read as
 * permanently fresh (spec edge case: clock skew).
 */
export function clampToReceipt(reported: Timestamp, receivedAt: Date): Timestamp {
  const t = Date.parse(reported)
  if (Number.isNaN(t)) return receivedAt.toISOString()
  return t > receivedAt.getTime() ? receivedAt.toISOString() : reported
}
