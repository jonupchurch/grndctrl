import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * The ticket history (008 — FR-146 to FR-159).
 *
 * ## What this file is actually for
 *
 * Everything below happens between an agent over the loopback API and a window
 * nobody touched in between, because that is the shape of the feature: the
 * entries are written by an agent when work finishes and read by the operator
 * months later. A spec that wrote the entries through the interface would be
 * testing a path that does not exist — nothing in the window records one, and
 * nothing should.
 *
 * ## The one that matters most is the ticket that is not on the board
 *
 * `MERC-1150` in the scenario has no lane, no row and no mirrored ticket. It is
 * the case the whole feature exists for and the only region on this board that
 * can show it — everything else here is a view of what is currently assigned to
 * the operator. If that entry is missing, the feature has not shipped, whatever
 * else passes.
 */

const SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
  'agent-console.json',
)

/** See `active-ticket.spec.ts`: long enough for an IPC round trip, short enough to mean something. */
const PUSHED = { timeout: 2_500 }

let it: LaunchedApp

const panel = () => it.window.getByRole('region', { name: /ticket history/i })
const tickets = () => it.window.getByRole('region', { name: /^tickets$/i })
const row = (text: string) => panel().locator('.history').filter({ hasText: text })

/**
 * Open a row, whatever state it was left in.
 *
 * The rows keep their own open/closed state across tests in this file, so a bare
 * click is a *toggle* and a test that assumed "click to open" would close a row
 * another test had opened. Reading `aria-expanded` rather than tracking it here
 * also means the control's own accessible state is what the suite depends on.
 */
async function open(text: string): Promise<void> {
  const head = row(text).locator('.history__head')
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
}

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
      'x-grndctrl-agent': 'e2e-history',
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

  // Settle before asserting anything about pushes, for the reason
  // `prompts.spec.ts` gives: the launch sync invalidates every query when it
  // finishes, which would fill this region for reasons unrelated to
  // `history:changed`.
  await expect(tickets().locator('.lane-status')).toContainText(/failed to refresh/i, {
    timeout: 30_000,
  })
})

test.afterAll(async () => {
  await it.close()
})

test('shows one line per ticket, seeded by the scenario', async () => {
  await expect(panel()).toBeVisible()
  await expect(row('MERC-1184')).toHaveCount(1)
  await expect(row('MERC-1184')).toContainText(/reconcile path/i)
})

test('keeps an entry for a ticket that is not on the board at all', async () => {
  /*
   * The requirement, in one assertion.
   *
   * MERC-1150 closed a month ago in the scenario's story. It is not in the
   * ticket lane, not in the mirror, and not reachable from anywhere else in this
   * window — a note on it would have nothing to hang from. The entry is here
   * because the history is authored and keyed by natural key (XIII, FR-149).
   */
  await expect(row('MERC-1150')).toHaveCount(1)
  await expect(tickets()).not.toContainText('MERC-1150')
})

test('shows the notes only once the row is opened', async () => {
  const target = row('MERC-1201')

  // Folded: the detail is not merely hidden, it is not in the page. A CSS fold
  // would satisfy a "not visible" assertion and leave a year of paragraphs in
  // the DOM for the perf and greyscale suites to count.
  await expect(target.locator('.history__notes')).toHaveCount(0)

  await open('MERC-1201')
  await expect(target.locator('.history__notes')).toContainText(/window position/i)
})

test('narrows to what the operator is looking for', async () => {
  // FR-157. The search matches the notes as well as the line and the key,
  // because the question is "what did we do about X" and X is as likely to be a
  // word from the detail.
  const search = panel().getByRole('searchbox')

  await search.fill('throttl')
  await expect(panel().locator('.history')).toHaveCount(1)
  await expect(row('MERC-1150')).toHaveCount(1)

  await search.fill('nothing matches this')
  await expect(panel()).toContainText(/nothing in the history matches/i)

  await search.fill('')
  await expect(panel().locator('.history')).toHaveCount(3)
})

