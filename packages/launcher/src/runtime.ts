import { createHash } from 'node:crypto'

/**
 * Fetching the Electron runtime, and refusing to run one we cannot vouch for
 * (T161).
 *
 * `npx grndctrl` downloads roughly 100MB of executable code from the internet
 * and then runs it. That is the single most dangerous thing this product does,
 * and it is worth being precise about what the checksum does and does not buy:
 *
 * - It **does** catch a truncated or corrupted download, which is the common
 *   case and otherwise surfaces as a nonsense error from deep inside the unzip.
 * - It **does** mean an attacker who can rewrite the release asset but not the
 *   checksum file is stopped.
 * - It does **not** stop an attacker who controls both, which is why the
 *   checksum file is fetched from the same release rather than trusted from
 *   somewhere convenient, and why the two URLs are constructed from one
 *   version string rather than passed in separately.
 *
 * The rule that matters more than any of it: **nothing is extracted before it
 * verifies.** Verifying after unpacking would mean a malicious archive had
 * already written wherever its entries pointed.
 */

export const ELECTRON_RELEASES = 'https://github.com/electron/electron/releases/download'

export interface RuntimeTarget {
  version: string
  platform: string
  arch: string
}

/** The release asset for a target. Electron's naming, not ours. */
export function assetName(target: RuntimeTarget): string {
  return `electron-v${target.version}-${target.platform}-${target.arch}.zip`
}

export function assetUrl(target: RuntimeTarget, base = ELECTRON_RELEASES): string {
  return `${base}/v${target.version}/${assetName(target)}`
}

export function checksumUrl(target: RuntimeTarget, base = ELECTRON_RELEASES): string {
  return `${base}/v${target.version}/SHASUMS256.txt`
}

/**
 * Find one file's digest in a `SHASUMS256.txt`.
 *
 * The format is `<64 hex> *<filename>` — the `*` is the "binary mode" marker
 * that `shasum` writes, and it is part of the line rather than part of the
 * name. Reading it as part of the name is the classic way this parse goes
 * wrong: every lookup misses, and the natural next step is to make a miss
 * non-fatal.
 *
 * A miss must stay fatal. "No checksum published for this file" and "this file
 * matches its checksum" cannot be allowed to reach the same outcome — that is
 * the verification equivalent of an empty result and a failed result sharing a
 * representation, and it is the failure that turns this whole file into
 * decoration.
 */
export function digestFor(shasums: string, file: string): string | null {
  for (const line of shasums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
    if (match === null) continue
    if (match[2] === file) return (match[1] ?? '').toLowerCase()
  }
  return null
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface DownloadIo {
  /** Fetch a URL as bytes. Throws on any non-success status. */
  bytes(url: string): Promise<Uint8Array>
  /** Fetch a URL as text. Throws on any non-success status. */
  text(url: string): Promise<string>
  /** Unpack a verified zip archive into a directory. */
  unzip(archive: Uint8Array, into: string): Promise<void>
}

export interface FetchRequest {
  target: RuntimeTarget
  into: string
  io: DownloadIo
  base?: string
  /** Progress, for a command line that would otherwise sit silent for a minute. */
  onProgress?: (stage: 'checksums' | 'download' | 'verify' | 'unpack') => void
}

export async function fetchRuntime(request: FetchRequest): Promise<void> {
  const { target, io } = request
  const base = request.base ?? ELECTRON_RELEASES
  const file = assetName(target)
  const say = request.onProgress ?? (() => {})

  // Checksums first, deliberately. If this release has no published checksum
  // for this platform, the operator finds out in two seconds rather than after
  // a 100MB download — and, more to the point, we never end up holding an
  // archive we cannot verify while deciding what to do about it.
  say('checksums')
  const shasums = await io.text(checksumUrl(target, base))
  const expected = digestFor(shasums, file)

  if (expected === null) {
    throw new Error(
      `No published checksum for ${file} in the Electron ${target.version} release. ` +
        `Ground Control will not install a runtime it cannot verify. ` +
        `Check that ${target.platform}-${target.arch} is a platform Electron ${target.version} ships.`,
    )
  }

  say('download')
  const archive = await io.bytes(assetUrl(target, base))

  say('verify')
  const actual = sha256(archive)
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${file}.\n` +
        `  expected ${expected}\n` +
        `  received ${actual}\n` +
        `The download was corrupted, or the file is not the one Electron published. ` +
        `Nothing has been installed. Try again; if it repeats, do not work around it.`,
    )
  }

  say('unpack')
  await io.unzip(archive, request.into)
}

/**
 * The executable inside an unpacked runtime.
 *
 * Three different answers, and the macOS one is a path *into* a bundle rather
 * than a file beside the others — which is why this is a function and not a
 * template string at the call site.
 */
export function executablePath(dir: string, plat: string): string {
  const sep = '/'
  switch (plat) {
    case 'win32':
      return `${dir}${sep}electron.exe`
    case 'darwin':
      return `${dir}${sep}Electron.app${sep}Contents${sep}MacOS${sep}Electron`
    default:
      return `${dir}${sep}electron`
  }
}
