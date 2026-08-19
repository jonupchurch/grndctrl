import type { Migration } from '../migrate.js'

/**
 * Migrations for `authored.db` — the user's own data.
 *
 * The rule that governs this file: **no migration here may lose a row.** There
 * is no server-side copy to restore from (constitution XI), so a data-losing
 * migration is unrecoverable, not merely embarrassing. Every migration added
 * here gets a case in the migration-safety harness that seeds the prior schema,
 * migrates, and asserts every row survives with its content intact.
 *
 * Note what is *not* here: no foreign key to anything in `mirror.db`. Provider
 * entities are referenced by natural key only, which is exactly why deleting the
 * mirror cannot cascade into a user's notes (XIII).
 */
export const AUTHORED_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    up: `
      CREATE TABLE projects (
        id                 TEXT PRIMARY KEY,
        code               TEXT NOT NULL UNIQUE,
        name               TEXT NOT NULL,
        color_index        INTEGER,
        -- These name connections that live in mirror.db. Deliberately not
        -- foreign keys: a connection row is disposable, a project is not.
        jira_connection_id   TEXT,
        jira_project_key     TEXT,
        github_connection_id TEXT,
        repo_owner           TEXT,
        repo_name            TEXT,
        -- Stored and linked only. Never fetched, never authenticated (FR-004).
        documentation_url    TEXT,
        ticket_key_pattern   TEXT NOT NULL,
        checkout_paths       TEXT NOT NULL DEFAULT '[]',
        status_overrides     TEXT NOT NULL DEFAULT '{}',
        CHECK (jira_project_key IS NOT NULL OR repo_name IS NOT NULL)
      );

      CREATE TABLE notes (
        id          TEXT PRIMARY KEY,
        -- A natural key. Survives the mirror being rebuilt, and re-attaches on
        -- its own if the subject reappears (FR-050, FR-056).
        subject_key TEXT NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('decision','gotcha','question-for-human','todo')),
        body        TEXT NOT NULL,
        -- Stamped from the transport, never from the payload: an agent cannot
        -- post as the user.
        author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
        author_id   TEXT,
        -- Optimistic concurrency. A stale write is rejected, never merged (FR-055).
        revision    INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX idx_notes_subject ON notes(subject_key);
      CREATE INDEX idx_notes_questions ON notes(type, resolved_at);

      CREATE TABLE agent_sessions (
        key                    TEXT PRIMARY KEY,
        agent_id               TEXT NOT NULL,
        session_id             TEXT NOT NULL,
        project_id             TEXT REFERENCES projects(id) ON DELETE SET NULL,
        work_item_key          TEXT,
        workspace_key          TEXT,
        reported_status        TEXT,
        started_at             TEXT NOT NULL,
        last_heartbeat_at      TEXT NOT NULL,
        -- A heartbeat does not advance this. A process that is alive but stuck
        -- is exactly the case the operator needs to see.
        last_real_activity_at  TEXT,
        ended_at               TEXT,
        outcome                TEXT CHECK (outcome IS NULL OR outcome IN ('done','failed')),
        heartbeat_interval_sec INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_project ON agent_sessions(project_id, ended_at);

      CREATE TABLE outbox_actions (
        id                    TEXT PRIMARY KEY,
        subject_key           TEXT NOT NULL,
        kind                  TEXT NOT NULL,
        payload               TEXT NOT NULL DEFAULT '{}',
        motivating_finding_id TEXT,
        state                 TEXT NOT NULL
                              CHECK (state IN ('pending','claimed','complete','failed','expired','cancelled')),
        -- NOT NULL at insert: an action cannot exist unconfirmed. This column is
        -- the schema-level half of "Ground Control never holds write authority"
        -- (FR-059, constitution XVI).
        confirmed_at          TEXT NOT NULL,
        confirmed_via         TEXT NOT NULL,
        claimed_by            TEXT,
        claimed_at            TEXT,
        claim_expires_at      TEXT,
        result                TEXT,
        failure_reason        TEXT,
        completed_at          TEXT,
        -- Append-only. Every state change is recorded, including expiries, so a
        -- dispatched write always has an audit trail.
        history               TEXT NOT NULL DEFAULT '[]',
        CHECK (state <> 'claimed' OR claimed_by IS NOT NULL)
      );
      CREATE INDEX idx_outbox_state ON outbox_actions(state, confirmed_at);

      CREATE TABLE finding_dismissals (
        finding_id    TEXT PRIMARY KEY,
        dismissed_at  TEXT NOT NULL,
        -- Of the evidence tuple, so the dismissal expires when the evidence
        -- changes rather than when a sync merely runs (FR-038).
        evidence_hash TEXT NOT NULL
      );

      CREATE TABLE settings (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'remove-code-host-and-local-git',
    // `agent_sessions.project_id` is ON DELETE SET NULL, so dropping `projects`
    // during the rebuild would unlink every session from its project. That is
    // authored data, and losing it would not even show as a missing row -- the
    // sessions would still be there, belonging to nothing.
    rebuildsReferencedTable: true,
    /**
     * The one migration in this change that can lose the operator's data.
     *
     * Three tables move and three are **not opened**. That distinction is the
     * whole design: `notes`, `outbox_actions` and `finding_dismissals` hold
     * natural keys, action kinds and rule identifiers that no longer resolve to
     * anything, and that is the correct state (FR-109, FR-117, FR-122). They are
     * not "migrated with no changes" -- no statement below names them.
     *
     * ## `projects`, and the CHECK that is deliberately not replaced
     *
     * SQLite cannot drop a column named in a table constraint, and the v1 CHECK
     * is `jira_project_key IS NOT NULL OR repo_name IS NOT NULL`. So `projects`
     * needs a full rebuild whatever else happens.
     *
     * The obvious rebuild adds `CHECK (jira_project_key IS NOT NULL)` -- the
     * surviving half of the disjunction. **That would delete the operator's
     * data.** A database written by 0.3.0 can hold a repository-only project:
     * legal then, refused by the new constraint, and the tidy way to make an
     * INSERT ... SELECT satisfy a constraint is to filter out the row that
     * violates it. There is no server-side copy of a project binding (XI).
     *
     * So the new table has **no** replacement CHECK, every row is copied, and
     * the rule lives in `projects.upsert` instead -- where the operator is
     * standing to be told why, in a sentence naming the field, rather than
     * meeting SQLite's own wording after the fact.
     *
     * ## `agent_sessions`
     *
     * A plain column drop. No constraint, index or trigger names
     * `workspace_key`, so nothing has to be rebuilt around it.
     *
     * ## `settings`
     *
     * A JSON payload in one row, reshaped in `after` because this is not a
     * schema change and SQL cannot express it readably. It carries
     * `laneThresholdHours.pulls` across to `sessions`, which is a **carry-over
     * and not a rename**: the number meant "how long is too long for a pull
     * request to sit" and now means the same thing about an agent session. The
     * value is kept so an operator who tuned it does not silently lose the
     * tuning; the name changes because the two describe different things.
     */
    up: `
      -- The 12-step rebuild, in the steps this table actually needs. No index,
      -- trigger or view names projects; the foreign key in agent_sessions points
      -- at it and is re-resolved by name on rename.
      CREATE TABLE projects_new (
        id                 TEXT PRIMARY KEY,
        code               TEXT NOT NULL UNIQUE,
        name               TEXT NOT NULL,
        color_index        INTEGER,
        jira_connection_id TEXT,
        jira_project_key   TEXT,
        documentation_url  TEXT,
        status_overrides   TEXT NOT NULL DEFAULT '{}'
      );

      -- Every row. No WHERE clause, and its absence is the point: a project with
      -- no jira_project_key is the operator's row and comes across untouched.
      INSERT INTO projects_new (id, code, name, color_index, jira_connection_id,
                                jira_project_key, documentation_url, status_overrides)
        SELECT id, code, name, color_index, jira_connection_id,
               jira_project_key, documentation_url, status_overrides
        FROM projects;

      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;

      ALTER TABLE agent_sessions DROP COLUMN workspace_key;
    `,
    after: (db) => {
      const row = db.prepare('SELECT payload FROM settings WHERE id = 1').get() as
        | { payload: string }
        | undefined

      // No settings row is the ordinary case for a database that has never been
      // written to. There is nothing to reshape and nothing to default: the
      // store already falls back to DEFAULT_SETTINGS when the row is absent.
      if (row === undefined) return

      let payload: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(row.payload)
        if (typeof parsed !== 'object' || parsed === null) return
        payload = parsed as Record<string, unknown>
      } catch {
        // An unparseable payload is already handled downstream by falling back
        // to defaults. Rewriting it here would replace one unknown with another.
        return
      }

      const poll = asRecord(payload['pollIntervalSec'])
      const lanes = asRecord(payload['laneThresholdHours'])

      /*
       * Idempotent (FR-113). Running this twice must be a no-op, because a
       * migration that is only correct once is a migration that corrupts a
       * database somebody restored from a backup.
       *
       * `??` throughout rather than a shape check: a payload already in the new
       * shape has no `pulls` to carry, so `sessions` keeps the value it has.
       */
      const reshaped: Record<string, unknown> = {
        ...payload,
        pollIntervalSec: { jira: numberOr(poll?.['jira'], 300) },
        laneThresholdHours: {
          tickets: numberOr(lanes?.['tickets'], 72),
          sessions: numberOr(lanes?.['sessions'] ?? lanes?.['pulls'], 24),
        },
      }

      // `driftGraceHours` goes with the rules that read it. Deleted rather than
      // left in place: it is a *setting*, and a stored preference nothing reads
      // is one the interface would eventually offer again by accident.
      delete reshaped['driftGraceHours']

      db.prepare('UPDATE settings SET payload = ? WHERE id = 1').run(JSON.stringify(reshaped))
    },
  },
]

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
