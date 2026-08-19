import type { FailureReason, Project, ResourceKind, Settings, Ticket } from '../domain/types.js'
import { applyActivity } from '../providers/jira/index.js'
import type { TicketProvider } from '../providers/seam.js'
import { isOperationError, type ErrorCode } from '../registry/errors.js'
import type { MirrorRepository } from '../store/mirror/repository.js'

/**
 * Refreshing the mirror.
 *
 * Constitution XV governs the shape of this file: a failing provider must not
 * degrade any other provider's data. So every fetch is isolated, every failure
 * is recorded against **that connection and that resource kind**, and one
 * provider throwing never prevents another from being written.
 *
 * The instinct to wrap the whole sync in one try/catch is exactly the bug the
 * gate exists to prevent — the lanes just look empty, which reads as "no work"
 * rather than "no data".
 *
 * **`syncTickets` is the whole of this file now.** `syncCode` fetched pull
 * requests, branches, checks and comparisons; `syncLocal` read every checkout on
 * disk. Both are gone with their providers, and so is the reserved `local`
 * connection id they needed. The isolation the gate asks for is unchanged and
 * still worth having: with several Jira connections, one failing must not empty
 * the others, and it is the same per-connection-per-resource-kind boundary that
 * made that true across three providers.
 */

export interface SyncTargets {
  projects: readonly Project[]
  ticketProviders: ReadonlyMap<string, TicketProvider>
  /**
   * Connections that could not be given a provider, and why.
   *
   * Carried here because without it a missing provider is indistinguishable
   * from having nothing bound to sync, and the two were treated identically:
   * both returned no results at all. A refresh with the credential revoked
   * therefore reported `ok: true`, wrote nothing, recorded nothing, and left
   * every lane quietly ageing with no statement anywhere that the board could
   * not be refreshed. `buildSyncTargets` has always computed this; nothing read
   * it.
   */
  unavailable?: readonly { connectionId: string; reason: 'no-credential' | 'keychain-unavailable' }[]
}

export interface SyncReport {
  startedAt: string
  finishedAt: string
  results: SyncResult[]
}

export interface SyncResult {
  connectionId: string
  resourceKind: ResourceKind
  ok: boolean
  count: number
  failureReason?: FailureReason
  detail?: string
}

/**
 * The most tickets one connection will pull in a single sync.
 *
 * Not a page size — pagination follows the token to the end. This is the stop
 * for the pathological case: a project key that matches far more than anyone
 * meant, on a poll that repeats every five minutes. Crossing it is reported as
 * a failed result rather than absorbed, because a board that silently stops at
 * a limit is indistinguishable from a board that is complete.
 */
const MAX_TICKETS_PER_CONNECTION = 2_000

export interface SyncOptions {
  mirror: MirrorRepository
  targets: SyncTargets
  settings: Settings
  now?: () => Date
  /** Restrict the run to one connection. Used by manual refresh (FR-014). */
  connectionId?: string
}

export async function runSync(options: SyncOptions): Promise<SyncReport> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const results: SyncResult[] = []

  const wanted = (connectionId: string) =>
    options.connectionId === undefined || options.connectionId === connectionId

  // Who "mine" means, per connection (FR-033), before anything is correlated.
  //
  // Nothing resolved this before: the connection was written with a null
  // identity at import and never revisited, so `operatorAccountIds` was empty
  // and every "is this mine?" answered no. The visible effect was a board that
  // filed the operator's own tickets under someone else and claimed every
  // unassigned one instead -- confidently, with no error anywhere.
  //
  // Re-resolved every sync rather than cached at import, because a connection's
  // token can be replaced with one belonging to a different account. That is not
  // hypothetical; it happened while setting this up.
  for (const connection of options.mirror.listConnections()) {
    if (!wanted(connection.id)) continue

    const provider = options.targets.ticketProviders.get(connection.id)
    if (provider === undefined) continue

    try {
      const viewer = await provider.viewer()
      if (connection.viewerIdentity?.accountId !== viewer.accountId) {
        options.mirror.upsertConnection({ ...connection, viewerIdentity: viewer })
      }
    } catch {
      // Not worth failing the sync over on its own -- whatever is wrong with the
      // credential will fail the fetch below and be recorded there, against a
      // resource kind the board already knows how to report.
    }
  }

  // Grouped by connection, because the connection is what the mirror replaces.
  //
  // This loop used to be per project, and every `replaceX` inside it deletes by
  // connection id -- so with two projects on one connection the second silently
  // deleted the first's rows and reported `ok: true` for both. Invisible with
  // one project per connection, which is every fixture and every test we had.
  //
  // Connections are still refreshed independently of each other. Awaiting in
  // sequence keeps the rate-limit story simple; the isolation that matters is
  // the error boundary, not the concurrency.
  for (const [connectionId, projects] of byConnection(options.targets.projects, (p) => p.jiraConnectionId)) {
    if (wanted(connectionId)) {
      results.push(...(await syncTickets(options, projects, connectionId, now)))
    }
  }

  return { startedAt, finishedAt: now().toISOString(), results }
}

