import { createRequire } from 'node:module'

/**
 * Bind a project to a Jira project.
 *
 *   node scripts/bind-project.mjs --jira IMSUP [--jira BLUEBED ...]
 *
 * The settings screen can do this too and is the supported route. This stays for
 * binding several projects at once, which is a command-line thing to want.
 *
 * Unlike `seed.mjs` this writes to the real data directory by default, because
 * binding a real project is the point. It writes one row per project and
 * truncates nothing.
 *
 * **`--repo` and `--checkout` are gone**, with the providers behind them. There
 * were three legal shapes here — Jira only, repository only, both — and the
 * repository-only one existed so the code half could be exercised before a
 * tracker was reachable. There is one shape now, and a project that names no
 * ticket project is refused by `projects.upsert` rather than being one of them.
 */

const require = createRequire(import.meta.url)
const core = require('@grndctrl/core')
const runtime = require('@grndctrl/core/runtime')
const { Entry } = require('@napi-rs/keyring')

const args = process.argv.slice(2)

/** Every value for a repeatable flag, in the order given. */
const all = (name) =>
  args.flatMap((arg, i) => (arg === name && args[i + 1] !== undefined ? [args[i + 1]] : []))
const one = (name) => all(name)[0]

const keys = all('--jira')
const dir = one('--dir') ?? core.appDataDir()

if (keys.length === 0) {
  console.error('bind-project.mjs --jira <KEY> [--jira <KEY>...] [--dir <path>]')
  process.exit(1)
}

const credentials = core.osKeychain((service, account) => new Entry(service, account))
const services = runtime.createCoreServices({ dir, credentials })

try {
  const jira = services.mirror.listConnections().find((c) => c.kind === 'jira')

  if (jira === undefined) {
    console.error('No Jira connection is configured. Add one in Settings first.')
    process.exit(1)
  }

  // The display name comes from the provider rather than from a flag. A project
  // bound under a name the operator typed from memory is a project that
  // disagrees with every other tool they have open.
  const names = await projectNames(jira, keys)
  const bindings = keys.map((key) => ({ key, code: key, name: names.get(key) }))

  for (const { key, code, name } of bindings) {
    if (name === undefined) {
      console.error(`  ${code.padEnd(10)} not visible to this Jira account — skipped`)
      continue
    }

    const project = services.projects.upsert({
      id: code.toLowerCase(),
      code,
      name,
      // Null rather than a computed index: the palette assigns by sorted
      // position when nothing is pinned, and pinning here would freeze an
      // ordering chosen by the order of these arguments.
      colorIndex: null,
      jiraConnectionId: jira.id,
      jiraProjectKey: key,
      documentationUrl: null,
      statusOverrides: {},
    })

    console.log(`  ${code.padEnd(10)} ${name}`)
    console.log(`  ${' '.repeat(10)} ${project.jiraProjectKey}`)
  }
} finally {
  services.close()
}

/** Resolve display names in one pass, so a bad key is reported before anything is written. */
async function projectNames(connection, wanted) {
  const secret = credentials.get(core.credentialRef(connection.id))
  const auth = Buffer.from(`${connection.accountLabel}:${secret}`).toString('base64')
  const found = new Map()

  for (const key of wanted) {
    const response = await fetch(`https://${connection.siteOrHost}/rest/api/3/project/${key}`, {
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
    })
    if (response.ok) found.set(key, (await response.json()).name)
  }

  return found
}
