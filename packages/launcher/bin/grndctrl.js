#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { cacheRoot, extractorFor, launch, LaunchError, unpackFailure } from '../dist/index.js'

/**
 * `npx grndctrl` (T160).
 *
 * The thin shell: real filesystem, real network, real processes, and nothing
 * else. Every decision — what to download, whether to trust it, whether the
 * runtime matches the native modules, what to say when it does not — is in
 * `src/launch.ts`, where it can be tested without a 100MB download.
 *
 * If this file grows an `if`, it is in the wrong place.
 */

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

const io = {
  exists: (path) => existsSync(path),
  list: (path) => (existsSync(path) ? readdirSync(path) : []),
  makeDir: (path) => mkdirSync(path, { recursive: true }),
  // `renameSync` refuses a non-empty destination on Windows and replaces it on
  // POSIX. `launch.ts` never calls it on an existing destination, and the
  // asymmetry is exactly why it checks rather than relying on the call.
  move: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  scratch: (root) => mkdtempSync(join(root, '.staging-')),

  async bytes(url) {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${url} returned ${response.status}.`)
    return new Uint8Array(await response.arrayBuffer())
  },

  async text(url) {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${url} returned ${response.status}.`)
    return await response.text()
  },

  async unzip(archive, into) {
    mkdirSync(into, { recursive: true })

    // A bare relative name, extracted from `into` as the working directory, so
    // no argument carries a drive letter. GNU tar reads `C:\…` as a remote host
    // spec; keeping colons out of the arguments removes the question.
    const name = '.runtime.zip'
    writeFileSync(join(into, name), archive)

    const extractor = extractorFor(process.platform)

    try {
      await execFileAsync(extractor.command, extractor.args(name, into), {
        cwd: extractor.cwd(into),
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (e) {
      throw new LaunchError(unpackFailure(extractor, e))
    } finally {
      rmSync(join(into, name), { force: true })
    }
  },

  // Linux sandbox detection (T168). `statSync` rather than `access`, because
  // the question is not "can I read it" but "who owns it and is the setuid bit
  // set" — the two things Chromium checks before it will use the helper.
  fileOwner(path) {
    try {
      const stats = statSync(path)
      return { uid: stats.uid, mode: stats.mode & 0o7777 }
    } catch {
      return null
    }
  },

  readSmallFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // A `/proc` knob that is absent is not a denial — it means this kernel
      // does not have that switch. `sandbox.ts` distinguishes the two.
      return null
    }
  },

  async run(file, args, env) {
    const { stdout } = await execFileAsync(file, args, { env, timeout: 30_000 })
    return stdout
  },

  spawn(executable, args, env) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env, stdio: 'inherit', detached: false })
      child.on('error', reject)
      child.on('exit', (code, signal) => resolve(signal === null ? (code ?? 0) : 1))
    })
  },
}

/**
 * What this build of the app needs, read from the desktop package rather than
 * duplicated here.
 *
 * `native/manifest.json` is written by `scripts/fetch-native.mjs` at the moment
 * the native binding is fetched, so the ABI recorded is the ABI of the file
 * actually sitting on disk — not a number someone typed that agrees with it
 * until it does not.
 */
function requirements() {
  const desktop = dirname(require.resolve('@grndctrl/desktop/package.json'))
  const manifestPath = join(desktop, 'native', 'manifest.json')

  if (!existsSync(manifestPath)) {
    throw new LaunchError(
      'This install is incomplete: the native module manifest is missing.\n\n' +
        `  expected ${manifestPath}\n\n` +
        'Reinstall with `npx grndctrl@latest`. If you are running from a checkout, ' +
        'run `npm run native --workspace=@grndctrl/desktop` first.',
    )
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { electronVersion: manifest.electronVersion, abi: manifest.abi, appPath: desktop }
}

try {
  const code = await launch({
    app: requirements(),
    cacheRoot: cacheRoot(),
    platform: process.platform,
    arch: process.arch,
    io,
    argv: process.argv.slice(2),
    onProgress: (message) => process.stderr.write(`${message}\n`),
  })
  process.exit(code)
} catch (e) {
  // A situation the launcher understood gets its sentence and nothing else. A
  // stack trace here would tell the reader the program broke, and it did not.
  if (e instanceof LaunchError || e?.presentable === true) {
    process.stderr.write(`${e.message}\n`)
    process.exit(1)
  }
  throw e
}
