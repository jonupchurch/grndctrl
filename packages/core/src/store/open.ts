import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import { AUTHORED_MIGRATIONS } from './authored/migrations.js'
import { MIRROR_MIGRATIONS } from './mirror/migrations.js'
import { migrate, type MigrationResult } from './migrate.js'
import { authoredDbPath, mirrorDbPath } from './paths.js'

export interface OpenedStore {
  db: Db
  migration: MigrationResult
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
export function openMirror(opts: OpenOptions = {}): OpenedStore {
  return open(mirrorDbPath(opts.dir), MIRROR_MIGRATIONS, opts.now ?? isoNow, opts.nativeBinding)
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
