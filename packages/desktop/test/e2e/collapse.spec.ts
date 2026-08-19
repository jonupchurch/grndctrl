import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * Every region folds, and folding removes it (T105 — FR-143, FR-144, FR-145).
 *
 * The board is about to carry seven regions. Not all of them are wanted at once
 * and which ones are wanted depends on what the operator is doing, so each one
 * folds and the choice survives a restart.
 *
 * **The assertion that matters is that the contents are gone from the page**,
 * not that a class changed. `display: none` would satisfy any test written
 * against a class or against `toBeVisible`, and it would be wrong here for a
 * reason this repository has already been bitten by: `perf.spec.ts` and
 * `greyscale.spec.ts` both count elements with `querySelectorAll`, which cannot
 * tell a hidden row from a visible one. A folded ticket lane implemented in CSS
 * would leave two hundred rows in the tree and both counts would go on passing
 * over work the operator had asked not to be done.
 *
 * So the counts below are of *elements*, taken from inside the region, and every
 * one of them is checked to be non-zero first — an assertion that something
 * dropped to zero is worthless if it was zero to begin with.
 *
 * **Every count is polled rather than sampled.** `page.evaluate` waits for
 * nothing, so it reads the DOM at whichever moment it happens to run, and the
 * first version of this file read the tile row before React had committed it:
 * the guard fired saying the region "rendered nothing to begin with", which is
 * the correct complaint about an incorrect measurement. Every other assertion
 * here is inside a Playwright matcher, which retries; these had opted out of
 * that. `greyscale.spec.ts` carries the same note for the same reason.
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

/**
 * The region ids, as literals, exactly as the components spell them.
 *
 * Written out rather than read off the page. A test that discovered the ids
 * would agree with whatever the renderer currently emits, including a generated
 * one — and "the ids are stable literals" is the property that makes a folded
 * region still folded after an upgrade.
 */
const REGIONS = ['summary', 'connections', 'tickets', 'active-ticket', 'sessions', 'court'] as const

let it: LaunchedApp

const region = (id: string) => it.window.locator(`[data-region="${id}"]`)
const toggle = (id: string) => region(id).locator('.section__toggle')

/** How many elements the region is currently rendering inside its body. */
const bodySize = (id: string): Promise<number> =>
  it.window.evaluate(
    (rid) => document.querySelectorAll(`[data-region="${rid}"] .section__body *`).length,
    id,
  )

test.afterEach(async () => {
  await it.close()
})

test('every region on the board can be folded, and starts open', async () => {
  it = await launch({ scenario: SCENARIO })

  for (const id of REGIONS) {
    await expect(region(id), `no region '${id}' on the board`).toHaveCount(1)
    await expect(toggle(id)).toHaveAttribute('aria-expanded', 'true')

    // The control names what it controls, and that element exists. A dangling
    // `aria-controls` is a reference a screen reader follows to nothing, and it
    // is exactly what happens if the body is only rendered when expanded.
    const controls = await toggle(id).getAttribute('aria-controls')
    expect(controls, id).toBe(`region-${id}`)
    await expect(it.window.locator(`#${controls ?? 'missing'}`)).toHaveCount(1)
  }
})

test('folding a region removes its contents from the page, not merely from view', async () => {
  it = await launch({ scenario: SCENARIO })

  for (const id of REGIONS) {
    // Non-zero first. Every assertion below is that a number fell to zero, and
    // a number that started at zero would make all of them pass over a region
    // that was never rendering anything.
    await expect
      .poll(() => bodySize(id), { message: `region '${id}' rendered nothing to begin with` })
      .toBeGreaterThan(0)
    const before = await bodySize(id)

    await toggle(id).click()
    await expect(toggle(id)).toHaveAttribute('aria-expanded', 'false')
    await expect(region(id)).toHaveAttribute('data-collapsed', 'true')

    await expect
      .poll(() => bodySize(id), { message: `region '${id}' kept its contents when folded` })
      .toBe(0)

    await toggle(id).click()
    await expect(toggle(id)).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(() => bodySize(id), { message: `region '${id}' did not come back` })
      .toBe(before)
  }
})

