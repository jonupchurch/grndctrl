import type { Database } from 'better-sqlite3'
import type { NaturalKey, SubjectKind } from '../../domain/keys.js'
import { subjectKindOf } from '../../domain/keys.js'
import type {
  BranchRef,
  CheckResult,
  Comparison,
  Connection,
  FailureReason,
  FreshnessRecord,
  LocalWorkspace,
  PullRequest,
  ResourceKind,
  Ticket,
  ViewerIdentity,
} from '../../domain/types.js'

/**
 * Reading and writing the disposable mirror.
 *
 * Every write is an upsert keyed on the natural key, so a resync converges
 * rather than duplicating — and a partial sync leaves the rows it did not reach
 * untouched instead of deleting them. That is what lets one provider fail
 * without emptying its lane (XV).
 */

export interface MirrorRepository {
  upsertConnection(connection: Connection): void
  listConnections(): Connection[]
  /** `true` if a row was removed. Mirrored rows for it are left to the next sync. */
  deleteConnection(connectionId: string): boolean

  replaceTickets(connectionId: string, tickets: readonly Ticket[]): void
  listTickets(): Ticket[]

  replacePullRequests(connectionId: string, pullRequests: readonly PullRequest[]): void
  listPullRequests(): PullRequest[]

  replaceChecks(connectionId: string, checks: readonly CheckResult[]): void
  listChecks(): CheckResult[]

  replaceBranches(connectionId: string, branches: readonly BranchRef[]): void
  listBranches(): BranchRef[]

  upsertComparisons(comparisons: readonly Comparison[]): void
  listComparisons(): Comparison[]

  replaceWorkspaces(workspaces: readonly LocalWorkspace[]): void
  listWorkspaces(): LocalWorkspace[]

  /**
   * Does the mirror currently hold this subject?
   *
   * A primary-key lookup, routed by the key's prefix. Exists so the notes
   * service can answer "is this note orphaned?" without reading whole tables —
   * and without `authored.db` ever holding a handle to this one (XIII).
   */
  hasSubject(key: NaturalKey | string): boolean

  /**
   * Has this resource kind ever synced successfully on any connection?
   *
   * The difference between "the ticket is gone" and "we have never fetched a
   * ticket". Before the first sync every table is empty, and without this an
   * empty mirror would report every note in the product as orphaned.
   */
  hasEverSynced(kind: ResourceKind): boolean

  recordSuccess(connectionId: string, kind: ResourceKind, at: string): void
  recordFailure(
    connectionId: string,
    kind: ResourceKind,
    at: string,
    reason: FailureReason,
    nextAttemptAt: string | null,
  ): void
  listFreshness(): FreshnessRecord[]
}

