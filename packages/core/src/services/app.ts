import { platform, release } from 'node:os'
import type { Database } from 'better-sqlite3'
import { CORE_VERSION } from '../version.js'
import { currentVersion } from '../store/migrate.js'

export interface AppStatus {
  version: string
  platform: string
  osRelease: string
  nodeVersion: string
  dbVersions: { mirror: number; authored: number }
  /**
   * The ABI the process is actually running against.
   *
   * Surfaced as first-class status rather than buried in a log because of the
   * failure it exists to diagnose: a native module built for Node throws at
   * require time under Electron, on a user's machine, with a message naming two
   * version numbers and no remedy (research R8). When that report arrives, this
   * is the first thing worth reading.
   */
  runtimeAbi: {
    modules: string
    electron: string | null
    isElectron: boolean
  }
}

export function appStatus(mirror: Database, authored: Database): AppStatus {
  const versions = process.versions as NodeJS.ProcessVersions & { electron?: string }

  return {
    version: CORE_VERSION,
    platform: platform(),
    osRelease: release(),
    nodeVersion: process.version,
    dbVersions: {
      mirror: currentVersion(mirror),
      authored: currentVersion(authored),
    },
    runtimeAbi: {
      modules: versions.modules,
      electron: versions.electron ?? null,
      isElectron: versions.electron !== undefined,
    },
  }
}
