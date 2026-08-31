import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * An agent acts; the open window notices, without anyone touching it.
 *
 * This is the test the feature never had, and its absence was the whole defect.
 * The desktop derives its push events by wrapping the dispatch it hands the
 * **IPC** adapter, so the board refreshed itself whenever the *window* acted.
 * The loopback adapter that agents use dispatched straight through the registry
 * and was wrapped by nothing — so an agent starting a session left the board
 * unchanged until an unrelated sync happened to invalidate everything.
 *
 * Both halves were internally correct, which is why 764 unit tests passed over
 * it. Catching it required an agent, an open window, and something watching both
 * at once — which is exactly what this file is.
 *
 * ## What it watches, since 2026-08-31
 *
 * The agent session lane was removed from the board that day, and it was where
 * every assertion below used to look: an agent's name, its reported status, the
 * word `Done`. **The guarantee did not go with it** — the push is what makes
 * this application a console rather than a report — so the assertions moved to
 * the two places a session is still visible: the *Agents live* tile, which
 * counts them, and the ticket row's agent badge, which says one is on that work.
 *
 * That costs the suite one thing and it is worth naming: **an agent's reported
 * status is no longer rendered anywhere**, so nothing here can assert that the
 * *text* of a status update arrives. What is asserted is that the state change
 * does, unprompted, in three shapes — a session appearing, a silent one coming
 * back, and one ending.
 */

const SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
  'canonical-board.json',
)

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
})

test.afterAll(async () => {
  await it.close()
})

/** Call the loopback API the way `grndctrl-mcp` does, from outside the window. */
async function agent(dir: string, operation: string, body: unknown): Promise<Response> {
  const { port, token } = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')) as {
    port: number
    token: string
  }

  return fetch(`http://127.0.0.1:${port}/op/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-grndctrl-agent': 'e2e',
    },
    body: JSON.stringify(body),
  })
}

/**
 * The tile that counts sessions, and the badge that says one is on a ticket.
 *
 * The scenario seeds exactly one session — `claude-code/01J8XY`, on MERC-1190,
 * five hours since its last beat against a sixty-second interval, so it is
 * *silent* and the tile reads `0` of `1`. Every number below is stated
 * absolutely rather than as "more than before": an inequality would pass for any
 * difference at all, including one this file did not cause.
 */
const live = () => it.window.locator('.tile', { hasText: 'Agents live' })

const agentBadge = (issueKey: string) =>
  it.window
    .locator('.row', { hasText: issueKey })
    .locator('.badge[data-kind="agent"]')

test('a session started by an agent appears without the window being touched', async () => {
  // The precondition, and it is not "empty": the scenario has a session of its
  // own, silent. Asserting emptiness would be a test that only passed against a
  // board nobody had used.
  await expect(live().locator('.tile__value')).toHaveText('0')
  await expect(live()).toContainText('of 1 session')

  // MERC-1201 has no agent on it, which is what makes its badge worth watching.
  await expect(agentBadge('MERC-1201')).toHaveAttribute('data-present', 'false')

  const response = await agent(it.dir, 'sessions.start', {
    agentId: 'e2e-agent',
    sessionId: 'push-check',
    projectId: 'p-merc',
    // Named, so the push has to reach the ticket lane as well as the tile — two
    // different projections of the same write, and the lane's is the one an
    // operator actually reads.
    workItemKey: 'jira:acme.atlassian.net/MERC-1201',
    reportedStatus: 'Proving the board moves on its own.',
    heartbeatIntervalSec: 60,
  })
  expect(response.ok).toBe(true)

  // Prove the write landed *before* asking anything of the window. Otherwise a
  // failure here is ambiguous between "the session was never created" and "the
  // window was never told" — two very different bugs that look identical from
  // the board.
  const listed = await agent(it.dir, 'sessions.list', {})
  const body = (await listed.json()) as { ok: boolean; data: { agentId: string }[] }
  expect(body.ok).toBe(true)
  expect(body.data.map((s) => s.agentId)).toContain('e2e-agent')

  // No reload, no click, no refetch triggered from this side. If the assertions
  // below pass it is because main pushed and the renderer invalidated.
  await expect(live().locator('.tile__value')).toHaveText('1', { timeout: 10_000 })
  await expect(live()).toContainText('of 2 sessions')
  await expect(agentBadge('MERC-1201')).toHaveAttribute('data-present', 'true')
})

test('activity from an agent is pushed too, and brings a silent session back', async () => {
  /*
   * The scenario's own session, not the one started above.
   *
   * It is silent because its last heartbeat is five hours old, and `activity`
   * advances the beat — so this asserts the *derived* state moving, which is the
   * half a stored flag would not have. Two live sessions out of two is a number
   * nothing else in this file produces.
   */
  const response = await agent(it.dir, 'sessions.activity', {
    agentId: 'claude-code',
    sessionId: '01J8XY',
    reportedStatus: 'A second status, pushed while the window sat still.',
  })
  expect(response.ok).toBe(true)

  await expect(live().locator('.tile__value')).toHaveText('2', { timeout: 10_000 })
  await expect(live()).toContainText('of 2 sessions')
})

test('ending a session is pushed too, so the board does not keep a ghost', async () => {
  const response = await agent(it.dir, 'sessions.end', {
    agentId: 'e2e-agent',
    sessionId: 'push-check',
    // Required: a session closes as `done` or `failed`, never just "closed".
    outcome: 'done',
  })
  expect(response.ok).toBe(true)

  // One live session left, and still two on the books — an ended session is
  // finished, not forgotten. A tile that dropped the total as well would be
  // rewriting what happened rather than reporting it.
  await expect(live().locator('.tile__value')).toHaveText('1', { timeout: 10_000 })
  await expect(live()).toContainText('of 2 sessions')
})
