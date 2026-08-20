import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTHORED_MIGRATIONS } from '../../src/store/authored/migrations.js'
import { migrate } from '../../src/store/migrate.js'
import { openAuthored } from '../../src/store/open.js'
import { AUTHORED_FIXTURE, seedAuthored030, SETTINGS_0_3_0 } from './fixtures/authored-0.3.0.js'

/**
 * The rule this harness exists to hold: **an authored migration may never lose
 * a row.**
 *
 * There is no server-side copy to restore from (constitution XI), so a
 * data-losing migration here is unrecoverable rather than merely embarrassing.
 * Every migration added to AUTHORED_MIGRATIONS gets a case below that seeds the
 * prior schema, migrates, and asserts every row survives with its content
 * intact — and the last test in this file fails if someone adds a migration
 * without adding its case.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-authored-mig-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const now = () => '2026-08-14T12:00:00Z'

/**
 * One case per authored migration. `seed` populates the schema as it existed
 * *before* the migration; `verify` runs after it and asserts nothing was lost.
 */
interface MigrationCase {
  version: number
  name: string
  seed(db: Database.Database): void
  verify(db: Database.Database): void
}

const CASES: MigrationCase[] = [
  {
    version: 1,
    name: 'init',
    // Nothing precedes the initial schema, so the case is that it creates the
    // tables the app expects and starts empty rather than half-formed.
    seed: () => {},
    verify: (db) => {
      const tables = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all() as { name: string }[]
      ).map((r) => r.name)

      for (const expected of [
        'projects',
        'notes',
        'agent_sessions',
        'outbox_actions',
        'finding_dismissals',
        'settings',
      ]) {
        expect(tables).toContain(expected)
      }
    },
  },
  {
    version: 2,
    name: 'remove-code-host-and-local-git',
    /**
     * The migration that can lose the operator's data, against a database
     * shaped like a real 0.3.0 one.
     *
     * The fixture is not written here — it is `fixtures/authored-0.3.0.ts`,
     * written before this migration existed, precisely so that it enumerates the
     * shapes the old schema could hold rather than the shapes this migration
     * happens to handle. A fixture written afterwards contains the cases the
     * code already covers, which is exactly the set that proves nothing.
     */
    seed: seedAuthored030,
    verify: (db) => {
      const ids = (table: string, column: string): string[] =>
        (
          db.prepare(`SELECT "${column}" k FROM "${table}" ORDER BY "${column}"`).all() as {
            k: string
          }[]
        ).map((r) => r.k)

      // ── Every row, by name and not merely by count ───────────────────────
      //
      // The harness above already asserts no table shrank. That would pass on a
      // migration that deleted one project and inserted another, so the ids are
      // compared rather than the counts.
      expect(ids('projects', 'id')).toEqual([...AUTHORED_FIXTURE.projects].sort())
      expect(ids('notes', 'id')).toEqual([...AUTHORED_FIXTURE.notes].sort())
      expect(ids('agent_sessions', 'key')).toEqual([...AUTHORED_FIXTURE.sessions].sort())
      expect(ids('outbox_actions', 'id')).toEqual([...AUTHORED_FIXTURE.actions].sort())
      expect(ids('finding_dismissals', 'finding_id')).toEqual(
        [...AUTHORED_FIXTURE.dismissals].sort(),
      )

      // ── The row this migration is most likely to delete ──────────────────
      //
      // `proj-repo-only` has no jira_project_key. It was legal under v1's CHECK
      // and is refused by the constraint a careless rebuild would add, and the
      // tidy way to make an INSERT ... SELECT satisfy a constraint is to filter
      // out the row that violates it. It is the operator's project binding and
      // there is no server-side copy of it.
      const repoOnly = db
        .prepare('SELECT code, jira_project_key FROM projects WHERE id = ?')
        .get('proj-repo-only') as { code: string; jira_project_key: string | null } | undefined

      expect(repoOnly, 'the repository-only project was deleted').toBeDefined()
      expect(repoOnly?.code).toBe('TOOLS')
      expect(repoOnly?.jira_project_key).toBeNull()

      // And the table permits it, rather than happening to contain it. A CHECK
      // added here would refuse the next such row instead of this one.
      const sql = (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`)
          .get() as {
          sql: string
        }
      ).sql
      expect(sql).not.toMatch(/CHECK/i)

      // ── The columns that went, and the ones that stayed ──────────────────
      const columns = (table: string): string[] =>
        (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name)

      for (const gone of ['github_connection_id', 'repo_owner', 'repo_name', 'checkout_paths']) {
        expect(columns('projects'), `${gone} is still on projects`).not.toContain(gone)
      }
      for (const kept of [
        'id',
        'code',
        'name',
        'color_index',
        'jira_connection_id',
        'jira_project_key',
        'documentation_url',
        'status_overrides',
      ]) {
        expect(columns('projects'), `${kept} was dropped from projects`).toContain(kept)
      }

      expect(columns('agent_sessions')).not.toContain('workspace_key')
      expect(columns('agent_sessions')).toContain('work_item_key')

      /*
       * The session is still attached to its project.
       *
       * `agent_sessions.project_id` is `ON DELETE SET NULL` against `projects`,
       * and `DROP TABLE` performs an implicit `DELETE FROM` — so the rebuild
       * unlinks every session unless foreign keys are off around it. Nothing
       * about that failure looks like data loss: the sessions are all still
       * there, every count matches, and each one belongs to nothing. It would
       * show up as a project filter that hides every agent, weeks later.
       *
       * This assertion is here because the row-count harness above cannot see
       * it, and neither could the first version of this case.
       */
      const sessions = db
        .prepare('SELECT key, project_id, work_item_key FROM agent_sessions ORDER BY key')
        .all() as { key: string; project_id: string | null; work_item_key: string | null }[]

      expect(sessions.map((s) => s.project_id)).toEqual(['proj-both', 'proj-repo-only'])
      expect(sessions[0]?.work_item_key).toBe('jira:acme.atlassian.net/ENG-1')

      // Content, not just presence: a rebuild that copied the columns in the
      // wrong order would keep every row and put the name in the code.
      const both = db
        .prepare(
          'SELECT code, name, jira_project_key, documentation_url FROM projects WHERE id = ?',
        )
        .get('proj-both') as Record<string, unknown>
      expect(both['code']).toBe('WEB')
      expect(both['name']).toBe('Web platform')
      expect(both['jira_project_key']).toBe('ENG')
      expect(both['documentationUrl'] ?? both['documentation_url']).toBe(
        'https://docs.example.com/web',
      )

      // ── Notes on subjects that no longer resolve (FR-109) ────────────────
      const subjects = ids('notes', 'subject_key')
      expect(subjects.some((k) => k.startsWith('gh:'))).toBe(true)
      expect(subjects.some((k) => k.startsWith('local:'))).toBe(true)

      const question = db
        .prepare(`SELECT body FROM notes WHERE type = 'question-for-human' AND resolved_at IS NULL`)
        .get() as { body: string } | undefined
      expect(question?.body).toMatch(/migration run on launch/)

      // ── Outbox rows of retired kinds stay claimable (FR-117) ─────────────
      const actions = db
        .prepare('SELECT id, kind, state, history FROM outbox_actions ORDER BY id')
        .all() as { id: string; kind: string; state: string; history: string }[]

      expect(actions.map((a) => a.state).sort()).toEqual([
        'claimed',
        'complete',
        'failed',
        'pending',
      ])
      // `link` and `assign` are of kinds the type no longer produces. The column
      // has no CHECK, so they keep reading -- an action the operator confirmed
      // before the upgrade is still theirs.
      expect(actions.map((a) => a.kind)).toContain('link')
      expect(actions.map((a) => a.kind)).toContain('assign')
      // The append-only history came across whole, not truncated to its last
      // entry, which is the audit trail XVI rests on.
      expect(
        JSON.parse(actions.find((a) => a.id === 'act-complete')?.history ?? '[]'),
      ).toHaveLength(2)

      // ── Dismissals, untouched (FR-122) ───────────────────────────────────
      const dismissal = db
        .prepare('SELECT dismissed_at, evidence_hash FROM finding_dismissals WHERE finding_id = ?')
        .get(AUTHORED_FIXTURE.dismissals[0]) as { dismissed_at: string; evidence_hash: string }

      expect(dismissal.dismissed_at).toBe('2026-07-01T12:00:00Z')
      expect(dismissal.evidence_hash).toBe('a1b2c3d4')

      // ── Settings: reshaped, and the tuned values carried ─────────────────
      const payload = JSON.parse(
        (db.prepare('SELECT payload FROM settings WHERE id = 1').get() as { payload: string })
          .payload,
      ) as Record<string, unknown>

      expect(payload['pollIntervalSec']).toEqual({ jira: SETTINGS_0_3_0.pollIntervalSec.jira })
      expect(payload['laneThresholdHours']).toEqual({
        tickets: SETTINGS_0_3_0.laneThresholdHours.tickets,
        // Carried from `pulls`, which the operator had tuned to 12. A default of
        // 24 here would mean a tuned number silently lost.
        sessions: SETTINGS_0_3_0.laneThresholdHours.pulls,
      })
      expect(payload['driftGraceHours']).toBeUndefined()

      // Everything else in the payload is untouched. The reshape rewrites the
      // whole row, so a spread that dropped a key would take the operator's
      // window position and filter with it.
      expect(payload['activeProjectId']).toBe('proj-both')
      expect(payload['mineOnly']).toBe(true)
      expect(payload['alwaysOnTop']).toBe(true)
      expect(payload['appearance']).toBe('dark')
      expect(payload['density']).toBe('compact')
      expect(payload['windowGeometry']).toEqual(SETTINGS_0_3_0.windowGeometry)
    },
  },
  {
    version: 3,
    name: 'active-ticket',
    /**
     * An additive migration, and the case is here to hold it additive.
     *
     * `CREATE TABLE` on its own cannot lose a row, so the interesting failure is
     * not this migration as written — it is the next edit to it. A migration
     * that adds a table and *also* tidies something is the shape that gets
     * written when the tidying is one line and the table is already there, and
     * the rows seeded below are what notices.
     */
    seed: (db) => {
      // Written in the post-migration-2 schema, because the runner has already
      // applied 1 and 2 by the time this runs. Deliberately not the 0.3.0
      // fixture: that one describes a schema this database no longer has.
      db.prepare(
        `INSERT INTO projects (id, code, name, jira_connection_id, jira_project_key, status_overrides)
         VALUES ('proj-web', 'WEB', 'Web platform', 'conn-jira', 'ENG', '{}')`,
      ).run()

      db.prepare(
        `INSERT INTO notes (id, subject_key, type, body, author_kind, author_id, revision,
                            created_at, updated_at, resolved_at)
         VALUES ('note-1', 'jira:acme.atlassian.net/ENG-1', 'decision', 'Chose the boring option',
                 'user', NULL, 2, '2026-08-01T09:00:00Z', '2026-08-02T09:00:00Z', NULL)`,
      ).run()

      db.prepare(`INSERT INTO settings (id, payload) VALUES (1, '{"appearance":"dark"}')`).run()
    },
    verify: (db) => {
      // Nothing this migration does not name is touched. The row-count harness
      // above catches a table emptied; this catches a row replaced.
      const note = db.prepare('SELECT body, revision FROM notes WHERE id = ?').get('note-1') as
        { body: string; revision: number } | undefined
      expect(note?.body).toBe('Chose the boring option')
      expect(note?.revision).toBe(2)
      expect(
        (db.prepare('SELECT code FROM projects WHERE id = ?').get('proj-web') as { code: string })
          .code,
      ).toBe('WEB')
      expect(
        (db.prepare('SELECT payload FROM settings WHERE id = 1').get() as { payload: string })
          .payload,
      ).toBe('{"appearance":"dark"}')

      // ── The new table ────────────────────────────────────────────────────
      const columns = (
        db.prepare(`PRAGMA table_info("active_ticket")`).all() as { name: string }[]
      ).map((c) => c.name)
      expect(columns).toEqual(['id', 'ticket_key', 'set_by', 'set_by_id', 'set_at'])

      // Empty, and that is the *representation* of "nothing is active" rather
      // than a coincidence of a fresh database. A migration that helpfully
      // inserted a placeholder row would give the panel a null ticket key to
      // render on every existing install.
      expect((db.prepare('SELECT COUNT(*) n FROM active_ticket').get() as { n: number }).n).toBe(0)

      // The singleton CHECK does its job. Without it two rows are legal, `get`
      // reads whichever SQLite hands back first, and the board's focus changes
      // depending on the query plan.
      db.prepare(
        `INSERT INTO active_ticket (id, ticket_key, set_by, set_by_id, set_at)
         VALUES (1, 'jira:acme.atlassian.net/ENG-1', 'agent', 'claude', '2026-08-19T10:00:00Z')`,
      ).run()

      expect(() =>
        db
          .prepare(
            `INSERT INTO active_ticket (id, ticket_key, set_by, set_by_id, set_at)
             VALUES (2, 'jira:acme.atlassian.net/ENG-2', 'user', NULL, '2026-08-19T11:00:00Z')`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/)

      // A key the mirror has never held is storable. There is no foreign key
      // here and there must not be: FR-131 has an agent setting focus before the
      // sync that would fetch the ticket, and a constraint would turn the case
      // the panel is specified to render into a write that fails.
      expect(() =>
        db
          .prepare(
            `UPDATE active_ticket SET ticket_key = 'jira:acme.atlassian.net/NOPE-9999' WHERE id = 1`,
          )
          .run(),
      ).not.toThrow()
    },
  },
  {
    version: 4,
    name: 'agent-updates',
    /**
     * Additive again, and the case is again about keeping it that way.
     *
     * The one thing worth asserting beyond survival is the **absence of a
     * foreign key** to `agent_sessions`. It would be the natural thing to add,
     * it would be wrong, and it would not fail anything until a session was
     * deleted and took a history of what an agent said with it.
     */
    seed: (db) => {
      db.prepare(
        `INSERT INTO agent_sessions (key, agent_id, session_id, started_at, last_heartbeat_at,
                                     heartbeat_interval_sec)
         VALUES ('session:claude/a', 'claude', 'a', '2026-08-01T09:00:00Z',
                 '2026-08-01T09:00:00Z', 60)`,
      ).run()
      db.prepare(
        `INSERT INTO active_ticket (id, ticket_key, set_by, set_by_id, set_at)
         VALUES (1, 'jira:acme.atlassian.net/ENG-1', 'agent', 'claude', '2026-08-01T09:00:00Z')`,
      ).run()
    },
    verify: (db) => {
      const columns = (
        db.prepare(`PRAGMA table_info("agent_updates")`).all() as { name: string }[]
      ).map((c) => c.name)
      expect(columns).toEqual(['id', 'session_key', 'agent_id', 'ticket_key', 'text', 'posted_at'])

      // What migration 3 wrote is still there. `active_ticket` is a single row
      // by CHECK, so a migration that recreated it would be silently destructive
      // in a way no row count catches.
      expect(
        (
          db.prepare('SELECT ticket_key FROM active_ticket WHERE id = 1').get() as {
            ticket_key: string
          }
        ).ticket_key,
      ).toBe('jira:acme.atlassian.net/ENG-1')

      /*
       * No foreign key to `agent_sessions`, asserted by deleting one.
       *
       * An update has to outlive the session row it came from -- the panel shows
       * a history, and a history that disappeared when a session was tidied away
       * would not be one. A `REFERENCES agent_sessions(key) ON DELETE CASCADE`
       * here is the obvious thing to write and would pass every other test in
       * this file.
       */
      db.prepare(
        `INSERT INTO agent_updates (id, session_key, agent_id, ticket_key, text, posted_at)
         VALUES ('u1', 'session:claude/a', 'claude', 'jira:acme.atlassian.net/ENG-1',
                 'Found the cause.', '2026-08-01T10:00:00Z')`,
      ).run()

      db.prepare(`DELETE FROM agent_sessions WHERE key = 'session:claude/a'`).run()

      const survived = db
        .prepare('SELECT agent_id, text FROM agent_updates WHERE id = ?')
        .get('u1') as { agent_id: string; text: string } | undefined
      expect(survived?.text).toBe('Found the cause.')
      // And it can still name its author, which is why `agent_id` is stored
      // here rather than joined.
      expect(survived?.agent_id).toBe('claude')
    },
  },
  {
    version: 5,
    name: 'prompts',
    /**
     * Additive, and the case carries two properties beyond survival.
     *
     * **The text is stored whole.** FR-138 is a promise about what reaches the
     * clipboard, and the only place a truncation could not be undone is the
     * write. A `TEXT` column has no bound, so what is really being pinned here
     * is that nobody adds one — a `CHECK (length(text) <= n)` would look like
     * tidiness and would silently shorten the one field the feature exists to
     * reproduce exactly.
     *
     * **No foreign keys**, asserted the same way migration 4's absence is: by
     * deleting the things a reference would point at. A prompt recorded against
     * a session that has since been tidied away, or a project the operator has
     * removed, is still a prompt they may want to send again.
     */
    seed: (db) => {
      db.prepare(
        `INSERT INTO agent_sessions (key, agent_id, session_id, started_at, last_heartbeat_at,
                                     heartbeat_interval_sec)
         VALUES ('session:claude/b', 'claude', 'b', '2026-08-01T09:00:00Z',
                 '2026-08-01T09:00:00Z', 60)`,
      ).run()
      db.prepare(
        `INSERT INTO agent_updates (id, session_key, agent_id, ticket_key, text, posted_at)
         VALUES ('u2', 'session:claude/b', 'claude', NULL, 'Still here.', '2026-08-01T10:00:00Z')`,
      ).run()
    },
    verify: (db) => {
      const columns = (db.prepare(`PRAGMA table_info("prompts")`).all() as { name: string }[]).map(
        (c) => c.name,
      )
      expect(columns).toEqual([
        'id',
        'text',
        'agent_id',
        'session_key',
        'project_id',
        'recorded_at',
      ])

      // Migration 4's rows are untouched. A rebuild of a neighbouring table
      // would pass a column check and lose these.
      expect(
        (db.prepare('SELECT text FROM agent_updates WHERE id = ?').get('u2') as { text: string })
          .text,
      ).toBe('Still here.')

      // Thirty thousand characters in and thirty thousand out. The number is
      // arbitrary; being far past anything a length constraint would be set to
      // is not.
      const long = 'x'.repeat(30_000)
      db.prepare(
        `INSERT INTO prompts (id, text, agent_id, session_key, project_id, recorded_at)
         VALUES ('p1', ?, 'claude', 'session:claude/b', 'proj-1', '2026-08-01T11:00:00Z')`,
      ).run(long)

      expect(
        (db.prepare('SELECT text FROM prompts WHERE id = ?').get('p1') as { text: string }).text
          .length,
      ).toBe(30_000)

      // Neither reference is a constraint. Both deletions would fail, or would
      // cascade, if one had been added.
      db.prepare(`DELETE FROM agent_sessions WHERE key = 'session:claude/b'`).run()
      db.prepare(`DELETE FROM projects WHERE id = 'proj-1'`).run()

      const kept = db
        .prepare('SELECT session_key, project_id FROM prompts WHERE id = ?')
        .get('p1') as { session_key: string | null; project_id: string | null } | undefined
      expect(kept?.session_key).toBe('session:claude/b')
      expect(kept?.project_id).toBe('proj-1')
    },
  },
  {
    version: 6,
    name: 'ticket-history',
    /**
     * Additive, and the case carries three properties beyond survival.
     *
     * **One row per ticket, enforced by the schema.** The primary key is the
     * ticket, so a second entry is a constraint failure rather than a duplicate
     * row somebody notices months later. Asserted by inserting the same key
     * twice and requiring the second to throw.
     *
     * **No foreign key**, asserted the way migrations 4 and 5 assert theirs: by
     * deleting the thing a reference would point at. There is nothing in
     * `authored.db` to point at here -- the ticket lives in the other file
     * entirely (XIII) -- so what is really pinned is that `projects` cannot
     * cascade into it either.
     *
     * **Nothing prunes it** (FR-150). The behavioural half of that lives in
     * `store/history-retention.test.ts`; what belongs here is the absence of a
     * trigger, because a schema-level prune would survive every test written
     * against the repository.
     */
    seed: (db) => {
      db.prepare(
        `INSERT INTO prompts (id, text, agent_id, session_key, project_id, recorded_at)
         VALUES ('p9', 'Kept.', 'claude', NULL, NULL, '2026-08-01T11:00:00Z')`,
      ).run()
    },
    verify: (db) => {
      const columns = (
        db.prepare(`PRAGMA table_info("ticket_history")`).all() as { name: string }[]
      ).map((c) => c.name)
      expect(columns).toEqual([
        'ticket_key',
        'line',
        'notes',
        'ticket_summary',
        'author_kind',
        'author_id',
        'revision',
        'created_at',
        'updated_at',
      ])

      // Migration 5's rows are untouched. A rebuild of a neighbouring table
      // would pass a column check and lose these.
      expect(
        (db.prepare('SELECT text FROM prompts WHERE id = ?').get('p9') as { text: string }).text,
      ).toBe('Kept.')

      const insert = db.prepare(
        `INSERT INTO ticket_history
           (ticket_key, line, notes, ticket_summary, author_kind, author_id, revision,
            created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'agent', 'claude', 1,
                 '2026-08-01T12:00:00Z', '2026-08-01T12:00:00Z')`,
      )
      insert.run('jira:acme.atlassian.net/MERC-1', 'Done.')

      // One row per ticket, at the schema rather than by care.
      expect(() => insert.run('jira:acme.atlassian.net/MERC-1', 'Done again.')).toThrow(
        /UNIQUE constraint failed/,
      )

      // No cascade reaches it. `projects` is the only table in this file with
      // dependants, and a history entry is not one of them.
      db.prepare(`DELETE FROM projects`).run()
      expect(db.prepare('SELECT COUNT(*) AS n FROM ticket_history').get()).toEqual({ n: 1 })

      // And no trigger prunes it. A schema-level retention rule would be
      // invisible to every test written against the repository.
      const triggers = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
        .all('ticket_history') as { name: string }[]
      expect(triggers).toEqual([])
    },
  },
]

describe('authored migrations', () => {
  for (const c of CASES) {
    it(`migration ${c.version} (${c.name}) loses nothing`, () => {
      const db = new Database(join(dir, 'authored.db'))
      db.pragma('foreign_keys = ON')

      const priorMigrations = AUTHORED_MIGRATIONS.filter((m) => m.version < c.version)
      migrate(db, priorMigrations, now)
      c.seed(db)

      const before = rowCounts(db)
      migrate(
        db,
        AUTHORED_MIGRATIONS.filter((m) => m.version <= c.version),
        now,
      )
      const after = rowCounts(db)

      for (const [table, count] of Object.entries(before)) {
        expect(
          after[table],
          `${table} lost rows during migration ${c.version}`,
        ).toBeGreaterThanOrEqual(count)
      }

      c.verify(db)
      db.close()
    })
  }

  it('is idempotent — reopening does not re-run anything', () => {
    const first = openAuthored({ dir, now })
    expect(first.migration.applied.length).toBe(AUTHORED_MIGRATIONS.length)
    first.db.close()

    const second = openAuthored({ dir, now })
    expect(second.migration.applied).toEqual([])
    expect(second.migration.to).toBe(AUTHORED_MIGRATIONS.length)
    second.db.close()
  })

  // Two branches each adding "the next migration" produce a duplicate version,
  // and one of them then silently never runs on a database that already applied
  // the other. Fail at startup instead of discovering it in a bug report.
  it('refuses a migration sequence with a gap or duplicate', () => {
    const db = new Database(join(dir, 'broken.db'))

    expect(() =>
      migrate(
        db,
        [
          { version: 1, name: 'a', up: 'CREATE TABLE a (x)' },
          { version: 3, name: 'c', up: 'CREATE TABLE c (x)' },
        ],
        now,
      ),
    ).toThrow(/sequence is broken/)

    expect(() =>
      migrate(
        db,
        [
          { version: 1, name: 'a', up: 'CREATE TABLE a2 (x)' },
          { version: 1, name: 'b', up: 'CREATE TABLE b (x)' },
        ],
        now,
      ),
    ).toThrow(/sequence is broken/)

    db.close()
  })

  it('leaves the database at the last good version when a migration fails', () => {
    const db = new Database(join(dir, 'partial.db'))

    expect(() =>
      migrate(
        db,
        [
          { version: 1, name: 'ok', up: 'CREATE TABLE kept (x)' },
          { version: 2, name: 'broken', up: 'THIS IS NOT SQL' },
        ],
        now,
      ),
    ).toThrow()

    // Migration 1 committed; migration 2 rolled back cleanly. The next launch
    // resumes from here rather than redoing work that was fine.
    const version = db.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }
    expect(version.v).toBe(1)
    expect(() => db.prepare('SELECT * FROM kept').all()).not.toThrow()

    db.close()
  })

  /**
   * The self-enforcing part. Adding a migration without adding its safety case
   * fails here — which is the only reliable way to keep a harness like this from
   * quietly stopping at whichever migration was current when it was written.
   */
  it('has a safety case for every authored migration', () => {
    const covered = new Set(CASES.map((c) => c.version))
    const uncovered = AUTHORED_MIGRATIONS.filter((m) => !covered.has(m.version))

    expect(
      uncovered.map((m) => `${m.version}_${m.name}`),
      'every authored migration needs a case in CASES proving it loses no rows',
    ).toEqual([])
  })
})

function rowCounts(db: Database.Database): Record<string, number> {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((r) => r.name)

  return Object.fromEntries(
    tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c]),
  )
}
