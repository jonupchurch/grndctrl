/**
 * The native SQLite binding, fetched for *this* machine at first run.
 *
 * ## What went wrong, and why the fix is here rather than in the build
 *
 * v0.1.0 shipped `native/better_sqlite3.node` inside `@grndctrl/desktop`. One
 * tarball goes to every platform, `release.yml` runs on `ubuntu-latest`, and so
 * every user on every operating system received a **Linux x86-64** binary. On
 * Windows it failed at `dlopen` with "is not a valid Win32 application"; the
 * package's own `native/manifest.json` said `"platform": "linux"` and nothing
 * read that field.
 *
 * The packaging matrix did not catch it because each job built a tarball *on*
 * the platform it then tested *on*, so every job's binary happened to match. The
 * combination that actually ships — built on Linux, run on Windows — was the one
 * arrangement never tried.
 *
 * A native addon is specific to (ABI, platform, arch). A single npm tarball is
 * specific to none of them. Those cannot both be true, so the binary has to stop
 * travelling in the tarball. The launcher already downloads a 100 MB Electron
 * runtime for this exact machine on first run; a ~1 MB addon alongside it is the
 * same problem with the same answer, and `@grndctrl/desktop` now ships only a
 * statement of what it needs.
 *
 * ## Trusting the download
 *
 * Unlike Electron, `better-sqlite3` publishes no checksum file with its
 * releases, so there is no equivalent of `SHASUMS256.txt` to verify against.
 * Rather than pretend otherwise, this records the digest of what it fetched into
 * the cache slot and verifies it on every later launch. That protects against a
 * corrupted or truncated cache entry — which is the failure this has actually
 * seen — and it does not protect against a hostile first download. Saying so is
 * the point: a check that cannot do the job it appears to do is worse than an
 * absent one.
 */

/** Everything that decides *which* binary is correct. All four matter. */
export interface NativeTarget {
  /** The `better-sqlite3` version `@grndctrl/desktop` depends on. */
  betterSqlite3: string
  /** `NODE_MODULE_VERSION` of the Electron runtime being launched. */
  abi: string
  platform: string
  arch: string
}

export const BETTER_SQLITE3_RELEASES =
  'https://github.com/WiseLibs/better-sqlite3/releases/download'

/**
 * The name `prebuild-install` would ask for, spelled out rather than delegated.
 *
 * Depending on `prebuild-install` at runtime would mean shipping it, and it
 * resolves the package from the working directory — behaviour that has already
 * cost this project one confused hour. The naming convention is stable and
 * three lines; the dependency is neither.
 */
export function nativeAssetName(target: NativeTarget): string {
  return `better-sqlite3-v${target.betterSqlite3}-electron-v${target.abi}-${target.platform}-${target.arch}.tar.gz`
}

export function nativeAssetUrl(target: NativeTarget, base = BETTER_SQLITE3_RELEASES): string {
  return `${base}/v${target.betterSqlite3}/${nativeAssetName(target)}`
}

/**
 * Cache directory for one exact binary.
 *
 * Keyed on all four axes for the same reason the runtime cache is keyed on
 * version *and* platform *and* arch: a cache keyed on less will happily serve a
 * Linux addon to a Windows launch, which is precisely the bug this file exists
 * to end.
 */
export function nativeSlot(root: string, target: NativeTarget): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')
  return `${root}/native/${safe(target.betterSqlite3)}-electron${safe(target.abi)}-${safe(target.platform)}-${safe(target.arch)}`
}

/**
 * Deliberately not `extends DownloadIo`. That interface carries `unzip` and
 * `text`, which this path has no use for — Electron ships zips with a checksum
 * file, better-sqlite3 ships tarballs with neither. Inheriting them would force
 * every test double to supply two functions it will never call, and a stub that
 * is never called is a stub nobody notices is wrong.
 */
export interface NativeIo {
  /** Fetch a URL. The only network call this module makes. */
  bytes(url: string): Promise<Uint8Array>
  exists(path: string): boolean
  makeDir(path: string): void
  move(from: string, to: string): void
  remove(path: string): void
  scratch(root: string): string
  /** Extract a `.tar.gz` into a directory. */
  untar(archive: Uint8Array, into: string): Promise<void>
  /** Locate the extracted `.node`, wherever the archive chose to put it. */
  find(root: string, filename: string): string | null
  readSmallFile(path: string): string | null
  writeSmallFile(path: string, contents: string): void
  /** Read a file already on disk, for re-verifying a cached binding. */
  readBytes(path: string): Uint8Array | null
  sha256(bytes: Uint8Array): string
}

