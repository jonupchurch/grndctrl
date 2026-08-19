import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/**
 * Load a checked-in scenario into a real pair of databases.
 *
 * The board cannot be looked at without data, and the data normally comes from
 * Jira and GitHub. That makes the interface undevelopable until credentials
 * exist, and untestable end to end even once they do — a golden-path test that
 * depends on somebody's live Jira board is a test that fails on a Tuesday
 * because a colleague closed a ticket.
 *
 * So the same `fixtures/scenarios/*.json` the correlation engine is tested
 * against are written straight into the mirror. What comes out the other side is
 * the genuine path — correlation, drift rules, freshness envelopes, IPC — over
 * known inputs. The only thing skipped is the provider fetch.
 *
 *   node scripts/seed.mjs --dir <data dir> [--scenario <path>]
 *
 * Writing into the *default* data directory is refused. This truncates every
 * mirror table it touches, and doing that to the operator's real board because
 * a flag was forgotten is not a mistake worth leaving available.
 */

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const core = require('@grndctrl/core')
const runtime = require('@grndctrl/core/runtime')
const dir = flag('--dir')
const scenarioPath = flag('--scenario') ?? join(REPO, 'fixtures/scenarios/merged-pr-open-ticket.json')

if (dir === undefined) {
  console.error('seed.mjs --dir <data directory> [--scenario <path>]')
  process.exit(1)
}

if (resolve(dir) === resolve(core.appDataDir())) {
  console.error(
    `Refusing to seed ${core.appDataDir()} — that is the real data directory, and seeding\n` +
      'replaces every mirrored table in it. Point --dir at a scratch directory.',
  )
  process.exit(1)
}

const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
const input = scenario.input
const now = scenario.now ?? new Date().toISOString()

// Through the composition root rather than by opening the files directly: it is
// the same wiring the app uses, so anything seeded here is reachable by exactly
// the path the app reads it back on.
const services = runtime.createCoreServices({ dir })
const { mirror, projects, sessions } = services

// Connections first: every other table is keyed by one, and the freshness rows
// hang off them.
//
// Only the Jira ones. A scenario written for 0.3.0 still names a
// `githubConnectionId`, and seeding it would now fail on the CHECK constraint
// migration 4 leaves behind. Ignored rather than made an error: these scenarios
// are rewritten in M5, and a seed script that refused to load them until then
// would take the whole end-to-end suite with it.
const connectionIds = new Set()
for (const project of input.projects ?? []) {
  const id = project.jiraConnectionId
  if (id !== null && id !== undefined) connectionIds.add(id)
}

for (const id of connectionIds) {
  const accountId = (input.operatorAccountIds ?? [])[0] ?? null

  mirror.upsertConnection({
    id,
    kind: 'jira',
    siteOrHost: 'example.atlassian.net',
    accountLabel: `${id} (seeded)`,
    // The viewer identity is what makes "mine" resolvable, and the scenarios
    // carry the account id their tickets are assigned to. Without it every row
    // would land in someone else's court and the first tile would read zero.
    viewerIdentity:
      accountId === null ? null : { accountId, displayName: 'Seeded operator', email: null },
    // A keychain *handle*, never a secret — there is no credential behind this
    // and there must not be: seeded data never syncs (XI).
    credentialRef: `grndctrl/${id}`,
  })
}

// The four removed columns are dropped on the way in, for the same reason: a
// 0.3.0 scenario still carries them and `projects.upsert` no longer takes them.
for (const project of input.projects ?? []) {
  const { githubConnectionId, repoOwner, repoName, checkoutPaths, ticketKeyPattern, ...kept } =
    project
  void [githubConnectionId, repoOwner, repoName, checkoutPaths, ticketKeyPattern]
  projects.upsert(kept)
}

const byConnection = (rows, key) => {
  const groups = new Map()
  for (const row of rows ?? []) {
    const id = row[key]
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  return groups
}

// Tickets only. A scenario's `pullRequests`, `checks`, `branches`,
// `comparisons` and `workspaces` have no table to go into any more; they are
// skipped here and removed from the scenarios themselves in M5.
for (const [id, rows] of byConnection(input.tickets, 'connectionId')) mirror.replaceTickets(id, rows)

// Freshness last, and from the scenario rather than from the clock: several of
// these scenarios exist precisely to put a lane into `stale` or `failed`, and
// stamping everything fresh would erase the thing being demonstrated.
for (const entry of (scenario.freshness ?? []).filter(
  (e) => (e.resourceKind ?? e.kind) === 'tickets',
)) {
  // The scenarios say `resourceKind`; the repository takes `kind`. A seed that
  // guessed would write NULL and the lane would read as never-synced, which is
  // a state these scenarios use deliberately elsewhere — so it has to be exact.
  const kind = entry.resourceKind ?? entry.kind

  if (entry.lastSuccessAt !== null && entry.lastSuccessAt !== undefined) {
    mirror.recordSuccess(entry.connectionId, kind, entry.lastSuccessAt)
  }

  // Not `else`: a resource can have succeeded this morning and failed since,
  // and that pair is exactly what distinguishes `failed` from `never`.
  if (entry.lastFailureAt !== null && entry.lastFailureAt !== undefined) {
    mirror.recordFailure(
      entry.connectionId,
      kind,
      entry.lastFailureAt,
      entry.failureReason ?? 'unknown',
      entry.nextAttemptAt ?? null,
    )
  }
}

// Sessions are authored data, and they arrive by being *started* — the same
// call an agent makes over MCP. Seeding them any other way would produce rows
// no real agent could have produced.
const ctx = { authorKind: 'agent', authorId: 'seed', surface: 'http', now: () => new Date(now) }
for (const session of input.sessions ?? []) {
  sessions.start(
    {
      agentId: session.agentId,
      sessionId: session.sessionId,
      projectId: session.projectId ?? null,
      workItemKey: session.workItemKey ?? null,
      workspaceKey: session.workspaceKey ?? null,
      reportedStatus: session.reportedStatus ?? null,
      heartbeatIntervalSec: session.heartbeatIntervalSec ?? 60,
      at: session.startedAt,
    },
    ctx,
  )

  // Replay the real activity separately, so a session the scenario means to be
  // silent stays silent rather than looking freshly started.
  if (session.lastRealActivityAt) {
    sessions.activity(
      { agentId: session.agentId, sessionId: session.sessionId, at: session.lastRealActivityAt },
      ctx,
    )
  }
}

services.close()

console.log(
  `seeded ${dir}\n` +
    `  scenario   ${scenarioPath}\n` +
    `  projects   ${(input.projects ?? []).length}\n` +
    `  tickets    ${(input.tickets ?? []).length}\n` +
    `  pulls      ${(input.pullRequests ?? []).length}\n` +
    `  branches   ${(input.branches ?? []).length}\n` +
    `  workspaces ${(input.workspaces ?? []).length}\n` +
    `  sessions   ${(input.sessions ?? []).length}`,
)
