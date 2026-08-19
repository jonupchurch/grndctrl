import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { AUTHORED_MIGRATIONS } from './authored/migrations.js'
import { MIRROR_MIGRATIONS } from './mirror/migrations.js'
import { currentVersion, migrate, type MigrationResult } from './migrate.js'
import { authoredDbPath, mirrorDbPath } from './paths.js'

export interface OpenedStore {
  db: Db
  migration: MigrationResult
}

export interface OpenedMirror extends OpenedStore {
  /**
   * Keychain handles belonging to connections migration 4 deleted (FR-112).
   *
   * Empty on every launch but the one that upgrades, and empty on that one too
   * for an operator who never added a code host. **The caller must delete each
   * secret**; nothing else can, because after the migration there is no row
   * naming them and no screen that can reach them. A secret left behind is
   * unreachable, unremovable through the interface, and still a secret.
   */
  orphanedCredentialRefs: string[]
}

export interface OpenOptions {
  /** Defaults to the per-user app data directory. Tests pass a temp directory. */
  dir?: string
  /** Injected so migration timestamps are deterministic under test. */
  now?: () => string
  /**
   * Where to load the compiled SQLite addon from.
   *
   * `better-sqlite3` is a native module, so its binary is built against one
   * ABI: Node 22 is `NODE_MODULE_VERSION` 127 and Electron 33 is 130. The two
   * cannot be the same file, and one checkout has to serve both — the suite
   * runs under Node (XVIII requires it to), and the app runs under Electron.
   *
   * Left unset, `bindings` finds the copy in `node_modules`, built for Node.
   * The desktop host sets it to the Electron-ABI build fetched by
   * `scripts/fetch-native.mjs`. Neither runtime has to know about the other's
   * copy, and neither build overwrites the other.
   */
  nativeBinding?: string | undefined
}

function open(
  path: string,
  migrations: readonly (typeof MIRROR_MIGRATIONS)[number][],
  now: () => string,
  nativeBinding: string | undefined,
): OpenedStore {
  mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path, nativeBinding === undefined ? {} : { nativeBinding })

  // WAL: readers do not block the writer. This matters here because a sync
  // writes while the board reads, and a blocked read is a frozen lane.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  const migration = migrate(db, migrations, now)
  return { db, migration }
}

const isoNow = () => new Date().toISOString()

/**
 * Open the disposable provider cache.
 *
 * Deleting this file is supported and tested: the app rebuilds it from the
 * providers, and nothing the user authored is affected (constitution XIII).
 */
export function openMirror(opts: OpenOptions = {}): OpenedMirror {
  const path = mirrorDbPath(opts.dir)
  mkdirSync(dirname(path), { recursive: true })

  const db = new Database(path, opts.nativeBinding === undefined ? {} : { nativeBinding: opts.nativeBinding })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  /*
   * Read the credential references before migration 4 drops the rows holding
   * them (FR-112). After it runs there is nothing left to read them from, which
   * is why this is here rather than inside the migration — and it is outside
   * the migration rather than in it because deleting from the OS keychain is
   * something no transaction can roll back.
   *
   * Guarded on the version so it is one cheap query on the upgrade launch and
   * nothing at all afterwards. `try` because a database that has never been
   * created has no `connections` table to ask, which is the ordinary first-run
   * case and not a failure.
   */
  const orphanedCredentialRefs: string[] = []
  if (currentVersion(db) < 4) {
    try {
      const rows = db
        .prepare(`SELECT credential_ref FROM connections WHERE kind <> 'jira'`)
        .all() as { credential_ref: string }[]
      orphanedCredentialRefs.push(...rows.map((r) => r.credential_ref).filter((r) => r !== ''))
    } catch {
      // No `connections` table yet. First run.
    }
  }

  const migration = migrate(db, MIRROR_MIGRATIONS, opts.now ?? isoNow)
  return { db, migration, orphanedCredentialRefs }
}

/**
 * Open the user's own data.
 *
 * Separate *file*, not a separate schema in the same file — that is what makes
 * "rebuild the mirror" an `unlink` rather than a careful cascade, and what makes
 * it impossible for a foreign key to reach across and delete a note.
 */
export function openAuthored(opts: OpenOptions = {}): OpenedStore {
  return open(authoredDbPath(opts.dir), AUTHORED_MIGRATIONS, opts.now ?? isoNow, opts.nativeBinding)
}
