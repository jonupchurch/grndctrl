import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * The agent update panel (T132, T133 — FR-132, FR-134, FR-135).
 *
 * Driven from outside the window, over the loopback API, because that is the
 * only caller this panel has. Nothing in the interface can post an update and
 * nothing should: it is the half of the board where the agent talks.
 *
 * Two properties are worth the most here and neither is "it renders".
 *
 * **Terse is a constraint, not a default** (FR-134). The panel is specified to
 * show text, agent and age and *nothing else*, so this file counts the elements
 * inside an update rather than asserting the three are present — every addition
 * that would spoil it (an icon, a menu, a status mark, a link) passes a
 * presence check and fails a count.
 *
 * **The question is not an update.** 006 removed the Attention region and with
 * it the only list of open `question-for-human` notes; FR-135 lands that display
 * here. It has to be distinguishable and reachable, because a question is the
 * one thing an agent says that is owed an answer.
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

const TICKET = 'jira:acme.atlassian.net/MERC-1184'
const SESSION = 'session:e2e-updates/run-1'

/** See `active-ticket.spec.ts`: long enough for an IPC round trip, short enough to mean something. */
const PUSHED = { timeout: 2_500 }

let it: LaunchedApp

const panel = () => it.window.getByRole('region', { name: /agent updates/i })
const tickets = () => it.window.getByRole('region', { name: /^tickets$/i })

async function agent(operation: string, body: unknown): Promise<Response> {
  const { port, token } = JSON.parse(readFileSync(join(it.dir, 'runtime.json'), 'utf8')) as {
    port: number
    token: string
  }

  return fetch(`http://127.0.0.1:${port}/op/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-grndctrl-agent': 'e2e-updates',
    },
    body: JSON.stringify(body),
  })
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok: boolean; data: T }
  expect(body.ok).toBe(true)
  return body.data
}

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  // Settle before asserting anything about pushes. The launch sync invalidates
  // every query when it finishes, which would fill this panel for reasons
  // unrelated to `updates:changed`; afterwards the scheduler backs off well past
  // the length of this file. Same argument as `active-ticket.spec.ts`.
  await expect(tickets().locator('.lane-status')).toContainText(/failed to refresh/i, {
    timeout: 30_000,
  })
})

test.afterAll(async () => {
  await it.close()
})

test('says what fills it, rather than being blank', async () => {
  await expect(panel()).toBeVisible()
  await expect(panel()).toContainText(/nothing said yet/i)
  await expect(panel()).toContainText('grndctrl_post_update')
})

test('an update posted by an agent arrives without the window being touched', async () => {
  await json(
    await agent('sessions.start', {
      agentId: 'e2e-updates',
      sessionId: 'run-1',
      heartbeatIntervalSec: 60,
    }),
  )
  await json(await agent('focus.set', { ticketKey: TICKET }))

  const posted = await json<{ agentId: string; ticketKey: string | null }>(
    await agent('updates.post', {
      sessionKey: SESSION,
      text: 'The reconcile path never ran; the branch was already gone.',
    }),
  )

  // Author and ticket are filled by the service. This request supplied neither.
  expect(posted.agentId).toBe('e2e-updates')
  expect(posted.ticketKey).toBe(TICKET)

  await expect(panel()).toContainText(/reconcile path never ran/i, PUSHED)
  await expect(panel()).toContainText('e2e-updates')
})

test('an update is its text, its agent and its age — and nothing else', async () => {
  /*
   * FR-134, counted rather than inspected.
   *
   * "Shows the text" is satisfied by a card with a border, an icon, a title and
   * an overflow menu. The requirement is the absence of those, and the only
   * assertion that holds an absence is a count.
   */
  const update = panel().locator('.update:not(.update--question)').first()

  await expect(update.locator('> *')).toHaveCount(3)
  await expect(update.locator('button, a, svg, img, input')).toHaveCount(0)
  await expect(update.locator('.update__text')).toContainText(/reconcile path never ran/i)
  await expect(update.locator('.update__agent')).toHaveText('e2e-updates')
  // "now" for something posted a moment ago, not an absolute timestamp.
  await expect(update.locator('.update__age')).toHaveText(/now|\d+[smhd]/)
})

test('keeps the ticket an update was posted against when focus moves on', async () => {
  // The reason `ticketKey` is captured at write time. Re-resolving it at read
  // would rewrite the entire history the moment the operator switched tickets,
  // and nothing on the screen would say it had moved.
  await json(await agent('focus.set', { ticketKey: 'jira:acme.atlassian.net/MERC-1190' }))

  const listed = await json<{ text: string; ticketKey: string | null }[]>(
    await agent('updates.list', {}),
  )

  expect(listed[0]?.ticketKey).toBe(TICKET)
  await expect(panel()).toContainText(/reconcile path never ran/i)
})

test('a question an agent asks appears here, and opens where it was asked', async () => {
  // FR-135. 006 removed the Attention region and with it the only list of these;
  // the effect on ball-in-court never left, and this is where the display lands.
  await json(
    await agent('notes.create', {
      subjectKey: TICKET,
      type: 'question-for-human',
      body: 'Should the reconcile keep the worktree or remove it?',
    }),
  )

  const question = panel().locator('.update--question')

  /*
   * Pushed, on its own channel — and it was not, until this test.
   *
   * The first version of this line allowed ten seconds and failed anyway: there
   * was no note push at all, and there never had been. Until 007 a note changed
   * exactly one thing on an open board, a badge count, and a badge a few minutes
   * stale is indistinguishable from a correct one. FR-135 makes it an unanswered
   * question in a panel, which is a different standard entirely — a question
   * that appears whenever the next poll happens to finish is not a question the
   * operator was asked.
   */
  await expect(question).toContainText(/keep the worktree or remove it/i, PUSHED)

  // Above the updates. An update is something to read and a question is
  // something to do; sorting both into one chronological list would bury the
  // only actionable item under whatever the agent said next.
  const order = await panel().locator('.update').evaluateAll((nodes) =>
    nodes.map((n) => (n.classList.contains('update--question') ? 'question' : 'update')),
  )
  expect(order[0]).toBe('question')

  // And it opens the note, so the answer is written where the question was
  // asked rather than in a second place that would have to be reconciled.
  await question.click()
  await expect(it.window.locator('dialog[open], .modal')).toBeVisible({ timeout: 5_000 })
})
