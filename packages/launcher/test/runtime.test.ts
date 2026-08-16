import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assetName,
  assetUrl,
  checksumUrl,
  digestFor,
  executablePath,
  fetchRuntime,
  sha256,
  type DownloadIo,
} from '../src/runtime.js'

/**
 * Fetching and verifying the Electron runtime (T161).
 *
 * `npx grndctrl` downloads about 100MB of executable code and then runs it,
 * which makes this the most dangerous thing the product does. The property that
 * matters is an ordering one and it is easy to lose while refactoring:
 * **nothing is extracted before it verifies.** Verifying afterwards would mean a
 * malicious archive had already written wherever its entries pointed.
 */

/**
 * The message a promise rejected with.
 *
 * Written out because `p.catch(e => e)` types as `T | Error` and every property
 * access on it then needs a cast — which is how a test ends up asserting
 * against `undefined` and passing.
 */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('expected the promise to reject, and it resolved')
}

const TARGET = { version: '33.4.11', platform: 'win32', arch: 'x64' }
const ARCHIVE = new TextEncoder().encode('pretend this is 100MB of Electron')
const DIGEST = createHash('sha256').update(ARCHIVE).digest('hex')

interface Recorded extends DownloadIo {
  unzipped: { into: string; bytes: number }[]
  fetched: string[]
}

function io(options: { shasums?: string; archive?: Uint8Array } = {}): Recorded {
  const unzipped: { into: string; bytes: number }[] = []
  const fetched: string[] = []

  return {
    unzipped,
    fetched,
    text: async (url) => {
      fetched.push(url)
      return options.shasums ?? `${DIGEST} *${assetName(TARGET)}\n`
    },
    bytes: async (url) => {
      fetched.push(url)
      return options.archive ?? ARCHIVE
    },
    unzip: async (archive, into) => {
      unzipped.push({ into, bytes: archive.length })
    },
  }
}

describe('the SHASUMS256 parse', () => {
  it('reads the binary-mode marker as punctuation, not as part of the name', () => {
    // `shasum` writes `<digest> *<file>` in binary mode. Reading the `*` as
    // part of the filename makes every lookup miss — and the natural next step
    // is to make a miss non-fatal, which turns this whole file into decoration.
    const shasums = [
      'aaaa0000000000000000000000000000000000000000000000000000000000aa *electron-v33.4.11-darwin-arm64.zip',
      `${DIGEST} *electron-v33.4.11-win32-x64.zip`,
      'bbbb0000000000000000000000000000000000000000000000000000000000bb *SHASUMS256.txt',
    ].join('\n')

    expect(digestFor(shasums, 'electron-v33.4.11-win32-x64.zip')).toBe(DIGEST)
  })

  it('reads text mode too, and trims a CRLF line ending', () => {
    // The file is served over HTTP and can arrive with either ending; on
    // Windows a `\r` on the end of the name makes every comparison fail.
    expect(digestFor(`${DIGEST}  some-file.zip\r\n`, 'some-file.zip')).toBe(DIGEST)
  })

  it('returns null rather than a near-match', () => {
    const shasums = `${DIGEST} *electron-v33.4.11-win32-arm64.zip\n`

    // A different arch's line must not satisfy a lookup for ours. This is the
    // one place a "close enough" match would install an executable that cannot
    // run and report success.
    expect(digestFor(shasums, 'electron-v33.4.11-win32-x64.zip')).toBeNull()
    expect(digestFor('', 'anything.zip')).toBeNull()
    expect(digestFor('not a checksum file at all', 'anything.zip')).toBeNull()
  })
})

describe('fetching', () => {
  it('asks for the checksums before the archive', async () => {
    const recorder = io()
    await fetchRuntime({ target: TARGET, into: '/cache/slot', io: recorder })

    // Order, not just presence. Discovering there is no published checksum
    // after a 100MB download means holding an unverifiable archive while
    // deciding what to do with it, and the tempting decision is the wrong one.
    expect(recorder.fetched[0]).toBe(checksumUrl(TARGET))
    expect(recorder.fetched[1]).toBe(assetUrl(TARGET))
  })

  it('unpacks a verified archive', async () => {
    const recorder = io()
    await fetchRuntime({ target: TARGET, into: '/cache/slot', io: recorder })

    expect(recorder.unzipped).toEqual([{ into: '/cache/slot', bytes: ARCHIVE.length }])
  })

  it('extracts nothing when the checksum does not match', async () => {
    const recorder = io({ archive: new TextEncoder().encode('something else entirely') })

    await expect(
      fetchRuntime({ target: TARGET, into: '/cache/slot', io: recorder }),
    ).rejects.toThrow(/Checksum mismatch/)

    // The assertion the file exists for.
    expect(recorder.unzipped).toEqual([])
  })

  it('names both digests, so a repeat is recognisable', async () => {
    const recorder = io({ archive: new TextEncoder().encode('something else entirely') })
    const message = await failureOf(fetchRuntime({ target: TARGET, into: '/x', io: recorder }))

    expect(message).toContain(DIGEST)
    expect(message).toContain(sha256(new TextEncoder().encode('something else entirely')))
    expect(message).toMatch(/Nothing has been installed/)
  })

  it('extracts nothing when no checksum is published for this platform', async () => {
    const recorder = io({ shasums: `${DIGEST} *electron-v33.4.11-linux-arm64.zip\n` })

    // "No checksum for this file" and "this file matches its checksum" must not
    // reach the same outcome. The message says which platform was asked for,
    // because the usual cause is a real one: Electron does not ship every
    // arch for every release.
    await expect(fetchRuntime({ target: TARGET, into: '/x', io: recorder })).rejects.toThrow(
      /will not install a runtime it cannot verify/,
    )
    expect(recorder.unzipped).toEqual([])
    expect(recorder.fetched).toHaveLength(1)
  })

  it('builds both URLs from one version string', async () => {
    // Two URLs derived separately is how a checksum file from one release ends
    // up vouching for an archive from another.
    expect(assetUrl(TARGET)).toBe(
      'https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-win32-x64.zip',
    )
    expect(checksumUrl(TARGET)).toBe(
      'https://github.com/electron/electron/releases/download/v33.4.11/SHASUMS256.txt',
    )
  })

  it('reports its stages, because a silent minute reads as a hang', async () => {
    const stages: string[] = []
    await fetchRuntime({
      target: TARGET,
      into: '/x',
      io: io(),
      onProgress: (stage) => stages.push(stage),
    })

    expect(stages).toEqual(['checksums', 'download', 'verify', 'unpack'])
  })
})

describe('the executable inside', () => {
  it('knows where each platform puts it', () => {
    // macOS is a path *into* a bundle rather than a file beside the others,
    // which is the whole reason this is a function.
    expect(executablePath('/c/33', 'win32')).toBe('/c/33/electron.exe')
    expect(executablePath('/c/33', 'darwin')).toBe('/c/33/Electron.app/Contents/MacOS/Electron')
    expect(executablePath('/c/33', 'linux')).toBe('/c/33/electron')
  })
})
