import type { Migration } from '../migrate.js'

/**
 * Migrations for `mirror.db` — the disposable provider cache.
 *
 * Held as TypeScript modules rather than `.sql` files on disk. The design said
 * `.sql`, and that reads better in a diff, but loose assets have to survive
 * `tsc` output, an asar archive, and an `npx` install — and packaging is
 * already the riskiest path in this project (research R8). A migration that
 * cannot be found at runtime fails on a user's machine, which is the exact
 * class of failure worth spending readability to avoid.
 *
 * Every table here is safe to truncate. Nothing in `authored.db` may reference
 * any of it, and no foreign key may cross the file boundary (XIII).
 */
export const MIRROR_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    up: `
      CREATE TABLE connections (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('jira','github')),
        site_or_host    TEXT NOT NULL,
        account_label   TEXT NOT NULL,
        viewer_identity TEXT,
        -- A keychain lookup handle ('service/account'), never the secret.
        -- Asserted by the no-secrets test (XI, SC-011).
        credential_ref  TEXT NOT NULL
      );

      CREATE TABLE freshness (
        -- A *source* id, not strictly a connection id, and deliberately not a
        -- foreign key. Local git is a source with its own freshness (FR-016)
        -- and is not an authenticated connection -- it has no credential, no
        -- host, and no viewer. Forcing it into the connections table would mean
        -- inventing a fake row with a fake kind to satisfy a constraint, which
        -- is a worse lie than the missing cascade. Removing a connection
        -- deletes its freshness rows explicitly instead.
        connection_id   TEXT NOT NULL,
        resource_kind   TEXT NOT NULL,
        last_success_at TEXT,
        last_failure_at TEXT,
        failure_reason  TEXT,
        next_attempt_at TEXT,
        PRIMARY KEY (connection_id, resource_kind)
      );

      CREATE TABLE tickets (
        key                   TEXT PRIMARY KEY,
        connection_id         TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        issue_key             TEXT NOT NULL,
        summary               TEXT NOT NULL,
        assignee              TEXT,
        reporter              TEXT,
        status_name           TEXT NOT NULL,
        status_category       TEXT NOT NULL CHECK (status_category IN ('new','indeterminate','done')),
        is_blocked            INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        -- NULL means unknown, and is rendered as unknown. Never backfilled from
        -- updated_at, which automation moves (FR-027).
        last_real_activity_at TEXT,
        -- Distinct from last_real_activity_at: drift rule D7 asks whether the
        -- ticket actually moved, and a comment is not a transition.
        last_status_change_at TEXT,
        url                   TEXT NOT NULL,
        fetched_at            TEXT NOT NULL
      );
      CREATE INDEX idx_tickets_issue_key ON tickets(issue_key);

      CREATE TABLE ticket_activity (
        ticket_key     TEXT NOT NULL REFERENCES tickets(key) ON DELETE CASCADE,
        at             TEXT NOT NULL,
        author_kind    TEXT NOT NULL CHECK (author_kind IN ('human','bot','automation')),
        field          TEXT NOT NULL,
        -- Decided on ingest and stored, so a staleness value can be traced back
        -- to the rule that produced it long after the fact.
        counts_as_real INTEGER NOT NULL,
        PRIMARY KEY (ticket_key, at, field)
      );
      CREATE INDEX idx_activity_real ON ticket_activity(ticket_key, counts_as_real, at DESC);

      CREATE TABLE pull_requests (
        key                     TEXT PRIMARY KEY,
        connection_id           TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        number                  INTEGER NOT NULL,
        title                   TEXT NOT NULL,
        author                  TEXT,
        head_branch             TEXT NOT NULL,
        -- Checks are keyed by commit SHA; this is how CI attaches to a PR.
        head_sha                TEXT NOT NULL DEFAULT '',
        base_branch             TEXT NOT NULL,
        state                   TEXT NOT NULL CHECK (state IN ('open','merged','closed')),
        is_draft                INTEGER NOT NULL DEFAULT 0,
        review_decision         TEXT,
        requested_reviewers     TEXT NOT NULL DEFAULT '[]',
        unresolved_thread_count INTEGER NOT NULL DEFAULT 0,
        merged_at               TEXT,
        closed_at               TEXT,
        last_real_activity_at   TEXT,
        url                     TEXT NOT NULL,
        fetched_at              TEXT NOT NULL
      );
      CREATE INDEX idx_pulls_head_branch ON pull_requests(head_branch);

      CREATE TABLE check_results (
        key           TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        sha           TEXT NOT NULL,
        name          TEXT NOT NULL,
        state         TEXT NOT NULL CHECK (state IN ('success','failure','pending','cancelled','skipped')),
        is_required   INTEGER NOT NULL DEFAULT 0,
        url           TEXT NOT NULL,
        completed_at  TEXT,
        fetched_at    TEXT NOT NULL
      );
      CREATE INDEX idx_checks_sha ON check_results(sha);

      CREATE TABLE branch_refs (
        key           TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        head_sha      TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        url           TEXT NOT NULL,
        fetched_at    TEXT NOT NULL
      );

      CREATE TABLE comparisons (
        branch_key      TEXT NOT NULL REFERENCES branch_refs(key) ON DELETE CASCADE,
        base_ref        TEXT NOT NULL,
        -- NULL means unknown: the code host has never seen this branch. Never
        -- coerce to 0 -- "no commits ahead" and "no idea" are different answers
        -- and only one is true for an unpushed branch (FR-018).
        ahead_by        INTEGER,
        behind_by       INTEGER,
        -- Skip the next comparison while the head has not moved (rate limit, R3).
        compared_at_sha TEXT NOT NULL,
        fetched_at      TEXT NOT NULL,
        PRIMARY KEY (branch_key, base_ref)
      );

      -- No connection_id: local git is not a provider connection, and reading it
      -- never touches the network (FR-017).
      CREATE TABLE local_workspaces (
        key                     TEXT PRIMARY KEY,
        repo_path               TEXT NOT NULL,
        canonical_remote        TEXT NOT NULL,
        branch                  TEXT NOT NULL,
        worktree_id             TEXT NOT NULL,
        is_primary_worktree     INTEGER NOT NULL DEFAULT 1,
        worktree_present        INTEGER NOT NULL DEFAULT 1,
        has_uncommitted_changes INTEGER NOT NULL DEFAULT 0,
        -- NULL when there is no upstream: the branch has never been pushed.
        unpushed_commit_count   INTEGER,
        head_sha                TEXT NOT NULL,
        upstream_ref            TEXT,
        read_at                 TEXT NOT NULL
      );
      CREATE INDEX idx_workspaces_remote_branch ON local_workspaces(canonical_remote, branch);
    `,
  },
  {
    version: 2,
    name: 'ticket-priority-and-points',
    /**
     * Two columns the ticket lane now shows.
     *
     * Added rather than folded into `init`, even though this file is the
     * disposable store and a rebuild would produce the same schema. An installed
     * copy of 0.1.3 has a `mirror.db` at version 1 on disk, and editing version 1
     * would leave that database at "version 1" describing a schema it does not
     * have — every ticket write would fail on an unknown column, on the one
     * launch where nothing had changed for the user.
     *
     * Both are nullable with no default, and that is the whole point. Rows that
     * predate the migration answer NULL, which the domain type already defines as
     * "not known" for both fields; a `DEFAULT 0` on story points would tell every
     * ticket ever synced that somebody estimated it at zero.
     */
    up: `
      ALTER TABLE tickets ADD COLUMN priority TEXT;
      -- REAL, not INTEGER: Jira's story point fields are numeric and half-point
      -- estimates are ordinary. Rounding them at the storage layer would make
      -- 0.5 and 1 the same ticket.
      ALTER TABLE tickets ADD COLUMN story_points REAL;
    `,
  },
  {
    version: 3,
    name: 'ticket-sprint',
    /**
     * The sprint name, as the ticket lane now shows it.
     *
     * Its own migration for the same reason version 2 was: a copy of 0.2.0 has a
     * `mirror.db` at version 2 on disk, and widening version 2 in place would
     * leave that file claiming a schema it does not have — every ticket write
     * failing on an unknown column, on the one launch where nothing else had
     * changed for the operator.
     *
     * The **name** and not an id, because nothing joins on a sprint. Nullable
     * with no default, because null already means what it needs to mean: a
     * ticket in no sprint, or a site with no sprint field. An empty string
     * default would put a blank where a placeholder belongs and read as a sprint
     * whose name nobody typed.
     */
    up: `
      ALTER TABLE tickets ADD COLUMN sprint TEXT;
    `,
  },
  {
    version: 4,
    name: 'remove-code-host-and-local-git',
    // `tickets.connection_id` is ON DELETE CASCADE, so dropping `connections`
    // during the rebuild would take every ticket with it -- silently, on the
    // upgrade launch, leaving an empty lane above a freshness reading that still
    // said "refreshed four minutes ago". See the flag's docstring.
    rebuildsReferencedTable: true,
    /**
     * Two providers leave the mirror.
     *
     * This file is the disposable store, so this could be a file deletion. It is
     * written as a migration anyway: an installed 0.3.0 has a `mirror.db` on
     * disk, and a rebuild-on-launch would be a silent full resync at the worst
     * moment -- the launch where nothing else changed for the operator, on a
     * connection whose token may since have expired.
     *
     * **Order is load-bearing**, and one step happens outside this SQL entirely.
     *
     * `openMirror` reads the credential references of every connection of a
     * removed kind *before* calling `migrate`, and hands them back so the caller
     * can delete each secret from the OS keychain (FR-112). It has to happen
     * first because after step 1 below there is nothing left to read them from,
     * and it has to happen outside because a migration that reached into the
     * keychain would be doing something this transaction cannot roll back.
     *
     * A secret left behind would be unreachable, unremovable through the
     * interface, and still a secret.
     */
    up: `
      -- 1. The rows themselves. Tickets cascade from this, which is correct:
      --    a ticket belonging to a connection that is gone has no owner. There
      --    are none, because no code host ever wrote a ticket.
      DELETE FROM connections WHERE kind <> 'jira';

      -- 2. Rebuild with the narrowed CHECK. SQLite cannot alter a constraint in
      --    place, so this is the standard twelve-step dance in the four steps it
      --    actually needs here: no index, no trigger and no view names this
      --    table, and the foreign keys pointing *at* it are re-resolved by name
      --    on rename because legacy_alter_table is off by default.
      CREATE TABLE connections_new (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL CHECK (kind IN ('jira')),
        site_or_host    TEXT NOT NULL,
        account_label   TEXT NOT NULL,
        viewer_identity TEXT,
        credential_ref  TEXT NOT NULL
      );
      INSERT INTO connections_new
        SELECT id, kind, site_or_host, account_label, viewer_identity, credential_ref
        FROM connections;
      DROP TABLE connections;
      ALTER TABLE connections_new RENAME TO connections;

      -- 3. The five tables. Their indexes go with them, and comparisons
      --    references branch_refs, so it goes first.
      DROP TABLE IF EXISTS comparisons;
      DROP TABLE IF EXISTS branch_refs;
      DROP TABLE IF EXISTS check_results;
      DROP TABLE IF EXISTS pull_requests;
      DROP TABLE IF EXISTS local_workspaces;

      -- 4. Freshness rows for the retired kinds, including the reserved 'local'
      --    source id. Left behind, the header would go on reporting the age of
      --    resources that no longer exist (FR-111) -- and 'never synced' against
      --    a lane nobody can see is the most confusing possible reading.
      DELETE FROM freshness WHERE resource_kind <> 'tickets';
    `,
  },
]
