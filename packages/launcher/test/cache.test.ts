import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cacheRoot, ensureRuntime, slotFor, slotName, stale, type CacheIo } from '../src/cache.js'

/**
 * The runtime cache (T162).
 *
 * The interesting case is not the hit or the miss. It is the **interrupted
 * miss** — a closed laptop, a dropped connection, a Ctrl-C during the minute
 * this command is slow — because unpacking straight into the final directory
 * leaves something that exists, so every later launch treats it as a hit and
 * fails on a missing file inside it. There is no self-repair from that state
 * and no error that suggests one: it reads as a corrupt install of the app
 * rather than a partial download of the runtime.
 */

const TARGET = { version: '33.4.11', platform: 'win32', arch: 'x64' }
const CACHE = join('/cache')
const SLOT = join(CACHE, '33.4.11-win32-x64')

interface Fake extends CacheIo {
  dirs: Set<string>
  moved: { from: string; to: string }[]
  removed: string[]
}

function fake(existing: readonly string[] = []): Fake {
  const dirs = new Set(existing)
  const moved: { from: string; to: string }[] = []
  const removed: string[] = []
  let n = 0

  return {
    dirs,
    moved,
    removed,
    exists: (path) => dirs.has(path),
    list: (path) =>
      [...dirs]
        .filter((d) => d.startsWith(path + sep) && d !== path)
        .map((d) => d.slice(path.length + 1))
        .filter((d) => !d.includes(sep)),
    makeDir: (path) => void dirs.add(path),
    move: (from, to) => {
      moved.push({ from, to })
      dirs.delete(from)
      dirs.add(to)
    },
    remove: (path) => {
      removed.push(path)
      dirs.delete(path)
    },
    scratch: (root) => {
      n += 1
      const path = join(root, `.staging-${n}`)
      dirs.add(path)
      return path
    },
  }
}

describe('where the cache lives', () => {
  it('is machine-level, not scoped by GRNDCTRL_DATA_DIR', () => {
    // The end-to-end suite gives every spec a fresh data directory — sixty of
    // them in a run. A runtime cached beside the data would be downloaded sixty
    // times, and the operator's real board and a throwaway scratch directory
    // would each carry their own unpacked copy of the same 100MB.
    const env = { LOCALAPPDATA: 'C:\\Users\\Jon\\AppData\\Local', GRNDCTRL_DATA_DIR: 'D:\\scratch' }

    // Built with `join` rather than written out, so this asserts the same thing
    // on the three platforms CI runs. The claim is about which *directory*,
    // not about which separator character the host uses.
    expect(cacheRoot(env, 'win32')).toBe(
      join('C:\\Users\\Jon\\AppData\\Local', 'grndctrl', 'runtime'),
    )
  })

  it('takes its own override, which is a different question', () => {
    // Someone pointing the app at a scratch data directory has said nothing
    // about where a shared runtime should live.
    expect(cacheRoot({ GRNDCTRL_RUNTIME_CACHE: 'E:\\runtimes' }, 'win32')).toBe('E:\\runtimes')
  })

  it('uses each platform’s cache location rather than its data location', () => {
    expect(cacheRoot({ HOME: '/home/jon', XDG_CACHE_HOME: '/home/jon/.cache' }, 'linux')).toBe(
      join('/home/jon/.cache', 'grndctrl', 'runtime'),
    )
    expect(cacheRoot({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe(join('C:\\L', 'grndctrl', 'runtime'))
  })
})

describe('the slot name', () => {
  it('carries version, platform and arch', () => {
    // Version alone breaks on the machine people actually hit it on: an arm64
    // Mac running an x64 Node under Rosetta, or a home directory synced between
    // an Intel and an Apple Silicon machine. The failure is a runtime that
    // unpacks fine and cannot execute, which reads as a corrupt download.
    expect(slotName(TARGET)).toBe('33.4.11-win32-x64')
    expect(slotName({ ...TARGET, arch: 'arm64' })).not.toBe(slotName(TARGET))
    expect(slotName({ ...TARGET, platform: 'darwin' })).not.toBe(slotName(TARGET))
  })

  it('cannot escape the cache directory', () => {
    // `version` comes from a manifest on disk, which is a file rather than a
    // constant.
    // The property is that a slot name is a single path *segment*: no
    // separator can survive it, so `join` cannot be talked into leaving the
    // cache root. The dots themselves are harmless — only a segment that is
    // exactly `..` traverses, and `.._.._etc-win32-x64` is not one.
    expect(slotName({ ...TARGET, version: '../../etc' })).toBe('.._.._etc-win32-x64')
    expect(slotName({ ...TARGET, version: '../../etc' })).not.toMatch(/[\\/]/)
    expect(slotFor({ ...TARGET, version: '../../etc' }, CACHE)).toBe(
      join(CACHE, '.._.._etc-win32-x64'),
    )
  })
})

describe('populating it', () => {
  it('does nothing when the runtime is already there', async () => {
    const io = fake([SLOT])
    let called = false

    const dir = await ensureRuntime({
      target: TARGET,
      root: CACHE,
      io,
      populate: async () => {
        called = true
      },
    })

    expect(dir).toBe(SLOT)
    expect(called).toBe(false)
  })

  it('unpacks somewhere else and moves it into place in one step', async () => {
    const io = fake()
    const unpacked: string[] = []

    const dir = await ensureRuntime({
      target: TARGET,
      root: CACHE,
      io,
      populate: async (into) => void unpacked.push(into),
    })

    // The directory must not appear at its real name until it is complete.
    expect(unpacked[0]).not.toBe(dir)
    expect(io.moved).toEqual([{ from: unpacked[0], to: SLOT }])
    expect(dir).toBe(SLOT)
  })

  it('leaves no cache entry behind when the download fails', async () => {
    const io = fake()

    await expect(
      ensureRuntime({
        target: TARGET,
        root: CACHE,
        io,
        populate: async () => {
          throw new Error('connection reset')
        },
      }),
    ).rejects.toThrow('connection reset')

    // Nothing at the real name — the next launch must see a miss, not a hit on
    // a directory with half a runtime in it.
    expect(io.exists(SLOT)).toBe(false)
    // And nothing at the staging name either: it is unusable to anything and
    // indistinguishable from a complete one to a person looking at the cache.
    expect(io.removed).toHaveLength(1)
    expect(io.dirs.has(io.removed[0] ?? '')).toBe(false)
  })

  it('lets the loser of a race use the winner’s runtime', async () => {
    // `npx grndctrl` in two terminals, which is what someone does when the
    // first one seems to have hung. Without the second existence check the
    // loser's `move` fails on a destination that now exists, and the error is
    // about a rename rather than about anything the operator did.
    const io = fake()

    const dir = await ensureRuntime({
      target: TARGET,
      root: CACHE,
      io,
      populate: async () => {
        io.makeDir(SLOT)
      },
    })

    expect(dir).toBe(SLOT)
    expect(io.moved).toEqual([])
  })
})

describe('older runtimes', () => {
  it('are listed but never removed', () => {
    const io = fake([
      SLOT,
      join(CACHE, '32.1.0-win32-x64'),
      join(CACHE, '33.4.11-win32-arm64'),
      join(CACHE, '.staging-1'),
    ])

    // Not deleted automatically, deliberately: a downgrade, or a second
    // checkout pinned to an older Electron, then costs nothing. This exists so
    // pruning can be something the operator asks for rather than something that
    // happens to them.
    expect(stale(TARGET, CACHE, io)).toEqual(['32.1.0-win32-x64', '33.4.11-win32-arm64'])
    expect(io.removed).toEqual([])
  })
})
