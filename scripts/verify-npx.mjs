import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `npx grndctrl` from packed tarballs, on a clean machine (T166-T168).
 *
 * The riskiest path in the project, because it fails on a *user's* machine and
 * not in CI ([research R8](../specs/001-ground-control-v1/research.md)). Until
 * now the only evidence it worked was one person on Windows watching a window
 * appear, which is not something the other two platforms can inherit -- the last
 * hand-run of it found a real bug (GNU tar reading `C:\` as a remote host) that
 * no amount of reading the code had found.
 *
 * A GitHub Actions runner is exactly what the task asks for: a clean machine
 * with an empty runtime cache. What it does not have is somebody watching, so
 * the app reports on itself through `GRNDCTRL_SMOKE` and this script reads the
 * report.
 *
 * ## What a pass here does and does not mean
 *
 * It proves: the tarballs install standalone, the Electron runtime downloads,
 * its checksum verifies against the digest published in the same release, it
 * unpacks into a per-version slot, the ABI check passes, Electron boots, the
 * native module *loads* (`app.status` reaches SQLite), the renderer parses and
 * paints, and a second run downloads nothing.
 *
 * It does not prove the board is correct or that a human would recognise what is
 * on screen. That is verified on Windows, by eye, and is not claimed elsewhere.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const step = (message) => process.stdout.write(`\n=== ${message}\n`)
const note = (message) => process.stdout.write(`    ${message}\n`)

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // npm is a shell script on Windows; without this, spawning it throws EINVAL.
    shell: process.platform === 'win32',
    ...options,
  })
}

function fail(why, detail) {
  process.stderr.write(`\nFAIL - ${why}\n`)
  if (detail !== undefined) process.stderr.write(`${detail}\n`)
  process.exit(1)
}

// --- build -------------------------------------------------------------------

step('Building, including the Electron-ABI native module')
// `native` before `build`: the manifest it writes records the ABI of the binary
// actually on disk, and the launcher reads that rather than a number someone
// typed. Building without it produces a package that cannot describe itself.
run('npm', ['run', 'native', '--workspace=@grndctrl/desktop'], { cwd: ROOT, stdio: 'inherit' })
run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' })

// --- pack --------------------------------------------------------------------

step('Packing tarballs')
const staging = mkdtempSync(join(tmpdir(), 'grndctrl-pack-'))

/** Pack one workspace and return the absolute path of the tarball. */
function pack(workspace) {
  const out = run('npm', ['pack', '--workspace', workspace, '--pack-destination', staging], {
    cwd: ROOT,
  })
  // `npm pack` prints the filename last; earlier lines are notices.
  const name = out.trim().split(/\r?\n/).filter(Boolean).pop()
  const path = join(staging, name)
  if (!existsSync(path)) fail(`npm pack did not produce ${path}`, out)
  note(`${workspace} -> ${name}`)
  return path
}

const desktopTarball = pack('@grndctrl/desktop')
const launcherTarball = pack('grndctrl')

// --- install into a clean directory ------------------------------------------

step('Installing into a clean directory, with an empty runtime cache')
const sandbox = mkdtempSync(join(tmpdir(), 'grndctrl-npx-'))
const cache = join(sandbox, 'runtime-cache')
const data = join(sandbox, 'data')
mkdirSync(cache, { recursive: true })
mkdirSync(data, { recursive: true })

const asFileUrl = (p) => `file:${p.split('\\').join('/')}`

// `overrides` rather than installing both tarballs as top-level dependencies:
// the launcher depends on `@grndctrl/desktop@0.0.0`, which is not on any
// registry, so without this npm goes looking for it and fails in a way that
// reads like a network problem.
writeFileSync(
  join(sandbox, 'package.json'),
  JSON.stringify(
    {
      name: 'grndctrl-npx-verification',
      version: '1.0.0',
      private: true,
      dependencies: { grndctrl: asFileUrl(launcherTarball) },
      overrides: { '@grndctrl/desktop': asFileUrl(desktopTarball) },
    },
    null,
    2,
  ),
)

run('npm', ['install', '--no-audit', '--no-fund'], { cwd: sandbox, stdio: 'inherit' })

const installed = join(sandbox, 'node_modules', '.bin', 'grndctrl')
if (!existsSync(installed) && !existsSync(`${installed}.cmd`)) {
  fail('the `grndctrl` bin was not linked by the install', readdirSync(join(sandbox, 'node_modules', '.bin')).join('\n'))
}

// --- first run ---------------------------------------------------------------

const env = {
  ...process.env,
  GRNDCTRL_SMOKE: '1',
  GRNDCTRL_RUNTIME_CACHE: cache,
  GRNDCTRL_DATA_DIR: data,
}

/**
 * Run the installed bin through npx, capturing both streams.
 *
 * `spawnSync` rather than `execFileSync`, and the distinction is the test.
 * `execFileSync` returns stdout and hands back stderr only by throwing, so on a
 * *successful* run there is no way to see what went to stderr — and the
 * launcher's download progress goes to stderr. The first version of this used
 * `execFileSync` and reported an empty stderr on every passing run, which made
 * the "second run must be silent" assertion vacuous in the one direction that
 * mattered: a second run that re-downloaded would still have looked silent.
 */
function launch(label) {
  step(label)
  const result = spawnSync('npx', ['--no-install', 'grndctrl'], {
    cwd: sandbox,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
    timeout: 15 * 60_000,
  })

  return {
    ok: result.status === 0,
    out: result.stdout ?? '',
    err: result.stderr ?? String(result.error ?? ''),
  }
}

const first = launch('First run - the runtime must download and verify')
process.stdout.write(first.out)
process.stderr.write(first.err)

if (!first.ok) fail('the first `npx grndctrl` did not exit 0', first.err)
if (!first.out.includes('smoke: ok')) {
  fail('the app never reported a successful boot', `${first.out}\n${first.err}`)
}

// The progress messages go to stderr (`onProgress` in bin/grndctrl.js). Their
// presence is what distinguishes a real download from a cache hit, so the second
// run's check below is only meaningful if the first run spoke.
const DOWNLOAD_NOISE = ['Downloading', 'Fetching checksums', 'Verifying checksum', 'Unpacking']
const downloaded = (text) => DOWNLOAD_NOISE.filter((phrase) => text.includes(phrase))

if (downloaded(first.err).length === 0) {
  fail('the first run reported no download, so the runtime cache was not actually empty', first.err)
}

const slots = readdirSync(cache).filter((entry) => !entry.startsWith('.staging-'))
if (slots.length === 0) fail('nothing was written to the runtime cache')
note(`runtime cache holds: ${slots.join(', ')}`)

const leftovers = readdirSync(cache).filter((entry) => entry.startsWith('.staging-'))
if (leftovers.length > 0) {
  fail(`staging directories were left behind: ${leftovers.join(', ')}`)
}

// --- second run --------------------------------------------------------------

const second = launch('Second run - nothing may be downloaded')
process.stdout.write(second.out)

if (!second.ok) fail('the second `npx grndctrl` did not exit 0', second.err)
if (!second.out.includes('smoke: ok')) fail('the second run did not boot', second.err)

// Not "printed nothing" -- "downloaded nothing". On Linux the launcher reports
// which sandbox it selected on every run, and that message is worth keeping:
// an operator running under the namespace sandbox rather than the setuid one
// should be able to discover that without reading the source. Asserting total
// silence here would have forced the choice between a correct message and a
// passing test.
const noise = downloaded(second.err)
if (noise.length > 0) {
  fail(`the second run downloaded again (${noise.join(', ')}), so it did not reuse the cache`, second.err)
}

// --- done --------------------------------------------------------------------

step('PASS')
note('installed from tarballs, runtime downloaded and verified, ABI matched,')
note('the native module loaded, the renderer painted, and the second run reused the cache.')
note('Not proved here: that a human would recognise the board. That is Windows, by eye.')

rmSync(sandbox, { recursive: true, force: true })
rmSync(staging, { recursive: true, force: true })