export interface EnsureNativeRequest {
  target: NativeTarget
  cacheRoot: string
  io: NativeIo
  onProgress?: (message: string) => void
  base?: string
}

const BINDING = 'better_sqlite3.node'
const DIGEST = 'sha256.txt'

/**
 * The path to a usable binding, downloading it once if this machine has not got
 * one yet.
 *
 * Populated through a scratch directory and moved into place, so an interrupted
 * download cannot leave a half-extracted slot that every later launch treats as
 * present. Same rule as the runtime cache, and for the same reason: the failure
 * it prevents is one that persists until a human deletes a directory.
 */
export async function ensureNative(request: EnsureNativeRequest): Promise<string> {
  const { target, io } = request
  const say = request.onProgress ?? (() => {})

  const slot = nativeSlot(request.cacheRoot, target)
  const binding = `${slot}/${BINDING}`
  const digestFile = `${slot}/${DIGEST}`

  if (io.exists(binding)) {
    const recorded = io.readSmallFile(digestFile)
    const onDisk = io.readBytes(binding)
    const actual = onDisk === null ? null : io.sha256(onDisk)

    if (recorded !== null && actual !== null && recorded.trim() === actual) return binding

    // Present but not byte-for-byte what was written. A truncated or
    // partly-copied addon fails at `dlopen` with a message about the *module*,
    // which sends the reader looking at the wrong thing entirely.
    say('The cached SQLite binding is damaged; fetching it again.')
    io.remove(slot)
  }

  const url = nativeAssetUrl(target, request.base)
  say(`Fetching the SQLite binding for ${target.platform}-${target.arch} (about 1 MB, once).`)

  let archive: Uint8Array
  try {
    archive = await io.bytes(url)
  } catch (cause) {
    throw new Error(
      `Could not download the SQLite binding for ${target.platform}-${target.arch}.\n\n` +
        `  ${url}\n\n` +
        `There may be no published build of better-sqlite3 ${target.betterSqlite3} for ` +
        `Electron ABI ${target.abi} on this platform. ${String(cause)}`,
    )
  }

  const staging = io.scratch(request.cacheRoot)
  try {
    await io.untar(archive, staging)

    // `prebuild-install` archives put it under `build/Release/`, but that is a
    // convention rather than a promise — so search rather than assume, and fail
    // loudly if it genuinely is not there.
    const found = io.find(staging, BINDING)
    if (found === null) {
      throw new Error(
        `The downloaded archive did not contain ${BINDING}.\n\n  ${url}\n\n` +
          'This usually means the release asset is not the archive it claims to be.',
      )
    }

    const built = io.scratch(request.cacheRoot)
    io.move(found, `${built}/${BINDING}`)

    // The digest of the extracted binding, not of the archive — this is what
    // gets re-checked on every later launch, so it has to describe the file
    // that will actually be loaded.
    const extracted = io.readBytes(`${built}/${BINDING}`)
    if (extracted === null) {
      throw new Error(`Extracted ${BINDING} but could not read it back at ${built}/${BINDING}.`)
    }
    io.writeSmallFile(`${built}/${DIGEST}`, io.sha256(extracted))

    io.makeDir(dirnameOf(slot))
    if (io.exists(slot)) io.remove(slot)
    io.move(built, slot)
  } finally {
    io.remove(staging)
  }

  return binding
}

function dirnameOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? path : path.slice(0, at)
}

/**
 * A binding that is present but built for a different machine.
 *
 * Only reachable from a checkout, where `npm run native` may have been run under
 * a different platform than the launch — WSL and Windows in the same tree being
 * the obvious way. The published package no longer carries a binary at all, so
 * this cannot happen from `npx`.
 *
 * It exists because v0.1.0's failure mode was a raw `ERR_DLOPEN_FAILED`, and
 * `manifest.json` had recorded `"platform": "linux"` the whole time with nothing
 * reading it. A field written by one side and read by nobody is the shape of
 * almost every defect this project has found.
 */
export function nativePlatformMismatch(
  manifest: { platform?: string; arch?: string } | null,
  actual: { platform: string; arch: string },
): string | null {
  if (manifest === null) return null
  const { platform, arch } = manifest
  if (platform === undefined || arch === undefined) return null
  if (platform === actual.platform && arch === actual.arch) return null

  return [
    'Ground Control cannot start: its SQLite binding was built for a different machine.',
    '',
    `  built for   ${platform}-${arch}`,
    `  running on  ${actual.platform}-${actual.arch}`,
    '',
    'Re-fetch it for this platform:',
    '',
    '  npm run native --workspace=@grndctrl/desktop -- --force',
  ].join('\n')
}
