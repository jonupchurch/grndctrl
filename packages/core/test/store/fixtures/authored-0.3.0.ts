import type { Database } from 'better-sqlite3'

/**
 * An `authored.db` as 0.3.0 wrote it — every row shape that 006 must carry
 * across the narrowing, populated before the migration that narrows it exists.
 *
 * **Why this file is written first.** 006 removes four columns from `projects`,
 * one from `agent_sessions`, and reshapes the settings payload. There is no
 * server-side copy of any of it (constitution XI), so a migration that drops a
 * row is unrecoverable. A fixture written *after* the migration is a fixture
 * shaped by it: it contains the cases the migration already handles, which is
 * exactly the set that proves nothing. So the shapes are enumerated here, from
 * the 0.3.0 schema, ahead of the code that has to survive them.
 *
 * The three project shapes are the point of the exercise. `repo-only` is the
 * row that the obvious migration deletes — it has no `jira_project_key`, so the
 * natural replacement CHECK (`jira_project_key IS NOT NULL`) refuses it, and
 * the tidy way to satisfy the constraint is to drop the row. It must survive.
 */

/** Every id this fixture inserts, so a test can assert by name rather than by count. */
export const AUTHORED_FIXTURE = {
  projects: ['proj-both', 'proj-jira-only', 'proj-repo-only'],
  notes: ['note-ticket', 'note-pull', 'note-branch', 'note-workspace', 'note-session'],
  sessions: ['agent-a:sess-1', 'agent-b:sess-2'],
  actions: ['act-pending', 'act-claimed', 'act-complete', 'act-failed'],
  dismissals: [
    'drift:D1:jira:acme.atlassian.net/ENG-1',
    'drift:D3:gh:acme/web#42',
    'drift:D5:local:C%3A%5Cwork%5Cweb',
    'drift:D8:jira:acme.atlassian.net/ENG-9',
  ],
} as const

/**
 * The 0.3.0 settings payload, spelled out rather than imported.
 *
 * Importing `DEFAULT_SETTINGS` would make this fixture track the code it is
 * meant to hold still against: once 006 reshapes the defaults, an imported
 * fixture would silently start seeding the *new* shape and the reshape test
 * would migrate something already migrated.
 */
export const SETTINGS_0_3_0 = {
  appearance: 'dark',
  density: 'compact',
  pollIntervalSec: { github: 90, jira: 600 },
  laneThresholdHours: { tickets: 48, pulls: 12, branches: 36 },
  driftGraceHours: 24,
  heartbeatMissMultiplier: 3,
  activeProjectId: 'proj-both',
  mineOnly: true,
  windowGeometry: { x: 100, y: 60, width: 1280, height: 800 },
  alwaysOnTop: true,
} as const

/**
 * Seed a database that already carries the 0.3.0 (authored v1) schema.
 *
 * The caller migrates to v1 first — this only inserts. Written as plain SQL
 * against the old column names on purpose: going through the repository would
 * bind the fixture to the *current* code, and the current code is what changes.
 */
