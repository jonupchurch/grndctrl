import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * What a scenario file alone can put on the board (T145, T150).
 *
 * Every other spec for these regions drives them over the loopback API, which is
 * right for testing the *push* — an agent acts, the board moves. This one
 * asserts something different: that a scenario file can put the board into a
 * populated state with nothing running, which is what makes the fixture usable
 * as test material rather than a file nobody reads.
 *
 * **It is also the only automated check on the arrangement.** Nothing else would
 * notice if a later edit moved a region, because every other spec asks for one
 * by name and does not care where it is.
 *
 * **Two of its five tests went on 2026-08-31**, with the update stream and the
 * prompt shelf they read. The fixture still seeds both — an agent still records
 * them over MCP and the store still holds them — so what is lost here is the
 * assertion that a *board* renders them, which is exactly the thing that is no
 * longer true. `test/services` still covers the writes.
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

test('the arrangement is one column, in the order the board reads in', async () => {
  /*
   * Asserted by document order within the one stack, not by pixel position.
   *
   * It used to be a two-column grid and this test named which column each
   * region sat in. The operator removed the rail's three regions and the update
   * stream on 2026-08-31, so there is one column and the property worth holding
   * is what remains of the old one: the work first, what is being worked next,
   * and what *happened* last — below the fold, where a question asked far less
   * often belongs.
   *
   * The absent check is the load-bearing half. A region that failed to render
   * would otherwise leave a list of two in the right relative order and pass.
   */
  const order = await it.window.evaluate(() =>
    [...document.querySelectorAll('.board__stack [data-region]')].map(
      (element) => element.getAttribute('data-region') ?? '(unnamed)',
    ),
  )

  expect(order).toEqual(['tickets', 'active-ticket', 'ticket-history'])

  // And nothing is beside them. A rail reintroduced without this file noticing
  // is how the arrangement drifted the first time.
  expect(await it.window.locator('.board__side, .board__main').count()).toBe(0)
})
