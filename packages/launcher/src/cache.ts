import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'

/**
 * Where a downloaded Electron runtime lives (T162).
 *
 * ## Why this is not the data directory
 *
 * `GRNDCTRL_DATA_DIR` scopes the databases, and the end-to-end suite gives every
 * spec a fresh one — sixty of them in a run. A runtime cached beside the data
 * would be downloaded sixty times, and the operator's real board and a throwaway
 * scratch directory would each carry their own 100MB copy of the same
 * unpacked Electron.
 *
 * So the runtime cache is **per machine and per runtime version**, keyed on
 * nothing the caller can scope. It holds no user data, no credentials and
 * nothing authored: it is a redownloadable artifact, and deleting the whole tree
 * costs one download.
 *
 * ## Why the key has three parts
 *
 * `<version>-<platform>-<arch>`. A cache keyed on version alone breaks on the
 * machine people actually hit it on: an arm64 Mac running an x64 Node under
 * Rosetta, or a laptop whose home directory is synced between an Intel and an
 * Apple Silicon machine. The failure is a runtime that unpacks fine and cannot
 * execute, which reads as a corrupt download.
 */

const APP_DIR = 'grndctrl'

export interface CacheTarget {
  version: string
  platform: string
  arch: string
}

/**
 * The machine-level cache root.
 *
 * `GRNDCTRL_RUNTIME_CACHE` overrides it — for a machine with a small system
 * drive, for a CI runner that wants it inside the workspace, and for the tests
 * here, which must never write to the operator's real cache.
 *
 * Deliberately *not* `GRNDCTRL_DATA_DIR`: someone pointing the app at a scratch
 * data directory has said nothing about where a shared runtime should live, and
 * silently redirecting a 100MB download on the strength of that is a surprise.
 */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, plat = osPlatform()): string {
  const override = env['GRNDCTRL_RUNTIME_CACHE']
  if (override !== undefined && override.trim() !== '') return override.trim()

  switch (plat) {
    case 'win32': {
      // LOCALAPPDATA, not APPDATA. A roaming profile would drag an unpacked
      // Electron across the network at every login.
      const base = env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
      return join(base, APP_DIR, 'runtime')
    }
    case 'darwin':
      return join(homedir(), 'Library', 'Caches', APP_DIR, 'runtime')
    default: {
      const base = env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache')
      return join(base, APP_DIR, 'runtime')
    }
  }
}

/** The directory one specific runtime unpacks into. */
export function slotFor(target: CacheTarget, root: string): string {
  return join(root, slotName(target))
}

export function slotName(target: CacheTarget): string {
  // Sanitised because it becomes a path segment and `version` comes from a
  // manifest. A version of `../../etc` would otherwise place the cache
  // somewhere interesting.
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${safe(target.version)}-${safe(target.platform)}-${safe(target.arch)}`
}

export interface CacheIo {
  exists(path: string): boolean
  /** Every entry in a directory, or `[]` when it does not exist. */
  list(path: string): readonly string[]
  makeDir(path: string): void
  /** Atomic within a volume. Must not overwrite an existing destination. */
  move(from: string, to: string): void
  remove(path: string): void
  /** A scratch directory on the same volume as `root`, so `move` stays atomic. */
  scratch(root: string): string
}

export interface InstallRequest {
  target: CacheTarget
  root: string
  io: CacheIo
  /** Unpack the runtime into the directory given. Called only on a miss. */
  populate(into: string): Promise<void>
}

/**
 * The cached runtime directory, populating it if this is the first time.
 *
 * The staging step is the whole point. Unpacking straight into the final slot
 * means an interrupted download — a closed laptop, a dropped connection, a
 * Ctrl-C — leaves a directory that *exists*, so every later launch treats it as
 * a hit and fails on a missing file inside it. There is no self-repair from
 * that state and no error message that suggests one: it looks like a corrupt
 * install of the app rather than a partial download of the runtime.
 *
 * So the unpack happens somewhere else and the directory only appears at its
 * real name once it is complete, in one `rename`.
 */
export async function ensureRuntime(request: InstallRequest): Promise<string> {
  const slot = slotFor(request.target, request.root)
  const { io } = request

  if (io.exists(slot)) return slot

  io.makeDir(request.root)
  const staging = io.scratch(request.root)

  try {
    await request.populate(staging)

    // Re-checked after the download, not only before it. Two launches racing —
    // `npx grndctrl` in two terminals, which is exactly what someone does when
    // the first one seems slow — would otherwise have the loser's `move` fail
    // on a destination that now exists.
    if (io.exists(slot)) return slot

    io.move(staging, slot)
    return slot
  } catch (e) {
    // The staging directory is never left behind. It is unusable to anything
    // and indistinguishable from a complete one to a human looking at the
    // cache.
    io.remove(staging)
    throw e
  }
}

/**
 * Cached runtimes other than the one in use, oldest slot names first.
 *
 * Not deleted automatically. An upgrade leaves the previous runtime on disk and
 * that is the correct default — a downgrade, or a second checkout pinned to an
 * older Electron, then costs nothing. This exists so `grndctrl --prune` can be
 * a thing the operator asks for rather than something that happens to them.
 */
export function stale(keep: CacheTarget, root: string, io: CacheIo): readonly string[] {
  const current = slotName(keep)
  return io
    .list(root)
    .filter((entry) => entry !== current && !entry.startsWith('.'))
    .sort()
}
