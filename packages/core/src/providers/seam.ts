import type {
  BranchRef,
  CheckResult,
  Comparison,
  LocalWorkspace,
  PullRequest,
  Ticket,
  TicketActivity,
  ViewerIdentity,
} from '../domain/types.js'

/**
 * The provider seam.
 *
 * Constitution XVI: Ground Control's own credentials are read-only against
 * providers, and the service layer must never call a write API with the user's
 * stored tokens.
 *
 * Note how that is enforced here — **there is no write method to call.** No
 * `transitionIssue`, no `createComment`, no `merge`, no `requestReviewers`. The
 * guarantee is not a check someone could forget or a flag someone could flip;
 * the function does not exist, so the mistake is a compile error rather than an
 * incident. A future contributor who wants one has to add it to this file
 * first, which is exactly the moment the constitution should be consulted.
 */

export interface TicketProvider {
  /** The authenticated user, per account. "Mine" resolves per connection (FR-033). */
  viewer(): Promise<ViewerIdentity>

  searchIssues(options: {
    jql: string
    pageSize?: number
    /**
     * A `nextPageToken` from a previous call. Omit for the first page.
     *
     * This existed as a return value before it existed as a parameter, so the
     * sync could see that more pages remained and had no way to ask for them —
     * it silently kept the first hundred issues and dropped the rest.
     */
    pageToken?: string
  }): Promise<{
    tickets: Ticket[]
    /**
     * Present only when more pages exist. The enhanced Jira search endpoint
     * returns no total (R2), so a count of what was fetched is the only count
     * available — and the UI must never imply a server-side total.
     */
    nextPageToken: string | null
  }>

  /**
   * Issue history, fetched separately.
   *
   * Not an optimisation: the enhanced search endpoint does not dependably carry
   * changelogs, and `updated` is the field FR-027 exists to distrust. Staleness
   * and three drift rules rest on this call (R2).
   */
  fetchChangelogs(issueKeys: readonly string[]): Promise<TicketActivity[]>
}

export interface CodeProvider {
  viewer(): Promise<ViewerIdentity>

  fetchRepository(options: { owner: string; repo: string }): Promise<{
    pullRequests: PullRequest[]
    branches: BranchRef[]
    checks: CheckResult[]
  }>

  /**
   * Ahead/behind for tracked branches, against a base ref.
   *
   * Takes a list rather than a single branch because each comparison is its own
   * field selection and must be aliased into one document — one request per
   * branch would spend the hourly budget on comparisons alone (R3).
   */
  compareBranches(options: {
    owner: string
    repo: string
    baseRef: string
    branches: readonly { name: string; headSha: string }[]
  }): Promise<Comparison[]>

  /**
   * Verify a connection is usable.
   *
   * `checks` reports each probe separately, because a token can authenticate
   * and still lack the scope `compare` needs — and that failure is otherwise
   * invisible until ahead/behind is quietly missing everywhere (R3).
   */
  probe(options: { owner: string; repo: string }): Promise<{
    ok: boolean
    viewer: ViewerIdentity | null
    checks: { name: string; ok: boolean; detail: string }[]
  }>
}

export interface LocalGitProvider {
  /**
   * Read local state for a checkout.
   *
   * Everything here is what only local git knows: dirty state, unpushed
   * commits, the worktree list. Ahead/behind is deliberately absent — it comes
   * from the code host, because obtaining it locally would require a fetch, and
   * this application runs no git network operation at all (FR-017, FR-018).
   */
  readWorkspaces(options: { repoPath: string }): Promise<LocalWorkspace[]>
}

/** Rate-limit state, surfaced so the UI can say when a refresh will be retried. */
export interface RateLimitState {
  remaining: number | null
  limit: number | null
  resetAt: string | null
}
