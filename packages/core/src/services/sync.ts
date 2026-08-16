import { branchKey } from '../domain/keys.js'
import type {
  BranchRef,
  FailureReason,
  Project,
  ResourceKind,
  Settings,
  Ticket,
} from '../domain/types.js'
import { applyActivity } from '../providers/jira/index.js'
import { branchesNeedingComparison } from '../providers/github/query.js'
import type { CodeProvider, LocalGitProvider, TicketProvider } from '../providers/seam.js'
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
 */

export interface SyncTargets {
  projects: readonly Project[]
  ticketProviders: ReadonlyMap<string, TicketProvider>
  codeProviders: ReadonlyMap<string, CodeProvider>
  git: LocalGitProvider
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

/**
 * The reserved connection id local git records itself under.
 *
 * Local git has no `Connection` row — there is no host and no credential — but
 * the mirror's freshness table is keyed by connection and resource kind, and
 * the branches lane has to be able to say how old it is like every other lane
 * does (XIV). So it gets an id that no provider can collide with.
 *
 * Named rather than spelled out at each use because the poll scheduler now
 * schedules against it too, and a literal in two packages is a literal that
 * will disagree with itself eventually.
 */
export const LOCAL_CONNECTION_ID = 'local'

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

    const provider =
      options.targets.ticketProviders.get(connection.id) ??
      options.targets.codeProviders.get(connection.id)
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
  // Jira, GitHub and local git are still refreshed independently of each other.
  // Awaiting in sequence keeps the rate-limit story simple; the isolation that
  // matters is the error boundary, not the concurrency.
  for (const [connectionId, projects] of byConnection(options.targets.projects, (p) => p.jiraConnectionId)) {
    if (wanted(connectionId)) {
      results.push(...(await syncTickets(options, projects, connectionId, now)))
    }
  }

  for (const [connectionId, projects] of byConnection(options.targets.projects, (p) => p.githubConnectionId)) {
    if (wanted(connectionId)) {
      results.push(...(await syncCode(options, projects, connectionId, now)))
    }
  }

  // `replaceWorkspaces` takes no scope at all, so this has to be once for the
  // whole run rather than once per project.
  //
  // Scoped by `wanted` like the other two, under the reserved id the mirror
  // already records it against. It was unconditional until the poll scheduler
  // arrived (T074), and that made per-target backoff impossible: a checkout on
  // an unmounted drive would be retried by every GitHub poll no matter how many
  // times it had just failed, because the GitHub poll ran it too. It also meant
  // a refresh of one Jira connection re-read every checkout on disk and stamped
  // the branches lane as freshly synced, which is work the operator did not ask
  // for and a freshness claim about a question they did not ask.
  if (wanted(LOCAL_CONNECTION_ID)) {
    results.push(...(await syncLocal(options, options.targets.projects, now)))
  }

  return { startedAt, finishedAt: now().toISOString(), results }
}

/** Projects grouped by one of their connections, skipping those that have none. */
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
    // The recently-closed arm is kept, still inside the assignee filter, because
    // drift rules D1 and D4 compare a ticket's terminal status against an open
    // or merged PR -- and a ticket that closed yesterday is exactly the one
    // those rules have something to say about.
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

