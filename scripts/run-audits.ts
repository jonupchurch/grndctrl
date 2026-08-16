import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditDirectory, passed as secretsPassed, report as secretsReport } from './audit-secrets.ts'
import { audit as auditDeps, flatten, report as depsReport, type Package } from './audit-deps.ts'
import {
  auditEgress,
  hostsInFiles,
  readCapture,
  passed as egressPassed,
  report as egressReport,
} from './audit-egress.ts'
import {
  auditSources,
  parseDenylist,
  passed as clientPassed,
  report as clientReport,
  type Source,
} from './audit-client-refs.ts'

/**
 * The privacy audits, run against this machine (T169–T171).
 *
 *   node --experimental-strip-types scripts/run-audits.ts deps
 *   node --experimental-strip-types scripts/run-audits.ts egress [--log <file>] [--first-run]
 *   node --experimental-strip-types scripts/run-audits.ts secrets --secret <value> [--identity <email>]
 *
 * `secrets` is the one that needs a real credential, because the whole point is
 * to search for a value that is genuinely stored — auditing for one the app has
 * never held proves nothing.
 *
 * **Prefer `--connection <id>` to `--secret <value>`.** The first reads the
 * token from the keychain inside this process and never lets it out; the second
 * puts a live credential into shell history, into any terminal capture, and
 * into whatever is scrolling past. An earlier version of this file argued the
 * opposite — that taking it on the command line kept the script from having a
 * reason to hold a secret — which had the threat model backwards: the script
 * already never prints it, and a command line is the least private place on the
 * machine to put one.
 *
 * Every audit prints its own report and exits non-zero on a failure, so the
 * whole set is one line in CI when someone wants it there.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const has = (name: string): boolean => process.argv.includes(`--${name}`)

function runDeps(): boolean {
  // `--omit=dev` is the whole point: a contributor installs eslint and
  // playwright, a user does not, and auditing the contributor's tree would
  // report findings nobody ships.
  const json = execFileSync('npm', ['ls', '--all', '--omit=dev', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  })

  const packages = flatten(JSON.parse(json)).map((pkg): Package => {
    // `npm ls` does not report lifecycle scripts, so each manifest is read.
    const manifest = join(ROOT, 'node_modules', pkg.name, 'package.json')
    if (!existsSync(manifest)) return pkg
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> }
      return { ...pkg, scripts: parsed.scripts }
    } catch {
      return pkg
    }
  })

  const findings = auditDeps(packages)
  console.log(depsReport(findings, packages.length))
  return findings.length === 0
}

function runEgress(): boolean {
  const log = flag('log')
  const capture =
    log !== undefined && existsSync(log)
      ? readCapture(readFileSync(log, 'utf8'))
      : { loaded: false, processes: 0, hosts: [] }

  // The built artifacts, not the sources: what ships is what can reach out, and
  // a bundler inlines a dependency's URL into them.
  const built = [
    join(ROOT, 'packages/desktop/dist/main/index.cjs'),
    join(ROOT, 'packages/desktop/dist/preload/index.cjs'),
    join(ROOT, 'packages/desktop/dist/renderer/app.js'),
  ].filter(existsSync)

  const providers = (flag('providers') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const result = auditEgress(capture, hostsInFiles(built), {
    providers: providers.length > 0 ? providers : ['atlassian.net', 'github.com'],
    firstRun: has('first-run'),
  })

  console.log(egressReport(result))
  return egressPassed(result)
}

/**
 * The stored credential for a connection, read here and never leaving.
 *
 * Imported lazily so `deps` and `egress` do not need the native keychain
 * binding to run — they are the two that make sense in CI, where there is no
 * keychain at all.
 */
async function fromKeychain(connectionId: string): Promise<string | null> {
  const { Entry } = await import('@napi-rs/keyring')
  const { credentialRef, osKeychain } = await import('@grndctrl/core')

  const store = osKeychain((service, account) => new Entry(service, account))
  return store.get(credentialRef(connectionId))
}

/**
 * The account this connection authenticates as, read from the mirror.
 *
 * Not a guess and not a flag. `base64(identity:secret)` is the encoding that
 * catches a Jira credential in a cached `Authorization: Basic` header, and it
 * only catches it if the identity is *right* — a typed-in address that is one
 * character off produces a check that runs, finds nothing, and proves nothing.
 * A vacuous arm of a security audit is worse than a missing one, because the
 * report still says PASS.
 */
