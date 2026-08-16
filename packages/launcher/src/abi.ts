/**
 * The launch-time ABI check (T164).
 *
 * A native addon is compiled against one `NODE_MODULE_VERSION`. Node 22 is 127;
 * Electron 33 is 130. Load the wrong one and Node says:
 *
 *   Error: The module '…/better_sqlite3.node' was compiled against a different
 *   Node.js version using NODE_MODULE_VERSION 127. This version of Node.js
 *   requires NODE_MODULE_VERSION 130. Please try re-compiling or re-installing
 *   the module (for instance, using `npm rebuild` or `npm install`).
 *
 * Which is not a bad message — for someone who knows what an ABI is, is looking
 * at a project they can rebuild, and has a toolchain. `npx grndctrl` has none of
 * those: the person is not a contributor, there is no build step they can run,
 * and `npm rebuild` is advice that cannot help them. What they need to know is
 * which runtime the app expected, which one it got, and that the fix is a
 * command rather than a compiler.
 *
 * This has the longest feedback loop of anything in the product. It cannot fail
 * in CI — CI has whatever it installed — so it fails at launch, on a machine
 * nobody here can see, and the only thing standing between that and a support
 * conversation is the sentence below.
 *
 * ## Asking rather than tabulating
 *
 * The obvious implementation is a table from Electron major to ABI. It is also
 * wrong within a year: the table is a copy of somebody else's release schedule
 * and it goes stale silently, producing a confident mismatch report about two
 * runtimes that are in fact compatible.
 *
 * So the runtime is asked. `ELECTRON_RUN_AS_NODE=1 electron -p process.versions.modules`
 * makes the Electron binary behave as plain Node and print its own module
 * version. That variable has cost this project two debugging sessions by being
 * set when nobody wanted it; here it is exactly the right tool.
 */

export interface RuntimeIdentity {
  /** `NODE_MODULE_VERSION`, as a string because that is how Node reports it. */
  abi: string
  /** Something a person can act on: `Electron 33.4.11`, `Node 22.18.0`. */
  describe: string
}

export interface AbiCheck {
  /** What the bundled native modules were built against. */
  expected: RuntimeIdentity
  /** What is about to be launched. */
  actual: RuntimeIdentity
  /** Named in the remedy, so the message ends with something to type. */
  cacheDir?: string
}

/**
 * `null` when the runtime is usable; otherwise the message to print and exit on.
 *
 * Returning the message rather than throwing keeps this pure: the test in
 * `test/abi-guard.test.ts` asserts on the sentence itself, which is the part
 * that has to survive — an ABI check that fires correctly and says
 * "Error: mismatch" has solved nothing for the person reading it.
 */
export function abiMismatch(check: AbiCheck): string | null {
  if (check.expected.abi === check.actual.abi) return null

  const lines = [
    'Ground Control cannot start: the runtime does not match its native modules.',
    '',
    `  built for   ${check.expected.describe} (NODE_MODULE_VERSION ${check.expected.abi})`,
    `  launching   ${check.actual.describe} (NODE_MODULE_VERSION ${check.actual.abi})`,
    '',
    'This is not something you can fix by rebuilding — nothing here is compiled',
    'on your machine. The cached runtime is the wrong one, most likely because a',
    'download was interrupted or the cache was populated by a different version',
    'of Ground Control.',
    '',
  ]

  lines.push(
    check.cacheDir === undefined
      ? 'Clear the runtime cache and launch again.'
      : `Delete the cached runtime and launch again:\n\n  ${check.cacheDir}`,
  )

  return lines.join('\n')
}

export interface ProbeIo {
  /**
   * Run a binary and return its stdout, trimmed. Rejects if it cannot run.
   *
   * `ELECTRON_RUN_AS_NODE` has to be set *by the caller of this*, and the
   * ambient value has to be cleared — an editor or agent runtime that exports
   * it turns the launched app into a Node process with no window, which is a
   * failure mode this project has now hit twice.
   */
  run(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string>
}

/**
 * Ask an Electron binary what ABI it is.
 *
 * A failure here is deliberately not swallowed into "assume it is fine": a
 * runtime that cannot be executed at all is a broken cache entry, and finding
 * that out now is better than finding it out as a window that never appears.
 */
export async function probeRuntime(
  executable: string,
  io: ProbeIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeIdentity> {
  const clean = { ...env }
  delete clean['ELECTRON_NO_ATTACH_CONSOLE']

  const out = await io.run(
    executable,
    ['-p', 'process.versions.modules + " " + process.versions.electron'],
    { ...clean, ELECTRON_RUN_AS_NODE: '1' },
  )

  const [abi, electron] = out.trim().split(/\s+/)

  if (abi === undefined || !/^\d+$/.test(abi)) {
    throw new Error(
      `Could not read the runtime at ${executable}. It printed '${out.trim()}' rather than a ` +
        'module version, which usually means the download is incomplete. Clear the runtime ' +
        'cache and launch again.',
    )
  }

  return {
    abi,
    describe: electron === undefined || electron === '' ? 'an unknown runtime' : `Electron ${electron}`,
  }
}