async function syncCode(
  options: SyncOptions,
  projects: readonly Project[],
  connectionId: string,
  now: () => Date,
): Promise<SyncResult[]> {
  const provider = options.targets.codeProviders.get(connectionId)

  // Distinct repositories: two projects on one connection may share one, and
  // fetching it twice would double every row before the single write below.
  const repos = [
    ...new Map(
      projects.flatMap((p) =>
        p.repoOwner === null || p.repoName === null
          ? []
          : [[`${p.repoOwner}/${p.repoName}`, { owner: p.repoOwner, repo: p.repoName }] as const],
      ),
    ).values(),
  ]
  // Order matters: no repositories bound is a configuration, not a failure, and
  // reporting it as one would put a red lane on a correctly configured board.
  if (repos.length === 0) return []
  if (provider === undefined) return [unusable(options, connectionId, 'pulls', now)]

  const pullRequests = []
  const checks = []
  const perRepo: { owner: string; repo: string; branches: BranchRef[] }[] = []

  try {
    for (const { owner, repo } of repos) {
      const fetched = await provider.fetchRepository({ owner, repo })
      pullRequests.push(...fetched.pullRequests)
      checks.push(...fetched.checks)
      perRepo.push({ owner, repo, branches: fetched.branches })
    }
  } catch (e) {
    // Every repository or none. A partial set written here would replace the
    // whole connection's rows and delete good cached data for the repositories
    // that did answer -- while freshness read "fresh" over a half-empty board.
    // Leaving the mirror alone lets XV do its job: stale, and saying so.
    return [
      recordFailure(options, connectionId, 'pulls', e, now),
      recordFailure(options, connectionId, 'branches', e, now),
      recordFailure(options, connectionId, 'checks', e, now),
    ]
  }

  const branches = perRepo.flatMap((r) => r.branches)

  options.mirror.replacePullRequests(connectionId, pullRequests)
  options.mirror.replaceChecks(connectionId, checks)
  options.mirror.replaceBranches(connectionId, branches)

  const at = now().toISOString()
  options.mirror.recordSuccess(connectionId, 'pulls', at)
  options.mirror.recordSuccess(connectionId, 'checks', at)
  options.mirror.recordSuccess(connectionId, 'branches', at)

  const results: SyncResult[] = [
    { connectionId, resourceKind: 'pulls', ok: true, count: pullRequests.length },
    { connectionId, resourceKind: 'branches', ok: true, count: branches.length },
    { connectionId, resourceKind: 'checks', ok: true, count: checks.length },
  ]

  // Comparisons are their own resource kind because they fail on their own:
  // a token can read a repository and still lack the scope compare needs, and
  // that must degrade ahead/behind without taking the PR lane with it (R3).
  try {
    const comparisons = []

    for (const { owner, repo, branches: repoBranches } of perRepo) {
      const remote = `github.com/${owner}/${repo}`
      const needed = branchesNeedingComparison(
        repoBranches.map((b) => ({ name: b.name, headSha: b.headSha })),
        options.mirror.listComparisons(),
        (name) => branchKey(remote, name),
      )

      comparisons.push(
        ...(await provider.compareBranches({ owner, repo, baseRef: 'main', branches: needed })),
      )
    }

    // An upsert keyed per branch, so accumulating across repositories is safe.
    options.mirror.upsertComparisons(comparisons)
    options.mirror.recordSuccess(connectionId, 'comparisons', now().toISOString())
    results.push({ connectionId, resourceKind: 'comparisons', ok: true, count: comparisons.length })
  } catch (e) {
    results.push(recordFailure(options, connectionId, 'comparisons', e, now))
  }

  return results
}

async function syncLocal(
  options: SyncOptions,
  projects: readonly Project[],
  now: () => Date,
): Promise<SyncResult[]> {
  // Every checkout across every project, deduplicated: `replaceWorkspaces` is
  // not scoped to anything, so it has to be called once with the complete set.
  // Two projects sharing a checkout would otherwise insert it twice.
  const paths = [...new Set(projects.flatMap((p) => p.checkoutPaths))]
  if (paths.length === 0) return []

  const workspaces = []
  const failures: string[] = []

  for (const path of paths) {
    try {
      workspaces.push(...(await options.targets.git.readWorkspaces({ repoPath: path })))
    } catch (e) {
      // One missing checkout must not hide the others (FR-004's spirit and the
      // spec's "which checkout is missing" edge case).
      failures.push(`${path}: ${messageOf(e)}`)
    }
  }

  const at = now().toISOString()

  if (failures.length === 0) {
    options.mirror.replaceWorkspaces(workspaces)
    options.mirror.recordSuccess(LOCAL_CONNECTION_ID, 'local', at)
    return [{ connectionId: LOCAL_CONNECTION_ID, resourceKind: 'local', ok: true, count: workspaces.length }]
  }

  /**
   * Nothing is written when any path failed — the same rule the GitHub fetch
   * follows, and for the same reason.
   *
   * This used to write the partial set, on the argument that a checkout which
   * cannot be read is one that is genuinely not on disk. That argument does not
   * survive contact with an external drive, a network share, or a VPN that
   * dropped: the branches are still there, and this process simply could not
   * look. `replaceWorkspaces` takes no scope, so writing the partial set
   * deletes every workspace under the path that failed — and the lane then
   * shows an empty list *while saying it failed to refresh*, which reads as
   * "you have no branches" to anyone who does not stop to reconcile the two.
   *
   * Keeping the cache and reporting the failure is the honest pair: the rows
   * are what was last true, and the lane says they are not current.
   */
  options.mirror.recordFailure(LOCAL_CONNECTION_ID, 'local', at, 'notFound', null)
  return [
    {
      connectionId: LOCAL_CONNECTION_ID,
      resourceKind: 'local',
      ok: false,
      count: workspaces.length,
      failureReason: 'notFound',
      detail: failures.join('; '),
    },
  ]
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
