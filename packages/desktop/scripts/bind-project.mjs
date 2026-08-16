import { createRequire } from 'node:module'

/**
 * Bind a project: a Jira project, a repository, or both.
 *
 * Until the settings screens exist (T153) there is no way to create a project
 * binding from inside the application, and without a binding the board has
 * nothing to correlate — every ticket falls through to the dangling pile. This
 * is the stopgap, and it is deliberately the *only* thing it does.
 *
 *   node scripts/bind-project.mjs --jira IMSUP [--jira BLUEBED ...]
 *   node scripts/bind-project.mjs --repo owner/name [--checkout <path>]
 *   node scripts/bind-project.mjs --jira IMSUP --repo owner/name --checkout <path>
 *
 * Unlike `seed.mjs` this writes to the real data directory by default, because
 * binding a real project is the point. It writes one row per project and
 * truncates nothing.
 *
 * Every binding field on `Project` is nullable, so all three shapes are legal.
 * A repository with no Jira project is how the code half gets exercised before
 * a ticket tracker is reachable; per-provider degradation is a first class
 * state rather than an error, so the ticket side reports as absent (XV).
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
const repo = one('--repo')
const checkouts = all('--checkout')
const dir = one('--dir') ?? core.appDataDir()

if (keys.length === 0 && repo === undefined) {
  console.error('bind-project.mjs [--jira <KEY>...] [--repo owner/name] [--checkout <path>] [--dir <path>]')
  process.exit(1)
}

if (keys.length > 1 && repo !== undefined) {
  console.error(
    'One --repo cannot be shared across several --jira projects here.\n' +
      'A repository may legitimately serve several projects, but binding them in one\n' +
      'command hides which one you meant. Run it once per project.',
  )
  process.exit(1)
}

const parsedRepo = repo === undefined ? null : core.parseRepositoryRef(repo)
if (repo !== undefined && parsedRepo === null) {
  console.error(`Could not read '${repo}' as a repository. Expected owner/name, or a GitHub URL.`)
  process.exit(1)
}

const credentials = core.osKeychain((service, account) => new Entry(service, account))
const services = runtime.createCoreServices({ dir, credentials })

try {
  const connections = services.mirror.listConnections()
  const jira = connections.find((c) => c.kind === 'jira')
  const github = connections.find((c) => c.kind === 'github')

  if (keys.length > 0 && jira === undefined) {
    console.error('No Jira connection is configured. Run `npm run credential:import` first.')
    process.exit(1)
  }

  if (parsedRepo !== null && github === undefined) {
    console.error('--repo was given but no GitHub connection is configured.')
    process.exit(1)
  }

  // The display name comes from the provider rather than from a flag. A project
  // bound under a name the operator typed from memory is a project that
  // disagrees with every other tool they have open.
  const names = keys.length === 0 ? new Map() : await projectNames(jira, keys)

  const bindings =
    keys.length > 0
      ? keys.map((key) => ({ key, code: key, name: names.get(key) }))
      : [{ key: null, code: codeOf(parsedRepo.name), name: `${parsedRepo.owner}/${parsedRepo.name}` }]

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
      jiraConnectionId: key === null ? null : jira.id,
      jiraProjectKey: key,
      githubConnectionId: parsedRepo === null ? null : github.id,
      repoOwner: parsedRepo?.owner ?? null,
      repoName: parsedRepo?.name ?? null,
      documentationUrl: null,
      // FR-003. `projects.upsert` recompiles this and rejects a pattern with no
      // capture group; generated here it is correct by construction.
      //
      // For a repository with no Jira project this is derived from the repo name
      // instead, so it compiles and matches nothing. A permissive pattern like
      // `([A-Z]+-\d+)` would be worse than useless here: it would let a branch
      // in this repository claim a ticket belonging to a different project.
      ticketKeyPattern: core.defaultKeyPattern(code),
      checkoutPaths: checkouts,
      statusOverrides: {},
    })

    const jiraPart = project.jiraProjectKey ?? 'no ticket project'
    const repoPart =
      project.repoOwner === null ? 'no repository' : `${project.repoOwner}/${project.repoName}`
    console.log(`  ${code.padEnd(10)} ${name}`)
    console.log(`  ${' '.repeat(10)} ${jiraPart}  ·  ${repoPart}`)
    if (project.checkoutPaths.length > 0) {
      console.log(`  ${' '.repeat(10)} checkouts: ${project.checkoutPaths.join(', ')}`)
    }
  }
} finally {
  services.close()
}

/** A project code from a repository name: uppercase, letters and digits only. */
function codeOf(repoName) {
  return repoName.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
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