/**
 * Projects grouped by one of their connections, skipping those that have none.
 *
 * Still a helper taking an accessor, with one caller. It was called three times
 * with three different accessors; keeping the shape costs a parameter and makes
 * the grouping-by-connection rule — which is what stopped one project's rows
 * deleting another's — a named thing rather than an inline `reduce`.
 */
function byConnection(
  projects: readonly Project[],
  connectionOf: (project: Project) => string | null,
): Map<string, Project[]> {
  const grouped = new Map<string, Project[]>()

  for (const project of projects) {
    const connectionId = connectionOf(project)
    if (connectionId === null) continue

    const existing = grouped.get(connectionId)
    if (existing === undefined) grouped.set(connectionId, [project])
    else existing.push(project)
  }

  return grouped
}

async function syncTickets(
  options: SyncOptions,
  projects: readonly Project[],
  connectionId: string,
  now: () => Date,
): Promise<SyncResult[]> {
  const provider = options.targets.ticketProviders.get(connectionId)
  const keys = [
    ...new Set(projects.map((p) => p.jiraProjectKey).filter((k): k is string => k !== null)),
  ]
  // Nothing bound to fetch is not a failure, and must not be reported as one:
  // a connection with no ticket project on it is a normal configuration.
  if (keys.length === 0) return []
  if (provider === undefined) return [unusable(options, connectionId, 'tickets', now)]

  try {
    // One query covering every project on this connection, so the single write
    // below holds all of them.
    //
    // Scoped to the operator's own assignments. Without that clause this pulls
    // every open ticket in every bound project -- measured against real
    // projects, several hundred rows of which roughly two thirds were backlog
    // nobody had touched. A command station is the work you are holding, not an
    // export of the tracker.
    //
    // The recently-closed arm is kept, still inside the assignee filter, and its
    // justification has changed. It was here for drift rules D1 and D4, which
    // compared a ticket's terminal status against an open or merged pull
    // request; both are gone. It stays because a ticket the operator closed
    // yesterday is still theirs to see for a moment -- work that has just landed
    // vanishing from the board the instant it is marked Done reads as work that
    // was lost. That is a weaker argument than the one it replaces, and it is
    // written here rather than left as an unexplained clause.
    //
    // The parentheses are load bearing: JQL binds AND tighter than OR, so
    // without them the recency arm escapes both the project and the assignee
    // filter and returns every recently touched issue on the site.
    const jql =
      `project IN (${keys.map((k) => `"${k}"`).join(', ')}) ` +
      `AND assignee = currentUser() ` +
      `AND (statusCategory != Done OR updated >= -30d) ORDER BY updated DESC`

    // Every page, not the first one. The endpoint reports no total (R2), so
    // "did we get everything" is answerable only by following the token until
    // it stops coming back -- and a single page silently kept the hundred most
    // recently updated issues and discarded the rest of the operator's work.
    let tickets: Ticket[] = []
    let pageToken: string | undefined
    let truncated = false

    do {
      const page = await provider.searchIssues({
        jql,
        ...(pageToken === undefined ? {} : { pageToken }),
      })
      tickets.push(...page.tickets)
      pageToken = page.nextPageToken ?? undefined

      // A ceiling, because the alternative to a bound is an unbounded loop over
      // whatever a mistyped filter matched. Reported rather than hidden: a board
      // that quietly stops at a limit is the failure this whole change is about.
      if (tickets.length >= MAX_TICKETS_PER_CONNECTION && pageToken !== undefined) {
        truncated = true
        break
      }
    } while (pageToken !== undefined)

    // History is a second, separate call -- the search response does not
    // dependably carry it, and `updated` is the field FR-027 exists to
    // distrust (research R2).
    let activityOk = true
    let activityDetail: string | undefined

    try {
      const activity = await provider.fetchChangelogs(tickets.map((t) => t.issueKey))
      tickets = applyActivity(tickets, activity)
    } catch (e) {
      // The tickets are still worth showing. What is not acceptable is
      // silently falling back to `updated` -- the lane reports activity as
      // unknown and says so, rather than displaying a confident wrong age.
      activityOk = false
      activityDetail = messageOf(e)
    }

    options.mirror.replaceTickets(connectionId, tickets)
    options.mirror.recordSuccess(connectionId, 'tickets', now().toISOString())

    const results: SyncResult[] = [
      { connectionId, resourceKind: 'tickets', ok: true, count: tickets.length },
    ]

    if (!activityOk) {
      results.push({
        connectionId,
        resourceKind: 'tickets',
        ok: false,
        count: 0,
        failureReason: 'unknown',
        detail: `Ticket history unavailable, so activity is unknown: ${activityDetail}`,
      })
    }

    if (truncated) {
      results.push({
        connectionId,
        resourceKind: 'tickets',
        ok: false,
        count: tickets.length,
        failureReason: 'unknown',
        detail:
          `Stopped at ${MAX_TICKETS_PER_CONNECTION} tickets with more still to fetch. ` +
          `The board is incomplete — narrow the projects bound to this connection.`,
      })
    }

    return results
  } catch (e) {
    return [recordFailure(options, connectionId, 'tickets', e, now)]
  }
}

