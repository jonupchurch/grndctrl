import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Electron-ABI build of `better-sqlite3` (T163).
 *
 * A native addon is compiled against one ABI. Node 22 is `NODE_MODULE_VERSION`
 * 127; Electron 33 is 130. Loading the wrong one fails at `dlopen` with a
 * message that reads like a broken install, and this project needs both at
 * once: the suite runs under Node — constitution XVIII requires the engine to be
 * testable with no Electron at all — and the app runs under Electron.
 *
 * The usual answers both hurt. Rebuilding on every switch costs half a minute
 * each way and gets skipped, so the failure shows up in whichever command
 * someone ran second. Rebuilding only for Electron breaks `npm test`.
 *
 * So: leave `node_modules` alone, and put a second copy somewhere the desktop
 * host can point at. `better-sqlite3` takes a `nativeBinding` path, threaded
 * through `createCoreServices`. Neither runtime knows about the other's copy and
 * neither build overwrites the other.
 *
 * The download runs against a scratch directory holding nothing but a
 * `package.json`, because `prebuild-install` extracts into whatever package it
 * is pointed at — and the package it would otherwise be pointed at is the one
 * the test suite is using.
 *
 * This has the longest feedback loop of anything in the project: it fails on a
 * user's machine, at launch, rather than in CI. Which is why it is being done
 * now rather than in Phase 6 where it was scheduled.
 */

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const DEST = join(PKG, 'native', 'better_sqlite3.node')
const MANIFEST = join(PKG, 'native', 'manifest.json')
const REQUIREMENTS = join(PKG, 'native', 'requirements.json')

const better = require('better-sqlite3/package.json')
const electron = require('electron/package.json')

/**
 * What the launcher reads to know which runtime this build needs (T164).
 *
 * Written here rather than declared anywhere, because here is the only place
 * that knows: the ABI recorded is the ABI of the binary that was just fetched,
 * for the platform it was fetched for. A number typed into a config file agrees
 * with the file on disk right up until someone changes one of them.
 *
 * `abi` comes from `process.versions.modules` of the *Electron* release, not of
 * the Node running this script — `prebuild-install` was told `--runtime
 * electron --target <version>`, so that is what the binary matches.
 */
function writeManifest(abi) {
  mkdirSync(dirname(MANIFEST), { recursive: true })
  writeFileSync(
    MANIFEST,
    JSON.stringify(
      {
        electronVersion: electron.version,
        abi,
        platform: process.platform,
        arch: process.arch,
        betterSqlite3: better.version,
      },
      null,
      2,
    ) + '\n',
  )

  // The published half, and the distinction is the whole lesson of v0.1.0.
  //
  // `manifest.json` describes *a file on this machine* — it names a platform and
  // an arch because a compiled binary has them. `requirements.json` states what
  // the app *needs*, which is true on every machine, and it is the only one in
  // `files`. Shipping the first one is what let a Linux binary reach every
  // Windows user with the package's own metadata admitting it.
  writeFileSync(
    REQUIREMENTS,
    JSON.stringify(
      { electronVersion: electron.version, abi, betterSqlite3: better.version },
      null,
      2,
    ) + '\n',
  )
}

/**
 * Ask the installed Electron what module version it is, rather than tabulating
 * it. A table mapping Electron major to ABI is a copy of somebody else's
 * release schedule, and it goes stale without saying so.
 */
function electronAbi() {
  // `electron/cli.js` under Node with `ELECTRON_RUN_AS_NODE=1` runs the real
  // binary as plain Node and prints its module version — the same trick the
  // launcher uses, and the same variable that has twice broken a manual launch
  // by being set when nobody wanted it.
  const out = execFileSync(
    process.execPath,
    [require.resolve('electron/cli.js'), '-p', 'process.versions.modules'],
    { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  )

  const abi = out.trim().split(/\r?\n/).pop() ?? ''
  if (!/^\d+$/.test(abi)) {
    throw new Error(`Could not read Electron's module version; it printed '${out.trim()}'.`)
  }
  return abi
}

if (existsSync(DEST) && !process.argv.includes('--force')) {
  // The manifest is regenerated even on the fast path: a checkout that fetched
  // the binary before this existed has one and not the other, and "the file is
  // present" is not the same claim as "the file is described".
  if (!existsSync(MANIFEST) || !existsSync(REQUIREMENTS)) writeManifest(electronAbi())
  console.log(`native/better_sqlite3.node is present (better-sqlite3 ${better.version}, electron ${electron.version})`)
  console.log('pass --force to fetch it again')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'grndctrl-native-'))

try {
  // Only the fields `prebuild-install` reads: what to fetch, which version, and
  // where the releases live.
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify(
      { name: better.name, version: better.version, repository: better.repository },
      null,
      2,
    ),
  )

  console.log(`fetching better-sqlite3 ${better.version} for electron ${electron.version} …`)

  execFileSync(
    process.execPath,
    [
      require.resolve('prebuild-install/bin.js'),
      '--runtime', 'electron',
      '--target', electron.version,
      '--arch', process.arch,
      '--platform', process.platform,
      '--tag-prefix', 'v',
    ],
    // `cwd`, not `--path`. The flag reads as "install here" and does not: it
    // still resolves the package from the working directory, so running it from
    // the repo root sends prebuild-install looking for a release of
    // `grndctrl-monorepo v0.0.0`.
    { cwd: scratch, stdio: 'inherit' },
  )

  const built = join(scratch, 'build', 'Release', 'better_sqlite3.node')
  if (!existsSync(built)) {
    throw new Error(
      `prebuild-install reported success but produced no binary at ${built}. ` +
        `There may be no published prebuild for electron ${electron.version} on ` +
        `${process.platform}-${process.arch}.`,
    )
  }

  mkdirSync(dirname(DEST), { recursive: true })
  copyFileSync(built, DEST)
  console.log(`wrote ${DEST}`)

  // After the copy, never before: the manifest describes a file, and a manifest
  // that exists without one would let the launcher pass an ABI check against
  // nothing.
  writeManifest(electronAbi())
  console.log(`wrote ${MANIFEST}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
