import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * The to-do list (009).
 *
 * Both writers are exercised: the operator through the window, and an agent
 * over the loopback API with the window untouched. The link from a ticket is
 * exercised from the ticket row's badge, which is the path the operator uses.
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

const PUSHED = { timeout: 2_500 }
const TICKET = 'jira:acme.atlassian.net/MERC-1190'

let it: LaunchedApp

const panel = () => it.window.getByRole('region', { name: /^to do$/i })
const tickets = () => it.window.getByRole('region', { name: /^tickets$/i })
const item = (text: string) => panel().locator('.todo').filter({ hasText: text })
const badge = (issueKey: string) =>
  tickets().locator('.row').filter({ hasText: issueKey }).locator('.row__todos')

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
      'x-grndctrl-agent': 'e2e-todos',
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
  await expect(tickets().locator('.lane-status')).toContainText(/failed to refresh/i, {
    timeout: 30_000,
  })
})

test.afterAll(async () => {
  await it.close()
})

test('starts empty and says how to fill it', async () => {
  await expect(panel()).toContainText(/nothing to do/i)
  await expect(panel()).toContainText('grndctrl_add_todo')
})

test('the operator adds a free-standing to-do', async () => {
  await panel().getByLabel('New to-do').fill('Renew the staging certificate')
  await panel().getByLabel('New to-do').press('Enter')

  await expect(item('Renew the staging certificate')).toHaveCount(1, PUSHED)
  await expect(item('Renew the staging certificate').locator('.todo__ticket')).toHaveText('Link')
  await expect(item('Renew the staging certificate')).toContainText('you')
})

test('an agent adds a linked to-do, and the ticket row counts it', async () => {
  await expect(badge('MERC-1190')).toHaveAttribute('data-empty', 'true')

  await json(await agent('todos.create', { text: 'Add a regression test', ticketKey: TICKET }))

  await expect(item('Add a regression test')).toHaveCount(1, PUSHED)
  await expect(item('Add a regression test').locator('.todo__ticket')).toHaveText('MERC-1190')
  await expect(item('Add a regression test')).toContainText('e2e-todos')
  await expect(badge('MERC-1190')).toHaveAttribute('data-empty', 'false', PUSHED)
  await expect(badge('MERC-1190')).toContainText('1')
})

test('the ticket badge narrows the list to that ticket and links what is added', async () => {
  await badge('MERC-1190').click()

  await expect(panel().locator('.todos__scope')).toContainText('MERC-1190')
  await expect(item('Renew the staging certificate')).toHaveCount(0)
  await expect(panel().getByLabel('New to-do')).toBeFocused()

  await panel().getByLabel('New to-do').fill('Update the runbook')
  await panel().getByRole('button', { name: 'Add', exact: true }).click()

  await expect(item('Update the runbook').locator('.todo__ticket')).toHaveText('MERC-1190', PUSHED)
  await expect(badge('MERC-1190')).toContainText('2', PUSHED)

  await panel().getByRole('button', { name: 'Show all' }).click()
  await expect(item('Renew the staging certificate')).toHaveCount(1)
})

test('a free-standing to-do can be linked to a ticket afterwards', async () => {
  const target = item('Renew the staging certificate')
  await target.locator('.todo__ticket').click()
  await target.getByLabel('Linked ticket').selectOption(TICKET)

  await expect(target.locator('.todo__ticket')).toHaveText('MERC-1190', PUSHED)
  await expect(badge('MERC-1190')).toContainText('3', PUSHED)
})

test('ticking one off moves it under the done toggle and out of the count', async () => {
  await item('Update the runbook').getByRole('checkbox').click()

  await expect(badge('MERC-1190')).toContainText('2', PUSHED)
  await expect(panel().locator('.todos--done')).toHaveCount(0)

  await panel()
    .getByRole('button', { name: /show 1 done/i })
    .click()
  await expect(panel().locator('.todos--done .todo')).toHaveText(/Update the runbook/)
})

test('an agent can tick one off, but cannot delete one', async () => {
  const [todo] = await json<{ id: string; revision: number }[]>(
    await agent('todos.list', { ticketKey: TICKET, state: 'open' }),
  )
  if (todo === undefined) throw new Error('expected an open to-do on MERC-1190')

  const refused = (await (await agent('todos.delete', todo)).json()) as { ok: boolean }
  expect(refused.ok).toBe(false)

  await json(await agent('todos.update', { ...todo, done: true }))
  await expect(badge('MERC-1190')).toContainText('1', PUSHED)
})

test('deleting asks twice, then removes the to-do', async () => {
  const target = item('Add a regression test')
  await expect(target).toHaveCount(1)

  await target.getByRole('button', { name: 'Delete' }).click()
  await expect(target).toHaveCount(1)
  await target.getByRole('button', { name: 'Really delete' }).click()

  await expect(target).toHaveCount(0, PUSHED)
})