async function identityOf(connectionId: string, dir: string): Promise<string | undefined> {
  try {
    const { openMirror } = await import('@grndctrl/core')
    const { db } = openMirror({ dir })
    try {
      const row = db
        .prepare('SELECT viewer_identity FROM connections WHERE id = ?')
        .get(connectionId) as { viewer_identity?: string } | undefined

      if (row?.viewer_identity === undefined || row.viewer_identity === null) return undefined
      const parsed = JSON.parse(row.viewer_identity) as { email?: string | null }
      return parsed.email ?? undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function runSecrets(): Promise<boolean> {
  const connection = flag('connection')
  let secret = flag('secret')

  if (connection !== undefined && connection !== '') {
    // Read in-process. Nothing prints it, nothing stores it, and it never
    // touches a command line.
    secret = (await fromKeychain(connection)) ?? undefined
    if (secret === undefined || secret === '') {
      console.error(`No credential stored for connection '${connection}'.`)
      console.error('`grndctrl-cli connections` lists the ids this app knows about.')
      return false
    }
  }

  if (secret === undefined || secret === '') {
    console.error('scripts/run-audits.ts secrets --connection <id> [--identity <email>] [--dir <path>]')
    console.error('                             --secret <value>   (discouraged, see below)')
    console.error('')
    console.error('`--connection` reads the token from the keychain inside this process.')
    console.error('`--secret` puts a live credential into your shell history and into')
    console.error('every terminal capture of this session. Prefer the first.')
    return false
  }

  const dir = flag('dir') ?? defaultDataDir()
  if (!existsSync(dir)) {
    console.error(`No data directory at ${dir}. Run the app once, then audit it.`)
    return false
  }

  // Derived from the connection when there is one, so the Basic-auth arm is
  // checking the address the app actually authenticates with.
  const identity =
    flag('identity') ??
    (connection !== undefined && connection !== ''
      ? await identityOf(connection, dir)
      : undefined)

  if (connection !== undefined && identity === undefined) {
    console.log(`Note: connection '${connection}' has no resolved account email, so the`)
    console.log('      base64(identity:secret) form of a Basic auth header is not checked.')
    console.log('      Sync once so the viewer identity is resolved, or pass --identity.')
    console.log('')
  }

  const result = auditDirectory(dir, secret, identity)
  console.log(secretsReport(result))
  return secretsPassed(result)
}

const git = (args: string[], input?: string): string =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 256 * 1024 * 1024,
  })

/** Every file git currently tracks. What a fresh clone would contain. */
function treeSources(): Source[] {
  return git(['ls-files'])
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== DENYLIST_FILE)
    .flatMap((p) => {
      try {
        return [{ path: p, text: readFileSync(join(ROOT, p), 'utf8') }]
      } catch {
        // Binary or unreadable. The tree scan is text-only by design; a PNG
        // cannot carry a hostname anyone will read.
        return []
      }
    })
}

/**
 * Every blob that has ever been committed, on any branch, deduplicated by hash.
 *
 * This is the arm that matters. Scrubbing a file and committing the fix leaves
 * every previous version of it in the object store, reachable by SHA, and on a
 * public repository that is still published — which is exactly the thing this
 * audit exists to catch rather than to assume.
 */
function historySources(rev: string): Source[] {
  // `--all` is the honest default for auditing this machine. A single ref is
  // what the publish workflow wants: the question there is whether the history
  // *being published* is clean, and an unrelated local branch is not part of it.
  const objects = git(['rev-list', '--objects', ...(rev === '--all' ? ['--all'] : [rev])])
    .split('\n')
    .map((line) => {
      const space = line.indexOf(' ')
      return space < 0
        ? { sha: line.trim(), path: '' }
        : { sha: line.slice(0, space).trim(), path: line.slice(space + 1).trim() }
    })
    .filter((o) => o.sha !== '' && o.path !== '' && o.path !== DENYLIST_FILE)

  if (objects.length === 0) return []

  const kinds = git(['cat-file', '--batch-check'], objects.map((o) => o.sha).join('\n') + '\n')
    .split('\n')
    .filter((l) => l.trim() !== '')

  const blobs = new Map<string, string>()
  for (let i = 0; i < kinds.length && i < objects.length; i++) {
    const entry = objects[i]
    if (entry !== undefined && (kinds[i] ?? '').includes(' blob ')) {
      // First path wins. A blob reachable from several commits is one piece of
      // content; naming every path it ever had would multiply one finding.
      if (!blobs.has(entry.sha)) blobs.set(entry.sha, entry.path)
    }
  }

  const sources: Source[] = []
  for (const [sha, path] of blobs) {
    try {
      const text = git(['cat-file', 'blob', sha])
      sources.push({ path: `${sha.slice(0, 7)}:${path}`, text })
    } catch {
      // Unreadable blob — skipped rather than counted clean. The count in the
      // report is of what was actually scanned.
    }
  }
  return sources
}

const DENYLIST_FILE = '.client-denylist'

function runClient(): boolean {
  const inline = process.env['GRNDCTRL_CLIENT_DENYLIST']
  const file = join(ROOT, DENYLIST_FILE)

  const denylist =
    inline !== undefined && inline.trim() !== ''
      ? parseDenylist(inline)
      : existsSync(file)
        ? parseDenylist(readFileSync(file, 'utf8'))
        : null

  const scope = flag('scope') ?? 'all'
  const rev = flag('rev') ?? '--all'
  const sources: Source[] = []
  if (scope === 'tree' || scope === 'all') sources.push(...treeSources())
  if (scope === 'history' || scope === 'all') sources.push(...historySources(rev))

  const result = auditSources(sources, denylist)
  console.log(clientReport(result))
  return clientPassed(result)
}

/** The same rule `@grndctrl/core` uses, restated rather than imported. */
function defaultDataDir(): string {
  const env = process.env
  const override = env['GRNDCTRL_DATA_DIR']
  if (override !== undefined && override.trim() !== '') return override.trim()

  const home = env['USERPROFILE'] ?? env['HOME'] ?? '.'
  if (process.platform === 'win32') {
    return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'grndctrl')
  }
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'grndctrl')
  return join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'grndctrl')
}

const which = process.argv[2]
const runners: Record<string, () => boolean | Promise<boolean>> = {
  deps: runDeps,
  egress: runEgress,
  secrets: runSecrets,
  client: runClient,
}

const runner = which === undefined ? undefined : runners[which]

if (runner === undefined) {
  console.error('usage: run-audits.ts <deps|egress|secrets|client> [options]')
  process.exit(2)
}

process.exit((await runner()) ? 0 : 1)
