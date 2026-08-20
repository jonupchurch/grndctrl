import type { Database } from 'better-sqlite3'
import type { DocNode } from '../../domain/adf.js'
import type { NaturalKey, SubjectKind } from '../../domain/keys.js'
import { subjectKindOf } from '../../domain/keys.js'
import type {
  Connection,
  FailureReason,
  FreshnessRecord,
  ResourceKind,
  Ticket,
  ViewerIdentity,
} from '../../domain/types.js'

/**
 * Reading and writing the disposable mirror.
 *
 * Every write is an upsert keyed on the natural key, so a resync converges
 * rather than duplicating — and a partial sync leaves the rows it did not reach
 * untouched instead of deleting them. That is what lets one connection fail
 * without emptying the lane (XV).
 *
 * **Five entities left this file**: pull requests, check results, branch refs,
 * comparisons and local workspaces. `replaceScoped` stays, with one caller.
 * Its scoping — delete by connection, then insert — is the thing to keep hold
 * of: it is what stopped one project's sync deleting another's rows on a shared
 * connection, and 007 adds a second ticket query on the same connection, whose
 * results have to go in through **one** call or the second discards the first.
 */

export interface MirrorRepository {
  upsertConnection(connection: Connection): void
  listConnections(): Connection[]
  /** `true` if a row was removed. Mirrored rows for it are left to the next sync. */
  deleteConnection(connectionId: string): boolean

  replaceTickets(connectionId: string, tickets: readonly Ticket[]): void
  listTickets(): Ticket[]

  /**
   * Does the mirror currently hold this subject?
   *
   * A primary-key lookup, routed by the key's prefix. Exists so the notes
   * service can answer "is this note orphaned?" without reading whole tables —
   * and without `authored.db` ever holding a handle to this one (XIII).
   */
  hasSubject(key: NaturalKey | string): boolean

  /**
   * The ticket's own summary, if the mirror currently holds it.
   *
   * A primary-key read of one column, for the one caller that needs to *keep* a
   * copy: the ticket history snapshots this at write time so an entry still has
   * a label after the ticket closes and leaves the mirror (008/FR-149). Null
   * means "not held", which the history reads as "keep the snapshot you have"
   * rather than "clear it".
   */
  ticketSummary(key: NaturalKey | string): string | null

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
      'sprint',
      'description',
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
      t.sprint,
      // `null` and `'[]'` are different rows on purpose: no description at all,
      // versus one that is empty. See the migration.
      t.description === null ? null : JSON.stringify(t.description),
      t.createdAt,
      t.updatedAt,
      t.lastRealActivityAt,
      t.lastStatusChangeAt,
      t.url,
      t.fetchedAt,
    ],
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
      return (
        db.prepare('SELECT * FROM connections ORDER BY id').all() as Record<string, unknown>[]
      ).map((r) => ({
        id: String(r['id']),
        kind: r['kind'] as Connection['kind'],
        siteOrHost: String(r['site_or_host']),
        accountLabel: String(r['account_label']),
        viewerIdentity: json<ViewerIdentity | null>(r['viewer_identity'], null),
        credentialRef: String(r['credential_ref']),
      }))
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
      return (
        db.prepare('SELECT * FROM tickets ORDER BY key').all() as Record<string, unknown>[]
      ).map((r) => ({
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
        sprint: nullableString(r['sprint']),
        // A row written before migration 5, or a ticket with no description at
        // all, reads as `null`. A malformed one also reads as `null` rather than
        // throwing: this is a cache, and a description that cannot be parsed
        // must not be able to take the ticket lane down with it.
        description: json<DocNode[] | null>(r['description'], null),
        createdAt: String(r['created_at']),
        updatedAt: String(r['updated_at']),
        lastRealActivityAt: nullableString(r['last_real_activity_at']),
        lastStatusChangeAt: nullableString(r['last_status_change_at']),
        url: String(r['url']),
        fetchedAt: String(r['fetched_at']),
      }))
    },

    hasSubject(key) {
      const kind = subjectKindOf(key)
      if (kind === null) return false

      const table = SUBJECT_TABLES[kind]
      if (table === undefined) return false

      return db.prepare(`SELECT 1 FROM ${table} WHERE key = ? LIMIT 1`).get(key) !== undefined
    },

    ticketSummary(key) {
      const row = db.prepare('SELECT summary FROM tickets WHERE key = ?').get(key) as
        { summary: string } | undefined
      return row === undefined ? null : String(row.summary)
    },

    hasEverSynced(kind) {
      // Has any connection ever succeeded for this kind? With two Jira sites and
      // one never synced, the lane has real data and the question is answerable
      // — which is the reason this is asked per kind rather than per row.
      const row = db
        .prepare(
          'SELECT 1 FROM freshness WHERE resource_kind = ? AND last_success_at IS NOT NULL LIMIT 1',
        )
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
 * `session` is absent because sessions live in `authored.db`, which this file
 * cannot see. Four more kinds are absent now — pull request, branch, workspace,
 * check — because their tables are dropped by migration 4.
 *
 * `subjectKindOf` still *parses* all of them, deliberately (T040): a note
 * written before 006 carries such a key and has to stay readable. What changes
 * here is that this map cannot answer for one, so `hasSubject` returns false and
 * the presence resolver reports `unknown` rather than `absent`. That is the
 * right answer: the note's subject may well still exist at the code host, and
 * this application is simply no longer in a position to say.
 */
const SUBJECT_TABLES: Partial<Record<SubjectKind, string>> = {
  ticket: 'tickets',
}

function nullableString(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v)
}

function nullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v)
}
