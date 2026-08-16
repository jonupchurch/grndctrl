import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { launch, LaunchError, type LaunchIo } from '../src/launch.js'
import { assetName } from '../src/runtime.js'

/**
 * What `npx grndctrl` actually does, in order (T160).
 *
 * Three rules, and every one of them is an *ordering* property — the kind that
 * survives a refactor by luck rather than by type checking, and whose failure is
 * silent until it is a stranger's bad afternoon:
 *
 * 1. Nothing is extracted before its checksum verifies.
 * 2. Nothing is spawned before its ABI is checked.
 * 3. A download that fails leaves no cache entry.
 */

// Paths are built with `join`, not written out: `slotFor` uses it, so a
// literal would only match on the platform it was typed for. CI runs three.
/** See `runtime.test.ts` — `p.catch(e => e)` types as `T | Error`. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('expected the promise to reject, and it resolved')
}

const CACHE = join('/cache')
const SLOT = join(CACHE, '33.4.11-win32-x64')
const APP = { electronVersion: '33.4.11', abi: '130', appPath: '/app/desktop' }
const TARGET = { version: '33.4.11', platform: 'win32', arch: 'x64' }
const ARCHIVE = new TextEncoder().encode('pretend this is Electron')
const DIGEST = createHash('sha256').update(ARCHIVE).digest('hex')

interface Harness {
  io: LaunchIo
  events: string[]
  dirs: Set<string>
}

function harness(options: { cached?: boolean; runtimeAbi?: string } = {}): Harness {
  const events: string[] = []
  const dirs = new Set<string>(options.cached ? [SLOT] : [])
  const files = new Map<string, string>()
  let n = 0

  const io: LaunchIo = {
    exists: (p) => dirs.has(p),
    list: () => [...dirs],
    makeDir: (p) => void dirs.add(p),
    move: (from, to) => {
      events.push('move')
      dirs.delete(from)
      dirs.add(to)
    },
    remove: (p) => {
      events.push('remove')
      dirs.delete(p)
    },
    scratch: (root) => {
      n += 1
      const p = join(root, `.staging-${n}`)
      dirs.add(p)
      return p
    },

    // These two exist for the Linux sandbox check, and every case in this file
    // launches as `win32`, where `sandboxDecision` returns before it consults
    // either. Answering "not there" rather than throwing keeps that a property
    // of the decision rather than of this double: if the platform guard were
    // ever removed, these would report an unusable helper and no `/proc`, the
    // decision would become a refusal, and these tests would fail — which is
    // the behaviour worth having.
    fileOwner: () => null,
    readSmallFile: () => files.get(join('read', 'small')) ?? null,

    // The native-binding seam. `APP` declares no `betterSqlite3`, so the cases
    // in this file never reach `ensureNative` — these record a call rather than
    // returning something plausible, so that if the launch order ever started
    // fetching unconditionally these tests would say so.
    readBytes: () => null,
    writeSmallFile: () => void events.push('writeSmallFile'),
    sha256: () => 'not-a-digest',
    untar: async () => void events.push('untar'),
    find: () => null,

    text: async () => {
      events.push('checksums')
      return `${DIGEST} *${assetName(TARGET)}\n`
    },
    bytes: async () => {
      events.push('download')
      return ARCHIVE
    },
    unzip: async () => void events.push('unzip'),

    run: async () => {
      events.push('probe')
      return `${options.runtimeAbi ?? '130'} 33.4.11`
    },
    spawn: async () => {
      events.push('spawn')
      return 0
    },
  }

  return { io, events, dirs }
}

const run = (h: Harness, extra: Partial<Parameters<typeof launch>[0]> = {}) =>
  launch({
    app: APP,
    cacheRoot: CACHE,
    platform: 'win32',
    arch: 'x64',
    io: h.io,
    env: { PATH: '/usr/bin' },
    ...extra,
  })

describe('a first run', () => {
  it('verifies, unpacks, checks the ABI, then spawns — in that order', async () => {
    const h = harness()
    expect(await run(h)).toBe(0)

    expect(h.events).toEqual(['checksums', 'download', 'unzip', 'move', 'probe', 'spawn'])
  })

  it('says something, because the download is the only slow moment', async () => {
    // A silent minute reads as a hang, and the reflex is Ctrl-C — which is
    // precisely the interruption the staging directory exists to survive.
    const said: string[] = []
    await run(harness(), { onProgress: (m) => said.push(m) })

    expect(said[0]).toMatch(/Downloading the Electron 33\.4\.11 runtime/)
    expect(said.join('\n')).toMatch(/Verifying checksum/)
  })
})

describe('a later run', () => {
  it('skips the download entirely', async () => {
    const h = harness({ cached: true })
    await run(h)

    expect(h.events).toEqual(['probe', 'spawn'])
  })

  it('still checks the ABI', async () => {
    // The case a first-run-only check misses every time: a cache populated by
    // an older build of Ground Control, where the version agrees and the ABI
    // does not.
    const h = harness({ cached: true, runtimeAbi: '127' })

    await expect(run(h)).rejects.toThrow(/cannot start/)
    expect(h.events).toEqual(['probe'])
  })

  it('says nothing when there is nothing to wait for', async () => {
    const said: string[] = []
    await run(harness({ cached: true }), { onProgress: (m) => said.push(m) })

    expect(said).toEqual([])
  })
})

describe('when the runtime is wrong', () => {
  it('does not spawn it to see what happens', async () => {
    // What happens is a window that never appears and a `dlopen` error in a
    // console the operator is not looking at.
    const h = harness({ runtimeAbi: '127' })

    await expect(run(h)).rejects.toThrow(LaunchError)
    expect(h.events).not.toContain('spawn')
  })

  it('names the cached directory it wants deleted', async () => {
    const message = await failureOf(run(harness({ runtimeAbi: '127' })))

    expect(message).toContain(SLOT)
  })

  it('is presentable, so the bin prints it without a stack', async () => {
    const error = (await run(harness({ runtimeAbi: '127' })).catch((e) => e)) as LaunchError

    expect(error.presentable).toBe(true)
  })
})

describe('the environment the app is given', () => {
  it('strips ELECTRON_RUN_AS_NODE', async () => {
    // Set by some editors and agent runtimes. It makes `electron.exe` behave as
    // plain Node, so the app evaluates its main script with no `app` object and
    // fails at `setPath` — an error that names neither Electron nor the
    // variable. This project has lost time to it twice.
    let given: NodeJS.ProcessEnv = {}
    const h = harness({ cached: true })
    const io: LaunchIo = {
      ...h.io,
      spawn: async (_exe, _args, env) => {
        given = env
        return 0
      },
    }

    await launch({
      app: APP,
      cacheRoot: CACHE,
      platform: 'win32',
      arch: 'x64',
      io,
      env: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    })

    expect(given['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(given['ELECTRON_NO_ATTACH_CONSOLE']).toBeUndefined()
    expect(given['PATH']).toBe('/usr/bin')
  })

  it('passes the app directory first, then the user’s own arguments', async () => {
    let args: readonly string[] = []
    const h = harness({ cached: true })
    const io: LaunchIo = {
      ...h.io,
      spawn: async (_exe, a) => {
        args = a
        return 0
      },
    }

    await launch({
      app: APP,
      cacheRoot: CACHE,
      platform: 'win32',
      arch: 'x64',
      io,
      argv: ['--some-flag'],
    })

    expect(args).toEqual(['/app/desktop', '--some-flag'])
  })

  it('returns the app’s exit code', async () => {
    const h = harness({ cached: true })
    const io: LaunchIo = { ...h.io, spawn: async () => 3 }

    expect(
      await launch({ app: APP, cacheRoot: CACHE, platform: 'win32', arch: 'x64', io }),
    ).toBe(3)
  })
})

describe('when the download fails', () => {
  it('leaves no cache entry and never reaches the runtime', async () => {
    const h = harness()
    const io: LaunchIo = {
      ...h.io,
      bytes: async () => {
        throw new Error('connection reset')
      },
    }

    await expect(
      launch({ app: APP, cacheRoot: CACHE, platform: 'win32', arch: 'x64', io }),
    ).rejects.toThrow('connection reset')

    expect(h.dirs.has(SLOT)).toBe(false)
    expect(h.events).not.toContain('spawn')
  })
})
