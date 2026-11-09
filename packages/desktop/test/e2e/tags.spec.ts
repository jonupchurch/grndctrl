import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * Ticket tags (010): the operator tags a ticket from its row, an agent tags one
 * over the loopback API, and Settings renames, recolours and adds tags.
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

let it: LaunchedApp

const tickets = () => it.window.getByRole('region', { name: /^tickets$/i })
const row = (issueKey: string) => tickets().locator('.row').filter({ hasText: issueKey })
const pill = (issueKey: string) => row(issueKey).locator('.row__tag')
const menu = () => it.window.getByRole('menu')

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
      'x-grndctrl-agent': 'e2e-tags',
    },
    body: JSON.stringify(body),
  })
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

test('the ticket lane has no Priority column any more', async () => {
  await expect(tickets().locator('.row__priority')).toHaveCount(0)
  await expect(tickets().getByText('Priority', { exact: true })).toHaveCount(0)
})

test('the operator tags a ticket from its row, sees it in red, and changes it', async () => {
  await row('MERC-1190').hover()
  await row('MERC-1190').getByRole('button', { name: 'Tag MERC-1190' }).click()
  await expect(menu()).toBeVisible()
  await menu().getByRole('menuitemradio', { name: 'Blocked' }).click()

  await expect(pill('MERC-1190')).toHaveText('Blocked', PUSHED)
  await expect(menu()).toHaveCount(0)
  const colours = await pill('MERC-1190').evaluate((el) => {
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, ink: s.color }
  })
  expect(colours.bg).toBe('rgb(214, 69, 69)')
  expect(colours.ink).toBe('rgb(255, 255, 255)')

  // The pill is the control: press it to change the tag.
  await pill('MERC-1190').click()
  await menu().getByRole('menuitemradio', { name: 'Waiting' }).click()
  await expect(pill('MERC-1190')).toHaveText('Waiting', PUSHED)
  // Dark text on the yellow, which white would not read on.
  expect(await pill('MERC-1190').evaluate((el) => getComputedStyle(el).color)).toBe('rgb(0, 0, 0)')

  await pill('MERC-1190').click()
  await menu().getByRole('menuitem', { name: 'Remove tag' }).click()
  await expect(pill('MERC-1190')).toHaveCount(0, PUSHED)
})

test('Escape closes the menu without changing anything', async () => {
  await row('MERC-1190').hover()
  await row('MERC-1190').getByRole('button', { name: 'Tag MERC-1190' }).click()
  await expect(menu()).toBeVisible()
  await it.window.keyboard.press('Escape')
  await expect(menu()).toHaveCount(0)
  await expect(pill('MERC-1190')).toHaveCount(0)
})

test('an agent tags a ticket over the API and the row shows it without a refresh', async () => {
  const list = (await (await agent('tags.list', {})).json()) as {
    data: { definitions: { id: string; label: string }[] }
  }
  expect(list.data.definitions.map((d) => d.label)).toEqual(['Blocked', 'Waiting', 'Deploy'])

  const res = await agent('tags.set', {
    ticketKey: 'jira:acme.atlassian.net/MERC-1184',
    tagId: 'deploy',
  })
  expect(res.status).toBe(200)
  await expect(pill('MERC-1184')).toHaveText('Deploy', PUSHED)
})

test('Settings renames a tag, and every ticket carrying it follows', async () => {
  await it.window
    .getByRole('button', { name: /settings/i })
    .first()
    .click()
  const section = it.window.getByRole('region', { name: 'Ticket tags' })
  await section.getByRole('textbox', { name: 'Name of tag 3' }).fill('Ship it')
  await section.getByRole('button', { name: 'Add a tag' }).click()
  await section.getByRole('textbox', { name: 'Name of tag 4' }).fill('Review')
  await section.getByRole('button', { name: 'Save tags' }).click()
  await expect(section.getByText('Saved.')).toBeVisible()

  await it.window.getByRole('button', { name: 'Back to the board' }).click()
  await expect(pill('MERC-1184')).toHaveText('Ship it', PUSHED)

  await pill('MERC-1184').click()
  await expect(menu().getByRole('menuitemradio')).toHaveText([
    'Blocked',
    'Waiting',
    'Ship it',
    'Review',
  ])
  await it.window.keyboard.press('Escape')
})
