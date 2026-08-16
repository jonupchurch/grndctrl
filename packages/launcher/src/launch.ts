import { abiMismatch, probeRuntime, type ProbeIo, type RuntimeIdentity } from './abi.js'
import { ensureRuntime, slotFor, type CacheIo, type CacheTarget } from './cache.js'
import { executablePath, fetchRuntime, type DownloadIo } from './runtime.js'

/**
 * What `npx grndctrl` actually does, with every piece of I/O passed in (T160).
 *
 * The bin is the thin shell around this: real `fs`, real `fetch`, real
 * `spawn`. Everything with an opinion lives here, because the ordering is the
 * part that has to be right and the ordering is invisible in a bin script that
 * reads like a list of awaits.
 *
 * Three rules, in order of how badly they fail:
 *
 * 1. **Nothing is extracted before its checksum verifies** (`runtime.ts`).
 * 2. **Nothing is spawned before its ABI is checked.** A runtime that fails the
 *    check must not be launched "to see what happens" — what happens is a
 *    window that never appears and a `dlopen` error in a console the operator
 *    is not looking at.
 * 3. **A download that fails leaves no cache entry** (`cache.ts`).
 */

export interface AppRequirements {
  /** The Electron version this build of the app was assembled against. */
  electronVersion: string
  /** `NODE_MODULE_VERSION` the bundled native modules were built for. */
  abi: string
  /** The directory containing the app's `package.json` — what Electron is given. */
  appPath: string
}

export interface LaunchIo extends CacheIo, DownloadIo, ProbeIo {
  /** Replace this process with the app, or run it to completion. */
  spawn(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number>
}

export interface LaunchRequest {
  app: AppRequirements
  cacheRoot: string
  platform: string
  arch: string
  io: LaunchIo
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  onProgress?: (message: string) => void
}

export class LaunchError extends Error {
  /**
   * Printed as-is, with no stack and no `Error:` prefix.
   *
   * The distinction matters at a terminal: a stack trace tells the reader that
   * the program broke, and every message this class carries is one where the
   * program worked correctly and the *situation* is wrong. Those want different
   * presentation.
   */
  readonly presentable = true
}

export async function launch(request: LaunchRequest): Promise<number> {
  const { app, io } = request
  const say = request.onProgress ?? (() => {})
  const env = request.env ?? process.env

  const target: CacheTarget = {
    version: app.electronVersion,
    platform: request.platform,
    arch: request.arch,
  }

  const slot = slotFor(target, request.cacheRoot)
  const firstRun = !io.exists(slot)

  if (firstRun) {
    // The only moment this command is slow, so it is the only moment it says
    // anything. A silent minute reads as a hang, and the reflex is Ctrl-C —
    // which used to leave a half-unpacked cache entry that broke every later
    // launch.
    say(`Downloading the Electron ${app.electronVersion} runtime (about 100 MB, once).`)
  }

  const dir = await ensureRuntime({
    target,
    root: request.cacheRoot,
    io,
    populate: (into) =>
      fetchRuntime({
        target,
        into,
        io,
        onProgress: (stage) => say(STAGES[stage]),
      }),
  })

  const executable = executablePath(dir, request.platform)

  // Before the spawn, always — not only on a first run. A cache populated by an
  // older build of Ground Control is exactly the case where the versions agree
  // and the ABI does not, and it is the one a first-run-only check would miss
  // every time.
  const actual = await probeRuntime(executable, io, env)
  const expected: RuntimeIdentity = {
    abi: app.abi,
    describe: `Electron ${app.electronVersion}`,
  }

  const problem = abiMismatch({ expected, actual, cacheDir: dir })
  if (problem !== null) throw new LaunchError(problem)

  // `ELECTRON_RUN_AS_NODE` is stripped rather than left alone. The probe above
  // sets it deliberately; an *ambient* one — exported by an editor, a CI runner
  // or an agent harness — turns this spawn into a Node process that evaluates
  // the main script with no `app` object, and the error names `setPath` rather
  // than the variable. This project has lost time to it twice.
  const clean = { ...env }
  delete clean['ELECTRON_RUN_AS_NODE']
  delete clean['ELECTRON_NO_ATTACH_CONSOLE']

  return io.spawn(executable, [app.appPath, ...(request.argv ?? [])], clean)
}

const STAGES: Record<'checksums' | 'download' | 'verify' | 'unpack', string> = {
  checksums: 'Fetching checksums…',
  download: 'Downloading…',
  verify: 'Verifying checksum…',
  unpack: 'Unpacking…',
}
