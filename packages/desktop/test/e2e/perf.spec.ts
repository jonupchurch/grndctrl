import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'
import { writeLargeBoard, type LargeBoard } from './large-board.js'

/**
 * Filtering is a re-render, not a round trip (T159 — SC-013).
 *
 * Every operation accepts a `projectId`, so filtering server-side was available
 * and was deliberately not used: the filter is applied in the renderer over data
 * already fetched. That decision is what this measures. Doing it the other way
 * would make pressing a project chip four IPC calls and four loading states,
 * and would let the number in a tile briefly disagree with the length of the
 * list beneath it — they narrow from one snapshot precisely so they cannot.
 *
 * **What is timed is the click to the pixels**, inside the page: two animation
 * frames after the event, which is the first moment the operator could see the
 * result. Timing from the test process instead would fold in Playwright's own
 * round trip and measure the harness.
 *
 * The persistence write that a chip press also triggers (T154) is deliberately
 * *not* awaited. It is a fire-and-forget `settings.update` over IPC, and if it
 * were ever on the path to the render this measurement is exactly what should
 * fail.
 */

const BUDGET_MS = 100

let it: LaunchedApp
let board: LargeBoard

test.beforeAll(async () => {
  board = writeLargeBoard()
  it = await launch({ scenario: board.path })
})

test.afterAll(async () => {
  await it.close()
})

/**
 * Click, then wait for the frame after the one that painted it.
 *
 * A single `requestAnimationFrame` fires *before* the paint it schedules; the
 * second one runs after it. React 18 commits in a microtask, so both the commit
 * and the paint are inside this window — which makes this "when could the
 * operator see it", rather than "when did React finish".
 */
async function timeToPaint(selector: string): Promise<number> {
  return it.window.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel)
    if (element === null) throw new Error(`nothing matched ${sel}`)

    const started = performance.now()
    element.click()

    return new Promise<number>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)))
    })
  }, selector)
}

const rowCount = (): Promise<number> =>
  it.window.evaluate(() => document.querySelectorAll('.row').length)

test('the board really is the size SC-013 names', async () => {
  // The guard, and it asserts the **literal numbers from the criterion** rather
  // than `board.items` — which is what the first version did, and which made it
  // a check that the generator agrees with itself. Shrinking the board to
  // twelve items passed: twelve items and eighteen rows are internally
  // consistent, every timing below got faster, and nothing failed.
  await expect(it.window.getByRole('region', { name: 'Tickets' })).toBeVisible()

  expect(board.items).toBe(200)
  expect(board.projects).toBe(6)

  const chips = await it.window
    .getByRole('navigation', { name: 'Filter by project' })
    .getByRole('button')
    .count()

  // Six projects plus "All".
  expect(chips).toBe(7)

  // 200 ticket rows, and only ticket rows: 006 removed the pull request lane
  // (which contributed one row per other item, for 300) and the branch lane
  // (which contributed none, because it rendered local checkouts and the
  // fixture has no paths). The generator no longer builds either, so this is
  // now one row per item with nothing left that could quietly add more.
  expect(await rowCount()).toBe(200)
})

test('selecting a project updates the page within the budget', async () => {
  const before = await rowCount()

  const elapsed = await timeToPaint(
    '[aria-label="Filter by project"] button:nth-of-type(2)',
  )

  // The filter did something. Without this the test would happily report two
  // milliseconds for a click that missed.
  const after = await rowCount()
  expect(after).toBeLessThan(before)
  expect(after).toBeGreaterThan(0)

  expect(elapsed, `filtering ${board.items} items took ${elapsed.toFixed(1)}ms`).toBeLessThan(
    BUDGET_MS,
  )
})

test('widening back out is within the budget too', async () => {
  // The other direction is the one that renders *more*, and it is the one a
  // filter implementation is likelier to get wrong — narrowing shrinks the
  // tree, widening rebuilds it.
  const narrowed = await rowCount()

  const elapsed = await timeToPaint(
    '[aria-label="Filter by project"] button:nth-of-type(2)',
  )

  expect(await rowCount()).toBeGreaterThan(narrowed)
  expect(elapsed, `widening to ${board.items} items took ${elapsed.toFixed(1)}ms`).toBeLessThan(
    BUDGET_MS,
  )
})

test('the court filter is within the budget, and it removes rows', async () => {
  const before = await rowCount()

  const elapsed = await timeToPaint('.tiles button')

  // A third of the fixture is assigned to somebody else, so this must remove
  // something. Measuring a filter that filters nothing measures nothing.
  const after = await rowCount()
  expect(after).toBeLessThan(before)

  expect(elapsed, `the court filter took ${elapsed.toFixed(1)}ms`).toBeLessThan(BUDGET_MS)
})