export function seedAuthored030(db: Database): void {
  const at = (iso: string) => iso

  // Three shapes, and the third is the one at risk.
  db.prepare(
    `INSERT INTO projects (id, code, name, color_index, jira_connection_id, jira_project_key,
       github_connection_id, repo_owner, repo_name, documentation_url, ticket_key_pattern,
       checkout_paths, status_overrides)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'proj-both',
    'WEB',
    'Web platform',
    2,
    'conn-jira',
    'ENG',
    'conn-gh',
    'acme',
    'web',
    'https://docs.example.com/web',
    '^ENG-\\d+$',
    JSON.stringify(['C:\\work\\web', 'C:\\work\\web-e2e']),
    JSON.stringify({ 'In Review': 'review' }),
  )

  db.prepare(
    `INSERT INTO projects (id, code, name, color_index, jira_connection_id, jira_project_key,
       github_connection_id, repo_owner, repo_name, documentation_url, ticket_key_pattern,
       checkout_paths, status_overrides)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'proj-jira-only',
    'OPS',
    'Operations',
    5,
    'conn-jira',
    'OPS',
    null,
    null,
    null,
    null,
    '^OPS-\\d+$',
    '[]',
    '{}',
  )

  // No ticket project at all. Legal under v1's CHECK, illegal under the
  // constraint 006 would naturally add, and it is the operator's row.
  db.prepare(
    `INSERT INTO projects (id, code, name, color_index, jira_connection_id, jira_project_key,
       github_connection_id, repo_owner, repo_name, documentation_url, ticket_key_pattern,
       checkout_paths, status_overrides)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    'proj-repo-only',
    'TOOLS',
    'Internal tooling',
    null,
    null,
    null,
    'conn-gh',
    'acme',
    'tools',
    null,
    '^TOOLS-\\d+$',
    JSON.stringify(['C:\\work\\tools']),
    '{}',
  )

  // One note per subject kind. Four of the five kinds describe things 006
  // deletes; the notes stay, and stay readable by key (FR-122, T040).
  const note = db.prepare(
    `INSERT INTO notes (id, subject_key, type, body, author_kind, author_id, revision,
       created_at, updated_at, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
  note.run(
    'note-ticket',
    'jira:acme.atlassian.net/ENG-1',
    'decision',
    'Ship behind a flag.',
    'user',
    null,
    2,
    at('2026-07-01T09:00:00Z'),
    at('2026-07-02T09:00:00Z'),
    null,
  )
  note.run(
    'note-pull',
    'gh:acme/web#42',
    'gotcha',
    'The retry masks a 500.',
    'agent',
    'agent-a',
    1,
    at('2026-07-03T09:00:00Z'),
    at('2026-07-03T09:00:00Z'),
    null,
  )
  note.run(
    'note-branch',
    'gh:acme/web@feature/ENG-1',
    'todo',
    'Rebase before review.',
    'user',
    null,
    1,
    at('2026-07-04T09:00:00Z'),
    at('2026-07-04T09:00:00Z'),
    null,
  )
  note.run(
    'note-workspace',
    'local:C%3A%5Cwork%5Cweb',
    'gotcha',
    'Submodule needs an explicit init.',
    'user',
    null,
    1,
    at('2026-07-05T09:00:00Z'),
    at('2026-07-05T09:00:00Z'),
    null,
  )
  // Open, and a question — the note that drives ball-in-court to the operator.
  // 006 removes the region that displayed it; T038a asserts it still counts.
  note.run(
    'note-session',
    'session:agent-a:sess-1',
    'question-for-human',
    'Should the migration run on launch or on demand?',
    'agent',
    'agent-a',
    1,
    at('2026-07-06T09:00:00Z'),
    at('2026-07-06T09:00:00Z'),
    null,
  )

  const session = db.prepare(
    `INSERT INTO agent_sessions (key, agent_id, session_id, project_id, work_item_key,
       workspace_key, reported_status, started_at, last_heartbeat_at, last_real_activity_at,
       ended_at, outcome, heartbeat_interval_sec)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  // With a workspace key — the column 006 drops.
  session.run(
    'agent-a:sess-1',
    'agent-a',
    'sess-1',
    'proj-both',
    'jira:acme.atlassian.net/ENG-1',
    'local:C%3A%5Cwork%5Cweb',
    'refactoring the parser',
    at('2026-07-06T08:00:00Z'),
    at('2026-07-06T09:30:00Z'),
    at('2026-07-06T09:25:00Z'),
    null,
    null,
    60,
  )
  // Without one, and ended. Both paths through the dropped column.
  session.run(
    'agent-b:sess-2',
    'agent-b',
    'sess-2',
    'proj-repo-only',
    null,
    null,
    null,
    at('2026-07-05T08:00:00Z'),
    at('2026-07-05T10:00:00Z'),
    at('2026-07-05T09:55:00Z'),
    at('2026-07-05T10:05:00Z'),
    'done',
    120,
  )

  // All four action kinds, in four states. 006 keeps the outbox; these rows are
  // the evidence that "keeps" meant the rows too, not just the code.
  const action = db.prepare(
    `INSERT INTO outbox_actions (id, subject_key, kind, payload, motivating_finding_id, state,
       confirmed_at, confirmed_via, claimed_by, claimed_at, claim_expires_at, result,
       failure_reason, completed_at, history)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  action.run(
    'act-pending',
    'jira:acme.atlassian.net/ENG-1',
    'comment',
    JSON.stringify({ body: 'Blocked on review.' }),
    'drift:D1:jira:acme.atlassian.net/ENG-1',
    'pending',
    at('2026-07-07T09:00:00Z'),
    'ui',
    null,
    null,
    null,
    null,
    null,
    null,
    JSON.stringify([{ at: '2026-07-07T09:00:00Z', state: 'pending' }]),
  )
  action.run(
    'act-claimed',
    'jira:acme.atlassian.net/ENG-2',
    'transition',
    JSON.stringify({ to: 'In Review' }),
    null,
    'claimed',
    at('2026-07-07T10:00:00Z'),
    'ui',
    'agent-a',
    at('2026-07-07T10:01:00Z'),
    at('2026-07-07T10:11:00Z'),
    null,
    null,
    null,
    JSON.stringify([
      { at: '2026-07-07T10:00:00Z', state: 'pending' },
      { at: '2026-07-07T10:01:00Z', state: 'claimed' },
    ]),
  )
  action.run(
    'act-complete',
    'gh:acme/web#42',
    'assign',
    JSON.stringify({ assignee: 'sam' }),
    'drift:D3:gh:acme/web#42',
    'complete',
    at('2026-07-06T10:00:00Z'),
    'ui',
    'agent-b',
    at('2026-07-06T10:01:00Z'),
    at('2026-07-06T10:11:00Z'),
    JSON.stringify({ ok: true }),
    null,
    at('2026-07-06T10:05:00Z'),
    JSON.stringify([
      { at: '2026-07-06T10:00:00Z', state: 'pending' },
      { at: '2026-07-06T10:05:00Z', state: 'complete' },
    ]),
  )
  action.run(
    'act-failed',
    'jira:acme.atlassian.net/ENG-9',
    'link',
    JSON.stringify({ url: 'https://example.com' }),
    null,
    'failed',
    at('2026-07-05T10:00:00Z'),
    'ui',
    'agent-a',
    at('2026-07-05T10:01:00Z'),
    at('2026-07-05T10:11:00Z'),
    null,
    'the tracker rejected the link type',
    at('2026-07-05T10:06:00Z'),
    JSON.stringify([
      { at: '2026-07-05T10:00:00Z', state: 'pending' },
      { at: '2026-07-05T10:06:00Z', state: 'failed' },
    ]),
  )

  // Dismissals for rules that are about to stop existing. They are retained
  // deliberately (FR-122) — which is exactly why the D1–D9 namespace is spent,
  // and why a future rule reusing a number would arrive pre-dismissed.
  const dismissal = db.prepare(
    `INSERT INTO finding_dismissals (finding_id, dismissed_at, evidence_hash) VALUES (?,?,?)`,
  )
  dismissal.run(AUTHORED_FIXTURE.dismissals[0], at('2026-07-01T12:00:00Z'), 'a1b2c3d4')
  dismissal.run(AUTHORED_FIXTURE.dismissals[1], at('2026-07-02T12:00:00Z'), 'b2c3d4e5')
  dismissal.run(AUTHORED_FIXTURE.dismissals[2], at('2026-07-03T12:00:00Z'), 'c3d4e5f6')
  dismissal.run(AUTHORED_FIXTURE.dismissals[3], at('2026-07-04T12:00:00Z'), 'd4e5f607')

  db.prepare('INSERT INTO settings (id, payload) VALUES (1, ?)').run(JSON.stringify(SETTINGS_0_3_0))
}
