import type { Database } from 'better-sqlite3'

/**
 * Forward-only migrations, one independent chain per database.
 *
 * The two chains are deliberately separate — `mirror.db` and `authored.db` have
 * different lifecycles and different rules (constitution XIII):
 *
 *   Mirror   — a migration may legitimately be "drop the file and resync". The
 *              app must survive that on any launch anyway, so it costs nothing.
 *   Authored — a migration may never lose a row. There is no server-side copy
 *              to restore from (XI), so a data-losing migration here is
 *              unrecoverable rather than merely embarrassing. Every authored
 *              migration ships a case in the migration-safety harness.
 */

export interface Migration {
  version: number
  name: string
  /** Raw SQL, executed inside the migration transaction. */
  up: string
}

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

const VERSION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER NOT NULL PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  )
`

export function currentVersion(db: Database): number {
  db.exec(VERSION_TABLE)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  return row.v ?? 0
}

/**
 * Apply every migration newer than the database's current version, in order,
 * each in its own transaction.
 *
 * Per-migration transactions rather than one big one: a failure then leaves the
 * database at the last version that fully succeeded, which is a state the next
 * launch can resume from. A single wrapping transaction would roll back work
 * that was fine and re-run it every time.
 */
export function migrate(db: Database, migrations: readonly Migration[], now: () => string): MigrationResult {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  assertContiguous(ordered)

  const from = currentVersion(db)
  const applied: string[] = []

  for (const m of ordered) {
    if (m.version <= from) continue

    const run = db.transaction(() => {
      db.exec(m.up)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now(),
      )
    })
    run()
    applied.push(`${m.version}_${m.name}`)
  }

  return { from, to: currentVersion(db), applied }
}

/**
 * Two migrations claiming the same version, or a gap in the sequence, means two
 * branches each added "the next one" and one of them will silently never run on
 * a database that already saw the other. Fail loudly at startup instead.
 */
function assertContiguous(ordered: readonly Migration[]): void {
  ordered.forEach((m, i) => {
    const expected = i + 1
    if (m.version !== expected) {
      throw new Error(
        `Migration sequence is broken: expected version ${expected}, found ${m.version} (${m.name}). ` +
          `Versions must be contiguous from 1 — a gap or duplicate means a migration will be skipped ` +
          `on databases that already applied its neighbour.`,
      )
    }
  })
}
