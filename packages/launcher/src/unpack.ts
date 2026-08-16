/**
 * Getting an Electron zip onto disk (T160, T166).
 *
 * There is no obvious right answer here and the obvious wrong one was tried
 * first: `tar -xf`. It fails twice over on the machine this is developed on.
 *
 *  - **`tar` on PATH is not the `tar` you meant.** In Git Bash, in an MSYS
 *    shell, and on most Linux installs it is GNU tar, which reads `C:\Users\…`
 *    as a *remote host spec* and reports `tar: Cannot connect to C: resolve
 *    failed` — a drive letter parsed as a hostname, the same defect this
 *    project fixed in `canonicalRemote` on the same day.
 *  - **GNU tar cannot read zip at all**, whatever the path looks like. It
 *    answers `This does not look like a tar archive`. Only bsdtar
 *    (`libarchive`) reads zip, and on Windows that is the `tar.exe` in
 *    `System32` — which the PATH may or may not reach first.
 *
 * So the extractor is *chosen*, not assumed, and it is chosen by absolute path
 * where one exists.
 *
 * ## Why not a JavaScript unzip
 *
 * It would remove the platform dependency, and it was rejected for the reason
 * that matters more: on macOS and Linux the archive carries an executable bit
 * and, in the `.app` bundle, symlinks. Several npm zip libraries drop both. The
 * result is a runtime that unpacks perfectly and cannot be executed — which
 * reads as a corrupt download and is not one. It would also add a dependency to
 * the one component whose whole argument is that it has none.
 */

export interface Extractor {
  command: string
  args: (archive: string, into: string) => string[]
  /** Run from here, so no argument has to carry a drive letter. */
  cwd: (into: string) => string
  /** What to say when the command is not on the machine at all. */
  missing: string
}

/**
 * The extractor for a platform.
 *
 * `env` is read rather than assumed for `SystemRoot`: it is `C:\Windows` on
 * every machine anyone has, and it is not guaranteed to be, and hard-coding it
 * is how a tool breaks on a locked-down corporate image.
 */
export function extractorFor(plat: string, env: NodeJS.ProcessEnv = process.env): Extractor {
  if (plat === 'win32') {
    const root = env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'
    return {
      // By absolute path. `tar` on PATH in a developer's shell is very often
      // GNU tar, which cannot read a zip and blames the drive letter.
      command: `${root}\\System32\\tar.exe`,
      args: (archive) => ['-xf', archive],
      cwd: (into) => into,
      missing:
        'Windows ships the extractor this needs (bsdtar, at System32\\tar.exe) on Windows 10 ' +
        'build 17063 and later. This machine does not appear to have it.',
    }
  }

  return {
    // macOS and Linux: `unzip` rather than `tar`, because GNU tar does not read
    // zip and `unzip` preserves the executable bit and the symlinks inside
    // `Electron.app`.
    command: 'unzip',
    args: (archive) => ['-oq', archive],
    cwd: (into) => into,
    missing:
      'This needs `unzip`, which is not installed. Install it and try again ' +
      '(`apt install unzip`, `dnf install unzip`, or your distribution’s equivalent).',
  }
}

/**
 * Turn a spawn failure into something that names the cause.
 *
 * `ENOENT` from a child process says `spawn unzip ENOENT`, which reads as a
 * problem with the download rather than with the machine. It is the difference
 * between a person installing a package and a person filing a bug.
 */
export function unpackFailure(extractor: Extractor, error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return extractor.missing

  const detail = error instanceof Error ? error.message : String(error)
  return `Could not unpack the Electron runtime with ${extractor.command}.\n\n  ${detail}`
}
