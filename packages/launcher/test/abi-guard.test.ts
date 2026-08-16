import { describe, expect, it } from 'vitest'
import { abiMismatch, probeRuntime, type ProbeIo } from '../src/abi.js'

/**
 * The ABI guard (T165).
 *
 * This is the failure with the longest feedback loop in the product. It cannot
 * happen in CI, because CI runs whatever it just installed; it happens on a
 * stranger's machine, at launch, and the only thing between it and a support
 * conversation is the sentence the guard prints. So the assertions here are
 * about the **sentence**, not about the boolean — a check that fires correctly
 * and says `Error: mismatch` has solved nothing for the person reading it.
 */

const electron33 = { abi: '130', describe: 'Electron 33.4.11' }
const node22 = { abi: '127', describe: 'Node 22.18.0' }

describe('a mismatch', () => {
  it('names both runtimes and both module versions', () => {
    // Not "a version mismatch". Which one it wanted, which one it found, and
    // the numbers — because the numbers are what a search engine matches when
    // the operator inevitably pastes this somewhere.
    const message = abiMismatch({ expected: electron33, actual: node22 }) ?? ''

    expect(message).toContain('Electron 33.4.11')
    expect(message).toContain('Node 22.18.0')
    expect(message).toContain('130')
    expect(message).toContain('127')
  })

  it('does not tell the reader to rebuild', () => {
    // Node's own message says to try `npm rebuild` or `npm install`. That is
    // reasonable advice for a contributor and useless for someone who typed
    // `npx grndctrl`: they have no checkout, no build step and possibly no
    // toolchain, and following it wastes their time before they ask for help.
    const message = abiMismatch({ expected: electron33, actual: node22 }) ?? ''

    expect(message).not.toMatch(/npm rebuild/i)
    expect(message).not.toMatch(/re-?compil/i)
    expect(message).toMatch(/not something you can fix by rebuilding/i)
  })

  it('ends with something to do, and names the directory when it has one', () => {
    const withDir =
      abiMismatch({
        expected: electron33,
        actual: node22,
        cacheDir: 'C:\\Users\\Jon\\AppData\\Local\\grndctrl\\runtime\\33.4.11-win32-x64',
      }) ?? ''

    expect(withDir).toContain('C:\\Users\\Jon\\AppData\\Local\\grndctrl\\runtime\\33.4.11-win32-x64')
    expect(withDir).toMatch(/delete the cached runtime/i)

    // And still says what to do when there is no path to name, rather than
    // trailing off after the diagnosis.
    const without = abiMismatch({ expected: electron33, actual: node22 }) ?? ''
    expect(without).toMatch(/clear the runtime cache/i)
  })

  it('reads as a report rather than a crash', () => {
    const message = abiMismatch({ expected: electron33, actual: node22 }) ?? ''

    expect(message.startsWith('Ground Control cannot start')).toBe(true)
    expect(message).not.toContain('at Object.<anonymous>')
  })
})

describe('a match', () => {
  it('says nothing at all', () => {
    expect(abiMismatch({ expected: electron33, actual: { ...electron33 } })).toBeNull()
  })

  it('compares the module version, not the description', () => {
    // Two runtimes that describe themselves differently but load the same
    // binaries must pass. The ABI is the fact; the description is for a human.
    expect(
      abiMismatch({
        expected: { abi: '130', describe: 'Electron 33.4.11' },
        actual: { abi: '130', describe: 'Electron 33.2.0' },
      }),
    ).toBeNull()
  })
})

describe('asking the runtime what it is', () => {
  const probe = (stdout: string): ProbeIo & { env: NodeJS.ProcessEnv[] } => {
    const env: NodeJS.ProcessEnv[] = []
    return {
      env,
      run: async (_file, _args, e) => {
        env.push(e)
        return stdout
      },
    }
  }

  it('reads the module version and the Electron version', async () => {
    const io = probe('130 33.4.11\n')
    const identity = await probeRuntime('/cache/electron', io)

    expect(identity).toEqual({ abi: '130', describe: 'Electron 33.4.11' })
  })

  it('sets ELECTRON_RUN_AS_NODE, because that is the only way to ask', async () => {
    const io = probe('130 33.4.11')
    await probeRuntime('/cache/electron', io, { PATH: '/usr/bin' })

    // The variable that has cost this project two debugging sessions by being
    // set when nobody wanted it. Here it is the whole mechanism: it makes the
    // Electron binary behave as plain Node, so it can print its own versions
    // without opening a window.
    expect(io.env[0]?.['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(io.env[0]?.['PATH']).toBe('/usr/bin')
  })

  it('refuses to guess when the runtime prints something else', async () => {
    // A truncated download produces a binary that runs and prints a linker
    // error, or nothing. Treating an unreadable answer as "probably fine" is
    // how an unusable runtime gets launched anyway — the same shape as an empty
    // result and a failed result sharing a representation.
    await expect(probeRuntime('/cache/electron', probe(''))).rejects.toThrow(/incomplete/i)
    await expect(probeRuntime('/cache/electron', probe('not found'))).rejects.toThrow(
      /Could not read the runtime/,
    )
  })

  it('still reports the ABI when the Electron version is missing', async () => {
    // The ABI is the part the check needs; the description is decoration. A
    // runtime that answers half the question is still checkable.
    const identity = await probeRuntime('/cache/electron', probe('130'))

    expect(identity.abi).toBe('130')
    expect(identity.describe).toBe('an unknown runtime')
  })
})
