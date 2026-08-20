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
 * against are written straight into the databases. What comes out the other side
 * is the genuine path — correlation, freshness envelopes, IPC — over known
 * inputs. The only thing skipped is the provider fetch.
 *
 *   node scripts/seed.mjs --dir <data dir> [--scenario <path>]
 *
 * Writing into the *default* data directory is refused. This truncates every
 * mirror table it touches, and doing that to the operator's real board because
 * a flag was forgotten is not a mistake worth leaving available.
 *
 * **Timestamps are offsets, resolved here** (FR-118). `resolveScenarioTimes`
 * comes from core rather than from a copy in this file precisely because the
 * text board reads the same scenarios: two resolvers would make one fixture mean
 * two boards, and the disagreement would look like a rendering bug.
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
const fixtures = require('@grndctrl/core/fixtures')
const dir = flag('--dir')
const scenarioPath = flag('--scenario') ?? join(REPO, 'fixtures/scenarios/canonical-board.json')

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

const scenario = fixtures.resolveScenarioTimes(
  JSON.parse(readFileSync(scenarioPath, 'utf8')),
  new Date(),
)
const input = scenario.input
const now = scenario.now ?? new Date().toISOString()

// Through the composition root rather than by opening the files directly: it is
// the same wiring the app uses, so anything seeded here is reachable by exactly
// the path the app reads it back on.
const services = runtime.createCoreServices({ dir })
const { mirror, projects, sessions, notes, focus, updates, prompts, history } = services

// Connections first: every other table is keyed by one, and the freshness rows
// hang off them.
const connectionIds = new Set()
for (const project of input.projects ?? []) {
  const id = project.jiraConnectionId
  if (id !== null && id !== undefined) connectionIds.add(id)
}

/*
 * The connection's site comes from the scenario's own ticket keys.
 *
 * It was the literal `example.atlassian.net` while every checked-in scenario
 * used `acme.atlassian.net` for its tickets, so **every seeded board has been
 * internally inconsistent** since the first one: a connection claiming one site,
 * rows keyed to another. Nothing compared them, so nothing failed -- and the
 * notes these scenarios seed were, strictly, attached to a site the board was
 * not configured for.
 *
 * Surfaced on 2026-08-20 by the site check that closed exactly that bug in the
 * product (`services/sites.ts`), which refused the seeder's own notes the first
 * time it ran. A fixture that the application's own rules reject is not a
 * fixture, and deriving the site rather than declaring it makes the
 * disagreement unrepresentable instead of merely fixed.
 */
const siteFor = (id) => {
  const ticket = (input.tickets ?? []).find((t) => t.connectionId === id)
  if (ticket === undefined) return 'example.atlassian.net'

  // `jira:<site>/<ISSUE-KEY>`.
  const site = ticket.key.slice('jira:'.length).split('/')[0]
  return site === '' ? 'example.atlassian.net' : site
}

