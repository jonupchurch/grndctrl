import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'
import { fitOf } from './truncation.js'

/**
 * The ticket key column, over a project whose keys do not fit it (0.6.1).
 *
 * `board.spec.ts` asserts that no key is cut off, and it passes on the
 * canonical fixture *whether or not this feature exists* — `MERC-1184` measures
 * around 75px and the column was a fixed 82px, so the bug the operator reported
 * was never reachable from that scenario. A test that cannot fail is not a
 * guard, it is a claim.
 *
 * So this file runs the same board under `PLATFORM-1184`: thirteen characters
 * where the other is nine, and comfortably past 82px in any font this ships to.
 * Every assertion below fails on 0.6.0.
 *
 * It is a separate scenario rather than a fourth ticket in the canonical one
 * because three other specs name MERC tickets by hand — a shared fixture that
 * has to be edited in step with them is one that eventually is not.
 */

const SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
  'long-ticket-keys.json',
)

/** The width the column was fixed at, and the number this feature exists to beat. */
const WAS = 82

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  // `launch` returns at `domcontentloaded`, which is before React has drawn a
  // row. Every test in this file reads the DOM directly — `evaluate` and the
  // measuring helper, neither of which waits for anything — so the wait has to
  // be here. Without it the first test races the first paint and reads an empty
  // lane: it failed exactly once, in a full-suite run on a loaded machine, and
  // passed twenty-four consecutive times on its own.
  await it.window.locator('section.lane[data-region="tickets"] .row .row__id').first().waitFor()
})

test.afterAll(async () => {
  await it.close()
})

test('a long ticket key is drawn in full', async () => {
  const readings = await fitOf(it.window, 'section.lane[data-region="tickets"] .row .row__id')

  expect(readings.length).toBeGreaterThan(1)

  // The fixture is only worth having if its keys are the long ones. Without
  // this the assertions below would keep passing against a scenario somebody
  // had quietly shortened.
  for (const { text } of readings) expect(text.length).toBeGreaterThan(9)

  for (const { text, box, natural } of readings) {
    expect(natural, `${text} wants ${natural}px and has ${box}px`).toBeLessThanOrEqual(box)
  }
})

test('the column grew past the width it used to be fixed at', async () => {
  const lane = it.window.locator('section.lane[data-region="tickets"]')

  const width = await lane.evaluate((element) => ({
    // The inline override, which is the measurement actually arriving. The
    // computed value alone would still read 82px from the stylesheet fallback
    // if the plumbing between `idWidth.ts` and the DOM were cut.
    inline: (element as HTMLElement).style.getPropertyValue('--id-w'),
    cell: Math.round(element.querySelector('.row .row__id')?.getBoundingClientRect().width ?? 0),
  }))

  expect(width.inline).toMatch(/^\d+px$/)
  expect(Number.parseInt(width.inline, 10)).toBeGreaterThan(WAS)
  expect(width.cell).toBeGreaterThan(WAS)
})

test('the heading still sits over the column it grew', async () => {
  // The width is set on the lane, so the heading row reads the same track as
  // the rows. A per-row implementation passes both tests above and fails this.
  const offsets = await it.window.evaluate(() => {
    const lane = document.querySelector('section.lane[data-region="tickets"]')
    const left = (root: Element | null, slot: string): number | null => {
      const cell = root?.querySelector(slot) ?? null
      return cell === null ? null : Math.round(cell.getBoundingClientRect().left)
    }

    const head = lane?.querySelector('.lane__headings') ?? null
    const rows = Array.from(lane?.querySelectorAll('.row') ?? [])

    return {
      head: left(head, '.row__title'),
      rows: rows.map((row) => left(row, '.row__title')),
    }
  })

  expect(offsets.rows.length).toBeGreaterThan(1)

  for (const row of offsets.rows) {
    expect(Math.abs((offsets.head ?? 0) - (row ?? 0))).toBeLessThanOrEqual(1)
  }
})