test('an entry recorded by an agent arrives without the window being touched', async () => {
  await json(
    await agent('history.record', {
      ticketKey: 'jira:acme.atlassian.net/MERC-1190',
      line: 'Session picker now remembers the last provider.',
      notes: 'Stored in settings rather than in the picker, so it survives a restart.',
    }),
  )

  await expect(row('MERC-1190')).toHaveCount(1, PUSHED)
  await expect(row('MERC-1190')).toContainText(/remembers the last provider/i)
})

test('recording again replaces the line and adds to the notes', async () => {
  await json(
    await agent('history.record', {
      ticketKey: 'jira:acme.atlassian.net/MERC-1190',
      line: 'Reverted: the setting was the wrong place for it.',
      notes: 'Moved back into the picker after the restart case turned out not to matter.',
    }),
  )

  const target = row('MERC-1190')
  await expect(target).toContainText(/reverted/i, PUSHED)
  // Still one row. "One line per ticket" is the primary key, not a convention.
  await expect(target).toHaveCount(1)

  await open('MERC-1190')
  const notes = target.locator('.history__notes')
  // Both paragraphs, and the first one still first. This is the property that
  // makes the entry worth reading in a year rather than only the last thing
  // anybody said.
  await expect(notes).toContainText(/survives a restart/i)
  await expect(notes).toContainText(/turned out not to matter/i)
})

test('the operator can rewrite an entry, and an agent cannot', async () => {
  const target = row('MERC-1190')
  await open('MERC-1190')
  await target.getByRole('button', { name: 'Edit', exact: true }).click()

  const line = target.locator('.history__field input')
  await line.fill('Reverted, and the setting was removed.')
  await target.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(target).toContainText(/the setting was removed/i, PUSHED)

  /*
   * The other half, and the reason `history.revise` is `ui-only` (FR-154).
   *
   * Asserted through the agent's real transport rather than by reading an
   * exposure literal: this is the response an agent actually gets. A refusal
   * that only existed in the registry's metadata would be no refusal at all.
   */
  const refused = await agent('history.revise', {
    ticketKey: 'jira:acme.atlassian.net/MERC-1190',
    revision: 1,
    line: 'Actually it was fine.',
  })
  const body = (await refused.json()) as { ok: boolean; error?: { message: string } }
  expect(body.ok).toBe(false)
  expect(body.error?.message).toMatch(/not available on the http surface/i)

  // And the operator's wording stands.
  await expect(target).toContainText(/the setting was removed/i)
})

test('deleting asks twice, then removes the entry', async () => {
  // Its own entry rather than one an earlier test left, so a failure above does
  // not turn into a second failure here that buries it.
  await json(
    await agent('history.record', {
      ticketKey: 'jira:acme.atlassian.net/MERC-1184',
      line: 'DELETE-ME: recorded against the wrong ticket.',
    }),
  )

  const target = row('DELETE-ME')
  await expect(target).toHaveCount(1, PUSHED)
  await open('DELETE-ME')

  // `exact`, because the row's own head button is a button too and its
  // accessible name is the line — which here contains the word.
  //
  // First press arms it. The entry is still there — this is the guard, and a
  // one-press delete would remove the only copy of what the entry said (XI).
  await target.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(target).toHaveCount(1)

  await target.getByRole('button', { name: 'Really delete', exact: true }).click()
  await expect(panel().locator('.history').filter({ hasText: 'DELETE-ME' })).toHaveCount(0, PUSHED)
})

test('refuses a line that is not one line, over the agent surface', async () => {
  // FR-147. Refused rather than reshaped, and the message names where the
  // paragraph goes — the caller is a model, and "invalid" alone would have it
  // shorten the line and lose the sentence rather than move it.
  const refused = await agent('history.record', {
    ticketKey: 'jira:acme.atlassian.net/MERC-1184',
    line: 'Did a thing.\nThen another thing.',
  })

  const body = (await refused.json()) as { ok: boolean; error?: { message: string } }
  expect(body.ok).toBe(false)
  expect(body.error?.message).toMatch(/notes/i)
})
