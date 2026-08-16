import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTHORED_MIGRATIONS } from '../../src/store/authored/migrations.js'
import { migrate } from '../../src/store/migrate.js'
import { openAuthored } from '../../src/store/open.js'

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