/**
 * The one that the whole "do not render" decision is for.
 *
 * `.row` is what `perf.spec.ts` counts against SC-013's two hundred and what
 * `greyscale.spec.ts` counts severities across. If a folded lane left its rows
 * in the tree, both would carry on counting them.
 */
test('a folded ticket lane leaves no rows anywhere on the page', async () => {
  it = await launch({ scenario: SCENARIO })

  const rows = (): Promise<number> =>
    it.window.evaluate(() => document.querySelectorAll('.row').length)

  await expect.poll(rows).toBeGreaterThan(0)

  await toggle('tickets').click()
  await expect(toggle('tickets')).toHaveAttribute('aria-expanded', 'false')

  await expect.poll(rows).toBe(0)
})

/**
 * FR-145. Folding is "I am not reading this now", not "stop telling me".
 *
 * The freshness reading is the sharp case: the seeded connection has no
 * credential, so the ticket lane is failing to refresh, and a fold that took
 * that sentence off the screen would have turned tidying the board into a way of
 * not being told a connection is broken.
 */
test('a folded region keeps its count and its freshness in the header', async () => {
  it = await launch({ scenario: SCENARIO })

  const tickets = region('tickets')
  await expect(tickets.locator('.lane__count')).toHaveCount(1)
  const count = await tickets.locator('.lane__count').textContent()
  expect(count?.trim()).not.toBe('')

  // The lane is in one of its two legitimate readings — see `board.spec.ts` for
  // why either is correct here.
  await expect(tickets.getByText(/last refreshed|failed to refresh/)).toBeVisible()

  await toggle('tickets').click()
  await expect(toggle('tickets')).toHaveAttribute('aria-expanded', 'false')

  expect(await tickets.locator('.lane__count').textContent()).toBe(count)
  await expect(tickets.getByText(/last refreshed|failed to refresh/)).toBeVisible()

  // And the connection notice keeps saying how many connections are broken.
  await toggle('connections').click()
  await expect(toggle('connections')).toHaveAttribute('aria-expanded', 'false')
  expect(await region('connections').locator('.lane__count').textContent()).not.toBe('')
})

test('what was folded is still folded after a restart', async () => {
  it = await launch({ scenario: SCENARIO })
  const dir = it.dir

  await toggle('court').click()
  await toggle('sessions').click()
  await expect(toggle('court')).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle('sessions')).toHaveAttribute('aria-expanded', 'false')

  // Past the write. The persist is fire-and-forget over IPC, like every other
  // settings write on this board.
  await it.window.waitForTimeout(400)
  await it.app.close()

  it = await launch({ env: { GRNDCTRL_DATA_DIR: dir } })
  it.dir = dir

  await expect(toggle('court')).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle('sessions')).toHaveAttribute('aria-expanded', 'false')

  // And the three nobody touched are still open, so this is not asserting that
  // everything came back folded.
  await expect(toggle('tickets')).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle('summary')).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle('connections')).toHaveAttribute('aria-expanded', 'true')
})

/**
 * Only the folded regions are stored.
 *
 * The map is "what is put away", so expanding a region removes its key rather
 * than writing `false`. Otherwise the stored object grows a key for every region
 * the operator has ever touched, and a renamed region leaves a dead one behind
 * for good.
 */
test('expanding a region removes it from the stored map rather than writing false', async () => {
  it = await launch({ scenario: SCENARIO })

  const stored = (): Promise<Record<string, boolean>> =>
    it.window.evaluate(async () => {
      const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
        settings: { get(input: unknown): Promise<{ ok: boolean; data: unknown }> }
      }
      const result = await bridge.settings.get({})
      if (!result.ok) throw new Error('settings.get failed')
      return (result.data as { collapsedRegions: Record<string, boolean> }).collapsedRegions
    })

  expect(await stored()).toEqual({})

  await toggle('court').click()
  await expect.poll(stored).toEqual({ court: true })

  await toggle('court').click()
  await expect.poll(stored).toEqual({})
})
