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
]
