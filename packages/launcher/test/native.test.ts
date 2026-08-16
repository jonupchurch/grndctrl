import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  ensureNative,
  nativeAssetName,
  nativeAssetUrl,
  nativePlatformMismatch,
  nativeSlot,
  type NativeIo,
  type NativeTarget,
} from '../src/native.js'

/**
 * These exist because v0.1.0 shipped a Linux `better_sqlite3.node` to every
 * platform and nobody found out until `npx grndctrl` was run on Windows.
 *
 * The bug was not that a check failed. It was that the *only* thing tying a
 * binary to a machine — the platform and arch in the package's own manifest —
 * was written by the build and read by nothing. So the first assertion here is
 * the one that would have caught it: the platform has to reach the URL.
 */

const TARGET: NativeTarget = {
  betterSqlite3: '11.10.0',
  abi: '130',
  platform: 'win32',
  arch: 'x64',
}

const ARCHIVE = new TextEncoder().encode('pretend this is a tarball')
const BINDING = new TextEncoder().encode('pretend this is a .node')
const BINDING_DIGEST = createHash('sha256').update(BINDING).digest('hex')

interface Harness {
  io: NativeIo
  events: string[]
  files: Map<string, Uint8Array>
  text: Map<string, string>
}

function harness(options: { present?: boolean; corrupt?: boolean } = {}): Harness {
  const events: string[] = []
  const files = new Map<string, Uint8Array>()
  const text = new Map<string, string>()
  const dirs = new Set<string>()
  let n = 0

  const slot = nativeSlot('/cache', TARGET)
  if (options.present === true) {
    files.set(`${slot}/better_sqlite3.node`, options.corrupt === true ? new Uint8Array([1]) : BINDING)
    text.set(`${slot}/sha256.txt`, BINDING_DIGEST)
    dirs.add(slot)
  }

  const io: NativeIo = {
    exists: (p) => dirs.has(p) || files.has(p),
    makeDir: (p) => void dirs.add(p),
    move: (from, to) => {
      events.push('move')
      const body = files.get(from)
      if (body !== undefined) {
        files.delete(from)
        files.set(to, body)
      }
      // A directory move carries its children, which is how the staging slot
      // becomes the real one.
      for (const [k, v] of [...files]) {
        if (k.startsWith(`${from}/`)) {
          files.delete(k)
          files.set(`${to}/${k.slice(from.length + 1)}`, v)
        }
      }
      for (const [k, v] of [...text]) {
        if (k.startsWith(`${from}/`)) {
          text.delete(k)
          text.set(`${to}/${k.slice(from.length + 1)}`, v)
        }
      }
      dirs.delete(from)
      dirs.add(to)
    },
    remove: (p) => {
      events.push('remove')
      dirs.delete(p)
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k)
      for (const k of [...text.keys()]) if (k === p || k.startsWith(`${p}/`)) text.delete(k)
    },
    scratch: (root) => {
      n += 1
      const p = `${root}/.staging-${n}`
      dirs.add(p)
      return p
    },
    readSmallFile: (p) => text.get(p) ?? null,
    writeSmallFile: (p, c) => void text.set(p, c),
    readBytes: (p) => files.get(p) ?? null,
    sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),

    bytes: async (url) => {
      events.push(`download ${url}`)
      return ARCHIVE
    },
    untar: async (_archive, into) => {
      events.push('untar')
      files.set(`${into}/build/Release/better_sqlite3.node`, BINDING)
    },
    find: (root, filename) => {
      for (const k of files.keys()) if (k.startsWith(`${root}/`) && k.endsWith(`/${filename}`)) return k
      return null
    },
  }

  return { io, events, files, text }
}

describe('choosing which binary to fetch', () => {
  it('puts the platform and arch in the asset name', () => {
    expect(nativeAssetName(TARGET)).toBe(
      'better-sqlite3-v11.10.0-electron-v130-win32-x64.tar.gz',
    )
  })

  it('asks for a different file on a different platform', () => {
    // The assertion v0.1.0 needed. One tarball went to every platform, so there
    // was exactly one binary and no function that could have disagreed.
    const linux = nativeAssetName({ ...TARGET, platform: 'linux' })
    const mac = nativeAssetName({ ...TARGET, platform: 'darwin', arch: 'arm64' })

    expect(nativeAssetName(TARGET)).not.toBe(linux)
    expect(linux).not.toBe(mac)
    expect(mac).toContain('darwin-arm64')
  })

  it('keys the cache on all four axes, so one slot cannot serve two machines', () => {
    const here = nativeSlot('/cache', TARGET)
    for (const other of [
      { ...TARGET, platform: 'linux' },
      { ...TARGET, arch: 'arm64' },
      { ...TARGET, abi: '127' },
      { ...TARGET, betterSqlite3: '12.0.0' },
    ]) {
      expect(nativeSlot('/cache', other)).not.toBe(here)
    }
  })

  it('builds a URL under the better-sqlite3 releases', () => {
    expect(nativeAssetUrl(TARGET)).toBe(
      'https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-electron-v130-win32-x64.tar.gz',
    )
  })
})

