import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * The agent console, from a fixture alone (T145, T150).
 *
 * Every other spec for these three regions drives them over the loopback API,
 * which is right for testing the *push* — an agent acts, the board moves. This
 * one asserts something different: that a scenario file can put the console into
 * a populated state with nothing running, which is what makes the fixture usable
 * as test material rather than a file nobody reads.
 *
 * **It is also the only automated check on the arrangement.** T145 puts the
 * ticket lane, the active ticket and the update stream in the main column and
 * leaves sessions, ball-in-court and prompts in the side rail. Nothing else
 * would notice if a later edit moved one, because every other spec asks for a
 * region by name and does not care where it is.
 *
 * There are no loopback calls anywhere in this file, deliberately. If one
 * appears, the fixture has stopped being the thing under test.
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

const ACTIVE = 'MERC-1184'

let it: LaunchedApp

const region = (name: RegExp) => it.window.getByRole('region', { name })

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
  await expect(region(/^tickets$/i)).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await it.close()
})

test('the active ticket comes up already set, with its description rendered', async () => {
  const panel = region(/active ticket/i)

  await expect(panel).toContainText(ACTIVE)
  // The description is the part a fixture is most worth having: it is provider
  // content converted at ingest, and nothing else in the suite renders one
  // without an agent first setting focus over MCP.
  await expect(panel).toContainText(/Acceptance criteria/)
  await expect(panel.locator('.doc__table')).toBeVisible()
  await expect(panel.locator('.doc__code')).toBeVisible()
})

test('the update stream comes up populated, newest first', async () => {
  const updates = region(/agent updates/i).locator('.update:not(.update--question)')

  await expect(updates).toHaveCount(3)
  // Newest first is a property of the read, and the fixture's three are twenty
  // minutes apart so the order is a real one rather than a tie.
  await expect(updates.first()).toContainText(/Rewriting the guard/)
  await expect(updates.last()).toContainText(/Reproduced it/)
})

test('each update carries the ticket that was active when it was posted', async () => {
  // The seeder sets focus before posting, in that order, because `updates.post`
  // captures the active ticket at write time. A seeder that posted first would
  // produce a stream with no ticket on it and nothing here would say so — this
  // asserts the author instead, which is filled from the session by the same
  // rule and is visible on the row.
  await expect(region(/agent updates/i).locator('.update__agent').first()).toHaveText('claude-code')
})

test('the prompt shelf comes up populated, and the rows are previews', async () => {
  const prompts = region(/recent prompts/i).locator('.prompt')

  await expect(prompts).toHaveCount(2)
  await expect(prompts.first()).toContainText(/Review this diff/)

  // The row shows a preview and the store holds the whole thing. The fixture's
  // first prompt is 162 characters and the cut is at 160, so the rendered row
  // must be shorter than what was recorded.
  const shown = await prompts.last().locator('.prompt__text').innerText()
  expect(shown.length).toBeLessThan(162)
  expect(shown.endsWith('…')).toBe(true)
})

test('the arrangement is the one T145 specifies', async () => {
  /*
   * Asserted by which column each region is in, not by pixel position.
   *
   * The main column is the work: what is on your plate, what is being worked,
   * what is being said about it. The side rail is context. The active ticket
   * moved into the main column because it renders a description, and 320px is
   * not a width you can read a table in.
   */
  const columnOf = (id: string): Promise<string> =>
    it.window.evaluate((region) => {
      const element = document.querySelector(`[data-region="${region}"]`)
      if (element === null) return '(absent)'
      if (element.closest('.board__main') !== null) return 'main'
      if (element.closest('.board__side') !== null) return 'side'
      return '(neither)'
    }, id)

  expect(await columnOf('tickets')).toBe('main')
  expect(await columnOf('active-ticket')).toBe('main')
  expect(await columnOf('updates')).toBe('main')

  expect(await columnOf('sessions')).toBe('side')
  expect(await columnOf('court')).toBe('side')
  expect(await columnOf('prompts')).toBe('side')
})
