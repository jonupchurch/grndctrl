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
  /**
   * A step SQL cannot express, run **inside the same transaction**, after `up`.
   *
   * Added for one case and deliberately kept narrow: reshaping the settings
   * payload, which is a JSON document in a single row. Doing it with SQLite's
   * JSON functions is possible and produces a statement nobody can review; doing
   * it outside the migration would mean a moment where the schema had moved and
   * the payload had not, on the one launch where nothing else changed.
   *
   * It gets a `Database` and nothing else. A migration that reached outside the
   * database file — the keychain, the network, the filesystem — would be doing
   * something the surrounding transaction cannot roll back, and could not be run
   * against a test database without side effects. FR-112's keychain deletion is
   * therefore the *caller's* job, from refs the migration leaves behind.
   */
  after?: (db: Database) => void
  /**
   * Rebuild a table that other tables reference.
   *
   * **`DROP TABLE` performs an implicit `DELETE FROM`**, so with foreign keys
   * enabled it fires every `ON DELETE` action pointing at that table. Dropping
   * `connections` cascades into every ticket; dropping `projects` sets every
   * agent session's `project_id` to NULL. Both are silent: the migration
   * succeeds, the schema is right, and rows the operator had are gone.
   *
   * SQLite's own twelve-step table-rebuild procedure opens with "disable foreign
   * keys", and it says to do it **outside** the transaction because
   * `PRAGMA foreign_keys` is a no-op inside one. That is why this is a flag on
   * the migration rather than a statement in its `up`: a
   * `PRAGMA foreign_keys = OFF` written into the SQL would parse, run, do
   * nothing at all, and read like a precaution that had been taken.
   *
   * `foreign_key_check` runs before the pragma is restored. A rebuild that broke
   * a reference must fail here rather than leave a dangling row for a future
   * read to trip over.
   */
  rebuildsReferencedTable?: boolean
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
      m.after?.(db)
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now(),
      )
    })

    if (m.rebuildsReferencedTable !== true) {
      run()
    } else {
      // Outside the transaction, because that is the only place the pragma has
      // any effect. Restored in `finally`, so a migration that throws does not
      // leave the connection with foreign keys off for the rest of the process.
      const enabled = db.pragma('foreign_keys', { simple: true }) === 1
      db.pragma('foreign_keys = OFF')
      try {
        run()
        const broken = db.pragma('foreign_key_check') as unknown[]
        if (broken.length > 0) {
          throw new Error(
            `Migration ${m.version}_${m.name} left ${broken.length} dangling foreign key ` +
              `reference(s). The rebuild is wrong; the database has been rolled back.`,
          )
        }
      } finally {
        if (enabled) db.pragma('foreign_keys = ON')
      }
    }

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