describe('fetching it', () => {
  it('downloads, extracts, and records a digest of the binding', async () => {
    const h = harness()
    const path = await ensureNative({ target: TARGET, cacheRoot: '/cache', io: h.io })

    expect(path).toBe(`${nativeSlot('/cache', TARGET)}/better_sqlite3.node`)
    expect(h.events.some((e) => e.startsWith('download'))).toBe(true)
    expect(h.events).toContain('untar')
    expect(h.text.get(`${nativeSlot('/cache', TARGET)}/sha256.txt`)).toBe(BINDING_DIGEST)
  })

  it('downloads the URL for the requested platform, not the running one', async () => {
    const h = harness()
    await ensureNative({ target: { ...TARGET, platform: 'darwin', arch: 'arm64' }, cacheRoot: '/cache', io: h.io })

    const download = h.events.find((e) => e.startsWith('download'))
    expect(download).toContain('darwin-arm64')
    expect(download).not.toContain('win32')
  })

  it('does not download again when a verified binding is cached', async () => {
    const h = harness({ present: true })
    await ensureNative({ target: TARGET, cacheRoot: '/cache', io: h.io })

    expect(h.events.some((e) => e.startsWith('download'))).toBe(false)
  })

  it('re-fetches when the cached binding does not match its recorded digest', async () => {
    // The failure this protects against is a truncated cache entry, which
    // otherwise surfaces at `dlopen` as a complaint about the module itself.
    const h = harness({ present: true, corrupt: true })
    await ensureNative({ target: TARGET, cacheRoot: '/cache', io: h.io })

    expect(h.events.some((e) => e.startsWith('download'))).toBe(true)
  })

  it('fails loudly when the archive has no binding in it', async () => {
    const h = harness()
    const io: NativeIo = { ...h.io, untar: async () => {}, find: () => null }

    await expect(ensureNative({ target: TARGET, cacheRoot: '/cache', io })).rejects.toThrow(
      /did not contain better_sqlite3\.node/,
    )
  })

  it('names the platform when there is no published build', async () => {
    const h = harness()
    const io: NativeIo = {
      ...h.io,
      bytes: async () => {
        throw new Error('404')
      },
    }

    const message = await ensureNative({ target: TARGET, cacheRoot: '/cache', io }).catch(
      (e: Error) => e.message,
    )
    expect(message).toContain('win32-x64')
    expect(message).toContain('Electron ABI 130')
  })
})

describe('a local binding built for another machine', () => {
  it('is reported, rather than loaded and left to fail at dlopen', () => {
    const message = nativePlatformMismatch(
      { platform: 'linux', arch: 'x64' },
      { platform: 'win32', arch: 'x64' },
    )

    // The v0.1.0 experience was `ERR_DLOPEN_FAILED ... is not a valid Win32
    // application`, from a package whose own manifest said "linux". Both sides
    // belong in the sentence.
    expect(message).toContain('linux-x64')
    expect(message).toContain('win32-x64')
    expect(message).toContain('npm run native')
  })

  it('says nothing when the platform matches', () => {
    expect(
      nativePlatformMismatch({ platform: 'win32', arch: 'x64' }, { platform: 'win32', arch: 'x64' }),
    ).toBeNull()
  })

  it('says nothing when there is no manifest to check', () => {
    expect(nativePlatformMismatch(null, { platform: 'win32', arch: 'x64' })).toBeNull()
  })

  it('does not invent a mismatch from a manifest that omits the fields', () => {
    // An older manifest predates these fields. "Not recorded" is not "wrong" —
    // treating it as a mismatch would break every existing checkout.
    expect(nativePlatformMismatch({}, { platform: 'win32', arch: 'x64' })).toBeNull()
  })
})
