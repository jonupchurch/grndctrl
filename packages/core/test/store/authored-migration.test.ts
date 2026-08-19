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
        (db.prepare(`SELECT "${column}" k FROM "${table}" ORDER BY "${column}"`).all() as {
          k: string
        }[]).map((r) => r.k)

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
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`).get() as {
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
      for (const kept of ['id', 'code', 'name', 'color_index', 'jira_connection_id',
                          'jira_project_key', 'documentation_url', 'status_overrides']) {
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
        .prepare('SELECT code, name, jira_project_key, documentation_url FROM projects WHERE id = ?')
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
      expect(JSON.parse(actions.find((a) => a.id === 'act-complete')?.history ?? '[]')).toHaveLength(
        2,
      )

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
        expect(after[table], `${table} lost rows during migration ${c.version}`).toBeGreaterThanOrEqual(
          count,
        )
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
      migrate(db, [{ version: 1, name: 'a', up: 'CREATE TABLE a (x)' }, { version: 3, name: 'c', up: 'CREATE TABLE c (x)' }], now),
    ).toThrow(/sequence is broken/)

    expect(() =>
      migrate(db, [{ version: 1, name: 'a', up: 'CREATE TABLE a2 (x)' }, { version: 1, name: 'b', up: 'CREATE TABLE b (x)' }], now),
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
