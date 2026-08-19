import type { Ticket, TicketActivity, ViewerIdentity } from '../domain/types.js'

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
 *
 * **There were three seams and there is one.** `CodeProvider` and
 * `LocalGitProvider` are gone with their implementations. The read-only rule is
 * unaffected: it was never about how many providers there were, and the one that
 * remains still has no write method for the same reason.
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
   * changelogs, and `updated` is the field FR-027 exists to distrust. The whole
   * staleness display rests on this call (R2).
   */
  fetchChangelogs(issueKeys: readonly string[]): Promise<TicketActivity[]>
}

/** Rate-limit state, surfaced so the UI can say when a refresh will be retried. */
export interface RateLimitState {
  remaining: number | null
  limit: number | null
  resetAt: string | null
}