export function mirrorRepository(db: Database): MirrorRepository {
  const json = <T>(raw: unknown, fallback: T): T => {
    if (typeof raw !== 'string' || raw === '') return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  /**
   * Replace one connection's rows for a resource kind, transactionally.
   *
   * Scoped to the connection so one provider's sync cannot delete another's
   * data, and wrapped in a transaction so a failure mid-write leaves the
   * previous contents intact rather than an empty lane (XV).
   */
  const replaceScoped = <T>(
    table: string,
    columns: readonly string[],
    toRow: (item: T) => unknown[],
  ) => {
    const placeholders = columns.map(() => '?').join(', ')
    const insert = db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(${columns[0]}) DO UPDATE SET ${columns
         .slice(1)
         .map((c) => `${c} = excluded.${c}`)
         .join(', ')}`,
    )
    const deleteScope = db.prepare(`DELETE FROM ${table} WHERE connection_id = ?`)

    return db.transaction((connectionId: string, items: readonly T[]) => {
      deleteScope.run(connectionId)
      for (const item of items) insert.run(...(toRow(item) as never[]))
    })
  }

  const replaceTicketsTx = replaceScoped<Ticket>(
    'tickets',
    [
      'key',
      'connection_id',
      'issue_key',
      'summary',
      'assignee',
      'reporter',
      'status_name',
      'status_category',
      'is_blocked',
      'priority',
      'story_points',
      'created_at',
      'updated_at',
      'last_real_activity_at',
      'last_status_change_at',
      'url',
      'fetched_at',
    ],
    (t) => [
      t.key,
      t.connectionId,
      t.issueKey,
      t.summary,
      JSON.stringify(t.assignee),
      JSON.stringify(t.reporter),
      t.statusName,
      t.statusCategory,
      t.isBlocked ? 1 : 0,
      t.priority,
      t.storyPoints,
      t.createdAt,
      t.updatedAt,
      t.lastRealActivityAt,
      t.lastStatusChangeAt,
      t.url,
      t.fetchedAt,
    ],
  )

  const replacePullsTx = replaceScoped<PullRequest>(
    'pull_requests',
    [
      'key',
      'connection_id',
      'number',
      'title',
      'author',
      'head_branch',
      'head_sha',
      'base_branch',
      'state',
      'is_draft',
      'review_decision',
      'requested_reviewers',
      'unresolved_thread_count',
      'merged_at',
      'closed_at',
      'last_real_activity_at',
      'url',
      'fetched_at',
    ],
    (p) => [
      p.key,
      p.connectionId,
      p.number,
      p.title,
      JSON.stringify(p.author),
      p.headBranch,
      p.headSha,
      p.baseBranch,
      p.state,
      p.isDraft ? 1 : 0,
      p.reviewDecision,
      JSON.stringify(p.requestedReviewers),
      p.unresolvedThreadCount,
      p.mergedAt,
      p.closedAt,
      p.lastRealActivityAt,
      p.url,
      p.fetchedAt,
    ],
  )

  const replaceChecksTx = replaceScoped<CheckResult>(
    'check_results',
    ['key', 'connection_id', 'sha', 'name', 'state', 'is_required', 'url', 'completed_at', 'fetched_at'],
    (c) => [c.key, c.connectionId, c.sha, c.name, c.state, c.isRequired ? 1 : 0, c.url, c.completedAt, c.fetchedAt],
  )

  const replaceBranchesTx = replaceScoped<BranchRef>(
    'branch_refs',
    ['key', 'connection_id', 'name', 'head_sha', 'updated_at', 'url', 'fetched_at'],
    (b) => [b.key, b.connectionId, b.name, b.headSha, b.updatedAt, b.url, b.fetchedAt],
  )

  return {
    upsertConnection(connection) {
      db.prepare(
        `INSERT INTO connections (id, kind, site_or_host, account_label, viewer_identity, credential_ref)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, site_or_host = excluded.site_or_host,
           account_label = excluded.account_label, viewer_identity = excluded.viewer_identity,
           credential_ref = excluded.credential_ref`,
      ).run(
        connection.id,
        connection.kind,
        connection.siteOrHost,
        connection.accountLabel,
        JSON.stringify(connection.viewerIdentity),
        connection.credentialRef,
      )
    },

    listConnections() {
      return (db.prepare('SELECT * FROM connections ORDER BY id').all() as Record<string, unknown>[]).map(
        (r) => ({
          id: String(r['id']),
          kind: r['kind'] as Connection['kind'],
          siteOrHost: String(r['site_or_host']),
          accountLabel: String(r['account_label']),
          viewerIdentity: json<ViewerIdentity | null>(r['viewer_identity'], null),
          credentialRef: String(r['credential_ref']),
        }),
      )
    },

    deleteConnection(connectionId) {
      // The mirrored rows this connection produced are deliberately left alone.
      // They are already stale and the board says so through freshness; deleting
      // them here would blank lanes the operator may still want to read while
      // they re-authorize, which is the failure XV exists to prevent.
      const result = db.prepare('DELETE FROM connections WHERE id = ?').run(connectionId)
      return result.changes > 0
    },

    replaceTickets: (connectionId, tickets) => void replaceTicketsTx(connectionId, tickets),

    listTickets() {
      return (db.prepare('SELECT * FROM tickets ORDER BY key').all() as Record<string, unknown>[]).map((r) => ({
        key: r['key'] as NaturalKey,
        connectionId: String(r['connection_id']),
        issueKey: String(r['issue_key']),
        summary: String(r['summary']),
        assignee: json<ViewerIdentity | null>(r['assignee'], null),
        reporter: json<ViewerIdentity | null>(r['reporter'], null),
        statusName: String(r['status_name']),
        statusCategory: r['status_category'] as Ticket['statusCategory'],
        isBlocked: r['is_blocked'] === 1,
        priority: nullableString(r['priority']),
        // Not `Number(...) || null` -- that reads a genuine 0-point estimate as
        // "unestimated" and puts a dash where the tracker says zero.
        storyPoints: nullableNumber(r['story_points']),
        createdAt: String(r['created_at']),
        updatedAt: String(r['updated_at']),
        lastRealActivityAt: nullableString(r['last_real_activity_at']),
        lastStatusChangeAt: nullableString(r['last_status_change_at']),
        url: String(r['url']),
        fetchedAt: String(r['fetched_at']),
      }))
    },

    replacePullRequests: (connectionId, pulls) => void replacePullsTx(connectionId, pulls),

    listPullRequests() {
      return (db.prepare('SELECT * FROM pull_requests ORDER BY key').all() as Record<string, unknown>[]).map(
        (r) => ({
          key: r['key'] as NaturalKey,
          connectionId: String(r['connection_id']),
          number: Number(r['number']),
          title: String(r['title']),
          author: json<ViewerIdentity | null>(r['author'], null),
          headBranch: String(r['head_branch']),
          headSha: String(r['head_sha']),
          baseBranch: String(r['base_branch']),
          state: r['state'] as PullRequest['state'],
          isDraft: r['is_draft'] === 1,
          reviewDecision: (nullableString(r['review_decision']) ?? null) as PullRequest['reviewDecision'],
          requestedReviewers: json<ViewerIdentity[]>(r['requested_reviewers'], []),
          unresolvedThreadCount: Number(r['unresolved_thread_count']),
          mergedAt: nullableString(r['merged_at']),
          closedAt: nullableString(r['closed_at']),
          lastRealActivityAt: nullableString(r['last_real_activity_at']),
          url: String(r['url']),
          fetchedAt: String(r['fetched_at']),
        }),
      )
    },

    replaceChecks: (connectionId, checks) => void replaceChecksTx(connectionId, checks),

    listChecks() {
      return (db.prepare('SELECT * FROM check_results ORDER BY key').all() as Record<string, unknown>[]).map(
        (r) => ({
          key: r['key'] as NaturalKey,
          connectionId: String(r['connection_id']),
          sha: String(r['sha']),
          name: String(r['name']),
          state: r['state'] as CheckResult['state'],
          isRequired: r['is_required'] === 1,
          url: String(r['url']),
          completedAt: nullableString(r['completed_at']),
          fetchedAt: String(r['fetched_at']),
        }),
      )
    },

    replaceBranches: (connectionId, branches) => void replaceBranchesTx(connectionId, branches),

    listBranches() {
      return (db.prepare('SELECT * FROM branch_refs ORDER BY key').all() as Record<string, unknown>[]).map(
        (r) => ({
          key: r['key'] as NaturalKey,
          connectionId: String(r['connection_id']),
          name: String(r['name']),
          headSha: String(r['head_sha']),
          updatedAt: String(r['updated_at']),
          url: String(r['url']),
          fetchedAt: String(r['fetched_at']),
        }),
      )
    },

    upsertComparisons(comparisons) {
      const stmt = db.prepare(
        `INSERT INTO comparisons (branch_key, base_ref, ahead_by, behind_by, compared_at_sha, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(branch_key, base_ref) DO UPDATE SET
           ahead_by = excluded.ahead_by, behind_by = excluded.behind_by,
           compared_at_sha = excluded.compared_at_sha, fetched_at = excluded.fetched_at`,
      )
      db.transaction(() => {
        for (const c of comparisons) {
          stmt.run(c.branchKey, c.baseRef, c.aheadBy, c.behindBy, c.comparedAtSha, c.fetchedAt)
        }
      })()
    },

    listComparisons() {
      return (db.prepare('SELECT * FROM comparisons ORDER BY branch_key').all() as Record<string, unknown>[]).map(
        (r) => ({
          branchKey: r['branch_key'] as NaturalKey,
          baseRef: String(r['base_ref']),
          // Preserved as null rather than coerced. `?? 0` here would quietly
          // turn "never pushed" into "nothing to push" (FR-018).
          aheadBy: nullableNumber(r['ahead_by']),
          behindBy: nullableNumber(r['behind_by']),
          comparedAtSha: String(r['compared_at_sha']),
          fetchedAt: String(r['fetched_at']),
        }),
      )
    },

    replaceWorkspaces(workspaces) {
      const insert = db.prepare(
        `INSERT INTO local_workspaces
           (key, repo_path, canonical_remote, branch, worktree_id, is_primary_worktree,
            worktree_present, has_uncommitted_changes, unpushed_commit_count, head_sha,
            upstream_ref, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      db.transaction(() => {
        db.prepare('DELETE FROM local_workspaces').run()
        for (const w of workspaces) {
          insert.run(
            w.key,
            w.repoPath,
            w.canonicalRemote,
            w.branch,
            w.worktreeId,
            w.isPrimaryWorktree ? 1 : 0,
            w.worktreePresent ? 1 : 0,
            w.hasUncommittedChanges ? 1 : 0,
            w.unpushedCommitCount,
            w.headSha,
            w.upstreamRef,
            w.readAt,
          )
        }
      })()
    },

    listWorkspaces() {
      return (db.prepare('SELECT * FROM local_workspaces ORDER BY key').all() as Record<string, unknown>[]).map(
        (r) => ({
          key: r['key'] as NaturalKey,
          repoPath: String(r['repo_path']),
          canonicalRemote: String(r['canonical_remote']),
          branch: String(r['branch']),
          worktreeId: String(r['worktree_id']),
          isPrimaryWorktree: r['is_primary_worktree'] === 1,
          worktreePresent: r['worktree_present'] === 1,
          hasUncommittedChanges: r['has_uncommitted_changes'] === 1,
          unpushedCommitCount: nullableNumber(r['unpushed_commit_count']),
          headSha: String(r['head_sha']),
          upstreamRef: nullableString(r['upstream_ref']),
          readAt: String(r['read_at']),
        }),
      )
    },

    hasSubject(key) {
      const kind = subjectKindOf(key)
      if (kind === null) return false

      const table = SUBJECT_TABLES[kind]
      if (table === undefined) return false

      return db.prepare(`SELECT 1 FROM ${table} WHERE key = ? LIMIT 1`).get(key) !== undefined
    },

    hasEverSynced(kind) {
      // Local git has no connection row — it is not an authenticated provider —
      // so its freshness is recorded under a reserved id. Either way the
      // question is the same: has any connection ever succeeded for this kind?
      const row = db
        .prepare('SELECT 1 FROM freshness WHERE resource_kind = ? AND last_success_at IS NOT NULL LIMIT 1')
        .get(kind)
      return row !== undefined
    },

    recordSuccess(connectionId, kind, at) {
      db.prepare(
        `INSERT INTO freshness (connection_id, resource_kind, last_success_at)
         VALUES (?, ?, ?)
         ON CONFLICT(connection_id, resource_kind) DO UPDATE SET
           last_success_at = excluded.last_success_at,
           -- The failure is not cleared. A lane that recovered an hour ago and
           -- failed twice before that is a different situation from one that
           -- has never failed, and the history is what a user needs to judge
           -- whether to trust the number.
           next_attempt_at = NULL`,
      ).run(connectionId, kind, at)
    },

    recordFailure(connectionId, kind, at, reason, nextAttemptAt) {
      db.prepare(
        `INSERT INTO freshness (connection_id, resource_kind, last_failure_at, failure_reason, next_attempt_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(connection_id, resource_kind) DO UPDATE SET
           last_failure_at = excluded.last_failure_at,
           failure_reason = excluded.failure_reason,
           next_attempt_at = excluded.next_attempt_at`,
      ).run(connectionId, kind, at, reason, nextAttemptAt)
    },

    listFreshness() {
      return (
        db.prepare('SELECT * FROM freshness ORDER BY connection_id, resource_kind').all() as Record<
          string,
          unknown
        >[]
      ).map((r) => ({
        connectionId: String(r['connection_id']),
        resourceKind: r['resource_kind'] as ResourceKind,
        lastSuccessAt: nullableString(r['last_success_at']),
        lastFailureAt: nullableString(r['last_failure_at']),
        failureReason: (nullableString(r['failure_reason']) ?? null) as FailureReason | null,
        nextAttemptAt: nullableString(r['next_attempt_at']),
      }))
    },
  }
}

/**
 * Which table holds each kind of subject.
 *
 * The table name is interpolated into SQL, so it may only ever come from this
 * map — `subjectKindOf` returns a closed enum, and the caller refuses anything
 * it does not recognise before reaching here. No caller-supplied string ever
 * reaches the query text.
 *
 * `repository` is absent because the mirror has no repository table (a
 * repository is implied by its branches), and `session` because sessions live
 * in `authored.db`, which this file cannot see.
 */
const SUBJECT_TABLES: Partial<Record<SubjectKind, string>> = {
  ticket: 'tickets',
  'pull-request': 'pull_requests',
  branch: 'branch_refs',
  workspace: 'local_workspaces',
  check: 'check_results',
}

function nullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function nullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}
