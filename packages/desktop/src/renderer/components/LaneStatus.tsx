import type { ReactElement } from 'react'
import type { FreshnessView } from '../query.js'

/**
 * Degradation, per provider, visibly (T145 — XV, FR-013, FR-015).
 *
 * Four states, four different sentences, and the reason they must not collapse
 * into each other is that they call for four different responses:
 *
 * - **fresh** — nothing to say. Silence is the correct rendering.
 * - **stale** — the data is real but old. Wait, or refresh.
 * - **failed** — a refresh was attempted and did not work. *Go and fix
 *   something* — and which thing depends on the reason, which is why the reason
 *   is named rather than summarised as "error".
 * - **never** — this has never synced. There is no age to report, and reporting
 *   one would be inventing data. Usually it means a credential was never
 *   supplied, which is a different action again.
 *
 * The failure mode this prevents is the ordinary one: a lane that silently shows
 * yesterday's pull requests because a token expired overnight. The board would
 * look perfectly healthy and be wrong, and the operator would find out from a
 * colleague.
 */

const REASONS: Record<string, string> = {
  // Not "the credential was refused". `auth` covers a token the provider
  // rejected *and* a connection with no stored credential at all — and saying
  // "refused" in the second case is a claim about a conversation that never
  // happened, while `ConnectionNotice` sits above this saying the credential is
  // missing. Two sentences disagreeing on one screen is worse than one vague
  // sentence, and the precise cause is in the notice either way.
  auth: 'the connection is not authenticated',
  rateLimit: 'the provider is rate limiting',
  network: 'the provider could not be reached',
  notFound: 'the project or repository was not found',
  unknown: 'the provider returned an error',
}

export interface LaneStatusProps {
  freshness: FreshnessView | null
  /** What this lane is called, so the sentence names something concrete. */
  resource: string
  now?: Date
}

export function LaneStatus({ freshness, resource, now }: LaneStatusProps): ReactElement | null {
  if (freshness === null || freshness.state === 'fresh') return null

  const at = now ?? new Date()

  if (freshness.state === 'never') {
    return (
      <span className="lane-status" data-state="never">
        <span className="lane-status__dot" aria-hidden="true" />
        {resource} have never synced — connect an account in settings
      </span>
    )
  }

  if (freshness.state === 'failed') {
    const why = REASONS[freshness.failureReason ?? 'unknown'] ?? REASONS['unknown']
    const retry = describeRetry(freshness.nextAttemptAt, at)
    const showing =
      freshness.lastSuccessAt === null
        ? 'nothing has ever loaded'
        : `showing ${relative(freshness.lastSuccessAt, at)}`

    return (
      <span className="lane-status" data-state="failed" role="status">
        <span className="lane-status__dot" aria-hidden="true" />
        {resource} failed to refresh — {why}; {showing}
        {retry}
      </span>
    )
  }

  return (
    <span className="lane-status" data-state="stale">
      <span className="lane-status__dot" aria-hidden="true" />
      {resource} last refreshed {relative(freshness.lastSuccessAt, at)}
    </span>
  )
}

/**
 * When it will try again.
 *
 * Named because the alternative is an operator clicking Refresh repeatedly at a
 * rate-limited provider, which is the one action that makes a rate limit worse.
 */
function describeRetry(nextAttemptAt: string | null, now: Date): string {
  if (nextAttemptAt === null) return ''

  const seconds = Math.round((Date.parse(nextAttemptAt) - now.getTime()) / 1000)
  if (Number.isNaN(seconds)) return ''
  if (seconds <= 0) return ', retrying now'
  if (seconds < 60) return `, retrying in ${seconds}s`

  return `, retrying in ${Math.round(seconds / 60)}m`
}

function relative(iso: string | null, now: Date): string {
  if (iso === null) return 'never'

  const seconds = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000))
  if (Number.isNaN(seconds)) return 'never'
  if (seconds < 90) return 'just now'
  if (seconds < 3600) return plural(Math.round(seconds / 60), 'minute')
  if (seconds < 86_400) return plural(Math.round(seconds / 3600), 'hour')

  return plural(Math.round(seconds / 86_400), 'day')
}

/**
 * "1 day ago", not "1 days ago".
 *
 * Small, and worth doing because of where this string appears: beside a
 * statement that something is wrong, which is the moment an operator is most
 * carefully reading the words. A sentence that is visibly sloppy invites the
 * reader to discount the one next to it.
 */
function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`
}