/**
 * A connection with work bound to it that could not be given a provider.
 *
 * Recorded as a real failure against the resource, rather than skipped, so the
 * lane says "could not refresh" instead of ageing silently. The distinction the
 * operator needs — the credential is *gone* rather than *rejected* — is in the
 * detail and in `sync.status.unavailable`, because the remedies differ: one is
 * "sign in again", the other is "your keychain is not running" (FR-006), and
 * Ground Control will not fall back to storing the token anywhere else.
 *
 * `auth` for both, because `FailureReason` describes what the board should say
 * about the data and in both cases the answer is the same: this connection is
 * not authenticated and the rows on screen are the last ones that arrived.
 */
function unusable(
  options: SyncOptions,
  connectionId: string,
  resourceKind: ResourceKind,
  now: () => Date,
): SyncResult {
  const gap = options.targets.unavailable?.find((u) => u.connectionId === connectionId)
  const detail =
    gap?.reason === 'keychain-unavailable'
      ? 'The credential store could not be reached, so this connection has no usable credential. Ground Control will not fall back to storing it anywhere else.'
      : 'No credential is stored for this connection. Add it again in Settings.'

  options.mirror.recordFailure(connectionId, resourceKind, now().toISOString(), 'auth', null)

  return { connectionId, resourceKind, ok: false, count: 0, failureReason: 'auth', detail }
}

function recordFailure(
  options: SyncOptions,
  connectionId: string,
  resourceKind: ResourceKind,
  error: unknown,
  now: () => Date,
): SyncResult {
  const reason = reasonOf(error)
  const retryAfterSec = isOperationError(error) ? error.details.retryAfterSec : undefined
  const nextAttemptAt =
    retryAfterSec === undefined ? null : new Date(now().getTime() + retryAfterSec * 1000).toISOString()

  options.mirror.recordFailure(connectionId, resourceKind, now().toISOString(), reason, nextAttemptAt)

  return {
    connectionId,
    resourceKind,
    ok: false,
    count: 0,
    failureReason: reason,
    detail: messageOf(error),
  }
}

function reasonOf(error: unknown): FailureReason {
  if (!isOperationError(error)) return 'unknown'

  const map: Partial<Record<ErrorCode, FailureReason>> = {
    unauthorized: 'auth',
    rate_limited: 'rateLimit',
    provider_unavailable: 'network',
    not_found: 'notFound',
  }
  return map[error.code] ?? 'unknown'
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
