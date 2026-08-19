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
 * The panel's empty state promises "a session appears here the moment one
 * starts". That sentence is the assertion.
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

test('a session started by an agent appears without the window being touched', async () => {
  const panel = it.window.getByRole('region', { name: /agent sessions/i })
  await expect(panel).toBeVisible()

  // The scenario seeds a session of its own, so the precondition is not "empty"
  // — it is "this agent is not here yet". Asserting emptiness would have been a
  // test that only passed against a board nobody had used.
  await expect(panel).not.toContainText('e2e-agent')

  const response = await agent(it.dir, 'sessions.start', {
    agentId: 'e2e-agent',
    sessionId: 'push-check',
    reportedStatus: 'Proving the board moves on its own.',
    heartbeatIntervalSec: 60,
  })
  expect(response.ok).toBe(true)

  // Prove the write landed *before* asking anything of the window. Otherwise a
  // failure here is ambiguous between "the session was never created" and "the
  // window was never told" — two very different bugs that look identical from
  // the panel.
  const listed = await agent(it.dir, 'sessions.list', {})
  const body = (await listed.json()) as { ok: boolean; data: { agentId: string }[] }
  expect(body.ok).toBe(true)
  expect(body.data.map((s) => s.agentId)).toContain('e2e-agent')

  // No reload, no click, no refetch triggered from this side. If the assertion
  // below passes it is because main pushed and the renderer invalidated.
  await expect(panel).toContainText('e2e-agent', { timeout: 10_000 })
})

test('activity from an agent updates the panel in place', async () => {
  const panel = it.window.getByRole('region', { name: /agent sessions/i })

  const response = await agent(it.dir, 'sessions.activity', {
    agentId: 'e2e-agent',
    sessionId: 'push-check',
    reportedStatus: 'A second status, pushed while the window sat still.',
  })
  expect(response.ok).toBe(true)

  await expect(panel).toContainText(/second status/i, { timeout: 10_000 })
})

test('ending a session is pushed too, so the panel does not keep a ghost', async () => {
  const panel = it.window.getByRole('region', { name: /agent sessions/i })

  const before = (await panel.textContent()) ?? ''

  const response = await agent(it.dir, 'sessions.end', {
    agentId: 'e2e-agent',
    sessionId: 'push-check',
    // Required: a session closes as `done` or `failed`, never just "closed".
    outcome: 'done',
  })
  expect(response.ok).toBe(true)

  // The panel labels a finished session 'Done' (or 'Failed'). Asserting on that
  // rather than on "the text changed somehow" — an inequality assertion passes
  // for any difference at all, including a relative timestamp ticking over,
  // which would have made this green without the push ever arriving.
  await expect(panel).toContainText(/Done|Failed/, { timeout: 10_000 })
  expect(before).toContain('e2e-agent')
})
