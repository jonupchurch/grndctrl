import { describe, expect, it } from 'vitest'
import { extractorFor, unpackFailure } from '../src/unpack.js'

/**
 * Choosing an extractor (T166).
 *
 * Every assertion here exists because the first implementation — `tar -xf` with
 * absolute paths — failed on the machine this is developed on, in a way that
 * blamed the download rather than the tool:
 *
 *   tar: Cannot connect to C: resolve failed
 *
 * That is GNU tar reading a drive letter as a remote host. The same defect,
 * found the same day, in `canonicalRemote`. And fixing the path would not have
 * been enough: GNU tar cannot read a zip archive at all, whatever the path
 * looks like.
 */

describe('on Windows', () => {
  it('uses System32 by absolute path, not whatever `tar` resolves to', () => {
    // `tar` on PATH in Git Bash, in an MSYS shell, or anywhere the user has
    // installed GNU coreutils is GNU tar — which cannot read zip. The one that
    // can is bsdtar, shipped in System32 since Windows 10 build 17063.
    const extractor = extractorFor('win32', { SystemRoot: 'C:\\Windows' })

    expect(extractor.command).toBe('C:\\Windows\\System32\\tar.exe')
    expect(extractor.command).not.toBe('tar')
  })

  it('reads SystemRoot rather than assuming it', () => {
    // It is `C:\Windows` on every machine anyone has, and it is not guaranteed
    // to be. Hard-coding it is how a tool breaks on a locked-down image.
    expect(extractorFor('win32', { SystemRoot: 'D:\\Windows' }).command).toBe(
      'D:\\Windows\\System32\\tar.exe',
    )
    expect(extractorFor('win32', { windir: 'E:\\WinNT' }).command).toBe(
      'E:\\WinNT\\System32\\tar.exe',
    )
    expect(extractorFor('win32', {}).command).toBe('C:\\Windows\\System32\\tar.exe')
  })
})

describe('on macOS and Linux', () => {
  it('uses unzip rather than tar', () => {
    // GNU tar is what `tar` means on Linux and it does not read zip. `unzip`
    // also preserves the executable bit and the symlinks inside `Electron.app`,
    // which several JavaScript zip libraries silently drop — producing a
    // runtime that unpacks perfectly and cannot be executed.
    for (const plat of ['linux', 'darwin', 'freebsd']) {
      expect(extractorFor(plat).command).toBe('unzip')
      expect(extractorFor(plat).args('.runtime.zip', '/cache/slot')).toEqual([
        '-oq',
        '.runtime.zip',
      ])
    }
  })
})

describe('the arguments', () => {
  it('never carry a drive letter', () => {
    // The actual fix for the original failure, and it is worth stating as a
    // property rather than as a path: a colon in an argument is what GNU tar
    // reads as `host:path`. Extracting from the destination directory as the
    // working directory removes the question on every platform at once.
    for (const plat of ['win32', 'darwin', 'linux']) {
      const extractor = extractorFor(plat, { SystemRoot: 'C:\\Windows' })
      const args = extractor.args('.runtime.zip', 'C:\\Users\\Jon\\cache\\33.4.11-win32-x64')

      expect(args.some((a) => a.includes(':'))).toBe(false)
      expect(extractor.cwd('C:\\Users\\Jon\\cache\\slot')).toBe('C:\\Users\\Jon\\cache\\slot')
    }
  })
})

describe('when the extractor is not there', () => {
  it('names the thing to install, rather than reporting a spawn error', () => {
    // `spawn unzip ENOENT` reads as a problem with the download. It is the
    // difference between a person installing a package and a person filing a
    // bug.
    const message = unpackFailure(extractorFor('linux'), Object.assign(new Error('x'), {
      code: 'ENOENT',
    }))

    expect(message).toMatch(/unzip/)
    expect(message).toMatch(/apt install unzip/)
    expect(message).not.toMatch(/ENOENT/)
  })

  it('says which Windows version ships it', () => {
    const message = unpackFailure(
      extractorFor('win32', { SystemRoot: 'C:\\Windows' }),
      Object.assign(new Error('x'), { code: 'ENOENT' }),
    )

    expect(message).toMatch(/17063/)
  })

  it('passes any other failure through with the command that produced it', () => {
    const message = unpackFailure(extractorFor('linux'), new Error('End-of-central-directory'))

    expect(message).toContain('unzip')
    expect(message).toContain('End-of-central-directory')
  })
})