for (const id of connectionIds) {
  const accountId = (input.operatorAccountIds ?? [])[0] ?? null

  mirror.upsertConnection({
    id,
    kind: 'jira',
    siteOrHost: siteFor(id),
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

for (const project of input.projects ?? []) projects.upsert(project)

const byConnection = (rows, key) => {
  const groups = new Map()
  for (const row of rows ?? []) {
    const id = row[key]
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  return groups
}

for (const [id, rows] of byConnection(input.tickets, 'connectionId')) mirror.replaceTickets(id, rows)

// Freshness from the scenario rather than from the clock: several of these
// scenarios exist precisely to put a lane into `stale` or `failed`, and stamping
// everything fresh would erase the thing being demonstrated.
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

  // And the heartbeat after it, because the two columns are the whole point of
  // the session state machine: activity advances both, a beat advances only one.
  // Without this the seeded row derives its heartbeat from its activity, so a
  // scenario describing an agent that is alive and doing nothing would arrive
  // here as one that is silent — and the text board, which reads the file
  // directly, would render the state the file actually asked for. Two readers,
  // two boards, from one fixture.
  if (session.lastHeartbeatAt) {
    sessions.heartbeat(
      { agentId: session.agentId, sessionId: session.sessionId, at: session.lastHeartbeatAt },
      ctx,
    )
  }
}

// Notes last, because `subjectPresence` is resolved against the mirror and a
// note written before its ticket would be created already orphaned.
//
// Written through `notes.create` rather than declared as counts on the scenario.
// They used to be declared, and only the text board could act on it: this script
// fills a real authored store, where the count on a row and the open questions
// driving ball-in-court both come from the notes actually in it. So the canonical
// scenario said MERC-1184 carried two notes, the seeded board showed none, and
// nothing could catch the disagreement because each reader was self-consistent.
for (const note of scenario.notes ?? []) {
  notes.create({ subjectKey: note.subjectKey, type: note.type, body: note.body }, ctx)
}

/*
 * 007's authored data, written the same way (T150).
 *
 * The active ticket, the update stream and the prompt shelf are the three
 * regions that are **empty until an agent calls something**, which makes them
 * the three a fixture is most needed for: without this, every scenario renders
 * three empty states and the suite can only ever assert that the empty states
 * are correct.
 *
 * All three go through the services rather than into the tables, for the reason
 * the sessions above do: `updates.post` fills the author from the session and
 * the ticket from whatever focus holds *at that moment*, so seeding the rows
 * directly would produce history no agent could have produced -- and would
 * quietly stop testing the capture that is the whole design of that field.
 *
 * Order matters, and it is the same order an agent works in: focus first, then
 * updates, so each update captures the ticket the scenario means it to.
 */
if (scenario.activeTicket) {
  focus.set({ ticketKey: scenario.activeTicket }, ctx)
}

for (const update of scenario.updates ?? []) {
  updates.post(
    { sessionKey: update.sessionKey, text: update.text },
    // A per-update clock, so a stream seeded all at once still reads as
    // something that happened over time. Without it every row says "now" and
    // the panel cannot be tested for order at all.
    { ...ctx, now: () => new Date(update.postedAt ?? now) },
  )
}

for (const prompt of scenario.prompts ?? []) {
  prompts.record(
    {
      text: prompt.text,
      sessionKey: prompt.sessionKey ?? undefined,
      projectId: prompt.projectId ?? undefined,
    },
    {
      ...ctx,
      // The author comes from `Ctx`, so a scenario naming an agent has to say so
      // here rather than in the payload -- the same rule the product enforces.
      authorId: prompt.agentId ?? ctx.authorId,
      now: () => new Date(prompt.recordedAt ?? now),
    },
  )
}

/*
 * The ticket history (008).
 *
 * Recorded rather than inserted, like everything else here, and that has one
 * visible consequence worth stating: `history.record` snapshots the ticket's
 * summary **from the mirror**, so an entry whose ticket the scenario does not
 * hold gets no summary. That is not a gap in the fixture -- it is what the write
 * path does, and a scenario declaring a summary the seeder could not produce
 * would be describing a board this product cannot reach.
 *
 * Last, after the tickets are in, for the same reason the notes are.
 */
for (const entry of scenario.history ?? []) {
  history.record(
    {
      ticketKey: entry.ticketKey,
      line: entry.line,
      notes: entry.notes ?? undefined,
    },
    {
      ...ctx,
      // The author comes from `Ctx`, never from the payload -- the same rule the
      // product enforces, so a scenario naming an agent has to say so here.
      authorId: entry.agentId ?? ctx.authorId,
      now: () => new Date(entry.updatedAt ?? now),
    },
  )
}

services.close()

console.log(
  `seeded ${dir}\n` +
    `  scenario   ${scenarioPath}\n` +
    `  projects   ${(input.projects ?? []).length}\n` +
    `  tickets    ${(input.tickets ?? []).length}\n` +
    `  sessions   ${(input.sessions ?? []).length}\n` +
    `  notes      ${(scenario.notes ?? []).length}\n` +
    `  updates    ${(scenario.updates ?? []).length}\n` +
    `  prompts    ${(scenario.prompts ?? []).length}\n` +
    `  history    ${(scenario.history ?? []).length}\n` +
    `  active     ${scenario.activeTicket ?? '(none)'}`,
)
