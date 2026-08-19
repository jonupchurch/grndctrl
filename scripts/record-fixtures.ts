import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Record provider fixtures from a live connection (T038–T040).
 *
 *   node --experimental-strip-types scripts/record-fixtures.ts jira --connection jira-1
 *
 * Every provider payload in the suite is otherwise hand-written, which means it
 * agrees with whatever the person who wrote it believed. The day these providers
 * first met live data, eight bugs surfaced in code with a green suite.
 * `packages/core/test/providers/replay.test.ts` is what consumes these.
 *
 * **There were three recorders**: Jira, GitHub, and a local git one that
 * recorded porcelain output rather than HTTP. Two went with their providers.
 *
 * ## Where the output goes, and why not into the repository
 *
 * `fixtures/jira` — **gitignored by decision**. Scrubbed payloads derived from
 * a real client's tracker do not belong in a published tree, and the scrubber
 * being good is not the same as the scrubber being perfect. Keeping them local
 * closes the largest exposure by construction rather than by trusting a
 * filter.
 *
 * The cost, stated plainly rather than left implicit: **CI never runs against
 * these**, because CI has no fixtures. The replay test skips there. What it
 * protects is this machine, and any machine that records its own — which is
 * where a provider change would first be noticed anyway.
 *
 * ## The scrubbing, and its limit
 *
 * `recordingFetcher` runs every response through `scrub`, which replaces person
 * names, emails, account ids and hostnames with stable aliases — stable so that
 * a ticket key means the same string across two providers, because correlation
 * joins on it and randomising per-file would produce fixtures that cannot
 * correlate. It does not, and cannot, guarantee that free text carries nothing
 * identifying: a ticket *summary* is prose written by a person, and no filter
 * reads prose reliably.
 *
 * **So read what this writes before trusting it**, and never commit it. The
 * gitignore is the backstop, not the plan.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function credential(connectionId: string): Promise<string> {
  const { Entry } = await import('@napi-rs/keyring')
  const { credentialRef, osKeychain } = await import('@grndctrl/core')
  const store = osKeychain((service, account) => new Entry(service, account))
  const secret = store.get(credentialRef(connectionId))
  if (secret === null || secret === '') {
    throw new Error(`No credential stored for connection '${connectionId}'.`)
  }
  return secret
}

/** The stored connection row, for the site and the account identity. */
async function connection(connectionId: string): Promise<{
  siteOrHost: string
  email: string | null
}> {
  const { openMirror, appDataDir } = await import('@grndctrl/core')
  const { db } = openMirror({ dir: process.env['GRNDCTRL_DATA_DIR'] ?? appDataDir() })
  try {
    const row = db
      .prepare('SELECT site_or_host, viewer_identity FROM connections WHERE id = ?')
      .get(connectionId) as { site_or_host?: string; viewer_identity?: string } | undefined

    if (row?.site_or_host === undefined) {
      throw new Error(`No connection '${connectionId}' in the mirror.`)
    }

    let email: string | null = null
    if (row.viewer_identity !== undefined && row.viewer_identity !== null) {
      email = (JSON.parse(row.viewer_identity) as { email?: string | null }).email ?? null
    }
    return { siteOrHost: row.site_or_host, email }
  } finally {
    db.close()
  }
}

async function recordJira(connectionId: string): Promise<string> {
  const { jiraProvider } = await import('@grndctrl/core')
  const { recordingFetcher } = await import('../packages/core/test/fixtures/record.ts')

  const token = await credential(connectionId)
  const { siteOrHost, email } = await connection(connectionId)

  if (email === null) {
    throw new Error(
      `Connection '${connectionId}' has no resolved account email. Sync once, then record.`,
    )
  }

  const dir = join(ROOT, 'fixtures', 'jira')
  mkdirSync(dir, { recursive: true })

  const provider = jiraProvider({
    site: siteOrHost,
    email,
    apiToken: token,
    // The token is passed so the scrubber can find it. A fixture with a live
    // credential in it would be the worst possible outcome of this script, and
    // it is the one thing here that must not depend on noticing it by eye.
    fetcher: recordingFetcher({ dir, secrets: [token, email] }),
  })

  // The query the app actually issues (see `services/sync.ts`), so the recorded
  // shape is the shape sync will meet — a fixture of a different query is a
  // fixture of a different response.
  const page = await provider.searchIssues({ jql: 'assignee = currentUser() ORDER BY updated DESC' })
  return `${page.tickets.length} tickets`
}

const which = process.argv[2]
const connectionId = flag('connection')

if (which !== 'jira') {
  console.error('usage: record-fixtures.ts jira --connection <id>')
  process.exit(2)
}

if (connectionId === undefined || connectionId === '') {
  console.error('--connection <id> is required.')
  process.exit(2)
}

try {
  const summary = await recordJira(connectionId)
  const dir = join(ROOT, 'fixtures', which)
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []

  console.log(`Recorded ${files.length} responses into fixtures/${which}/ (${summary}).`)
  console.log('')
  console.log('These are gitignored on purpose and must stay that way.')
  console.log('Read them before you rely on them: the scrubber replaces names,')
  console.log('emails, account ids and hosts, and it cannot read prose — a ticket')
  console.log('summary is whatever a person typed.')
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
