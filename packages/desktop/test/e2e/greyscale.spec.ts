import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * Status without colour (T158 — SC-015, FR-074).
 *
 * Colour fails three ways on this board at once, and all three are ordinary
 * rather than edge cases: in greyscale, at the 11px a row mark renders at, and
 * for the ~8% of male developers with a red–green deficiency — for whom
 * `--good` and `--critical` are *the same colour*. On a board whose entire job
 * is "what needs me, at a glance", a status language that resolves only in
 * colour does not work for a substantial fraction of the people it is for.
 *
 * So the claim under test is the strong one: **every severity is distinguishable
 * by shape and label alone**. Not "the greys differ" — different hues do
 * desaturate to different greys, and leaning on that would put the whole
 * distinction into a luminance difference at 11px. Colour is removed entirely
 * rather than desaturated, and then the shapes have to carry it.
 *
 * The scenario exists for this: severity is *derived*, never declared, so
 * putting all four on screen means constructing four work items whose facts
 * produce them — a blocked ticket, changes requested, a draft, and a clean
 * approved one.
 */

const SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
  'every-severity.json',
)

const SEVERITIES = ['good', 'warning', 'serious', 'critical'] as const

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
})

test.afterAll(async () => {
  await it.close()
})

/** The severities currently drawn on a row, deduplicated and sorted. */
const severitiesOnScreen = (): Promise<(string | undefined)[]> =>
  it.window.evaluate(() =>
    [
      ...new Set(
        [...document.querySelectorAll('.row .status-mark')].map(
          (m) => (m as HTMLElement).dataset['severity'],
        ),
      ),
    ].sort(),
  )

test('all four severities are on the board, so this is testing something', async () => {
  // The guard that makes every assertion below mean anything. A scenario that
  // silently stopped producing one severity would leave this file passing while
  // checking three shapes, and "all distinct" is trivially true of fewer.
  //
  // Polled rather than sampled once. `evaluate` does not wait for anything, so
  // the first version read the DOM at whatever moment it happened to run and
  // passed alone while failing under the load of the full suite — React had
  // committed some rows and not others. Every other assertion here is inside a
  // Playwright matcher, which retries; this one had opted out of that.
  await expect.poll(severitiesOnScreen).toEqual(['critical', 'good', 'serious', 'warning'])
})

test('every severity says its name, even when the word is not drawn', async () => {
  // Inside a dense row the label is visually hidden — there is no room for it,
  // and the shape plus the row colour carry it. It stays in the accessibility
  // tree regardless, because a screen reader otherwise gets a coloured `<span>`
  // and no status at all.
  await expect.poll(severitiesOnScreen).toHaveLength(4)

  for (const severity of SEVERITIES) {
    const label = await it.window.evaluate((s) => {
      const mark = document.querySelector(`.row .status-mark[data-severity="${s}"]`)
      return mark?.textContent?.trim() ?? null
    }, severity)

    expect(label?.toLowerCase()).toBe(severity)
  }
})

test('with colour removed entirely, the four marks are still four different shapes', async () => {
  // Every mark forced to one identical ink. Not `grayscale(1)`: that maps four
  // hues to four *different* greys, and a test that passed on those would be
  // asserting the luminance distinction this exists to replace.
  await it.window.addStyleTag({
    content: `
      .status-mark__shape { background: #000 !important; }
      .row, .row[data-severity] { background: #fff !important; }
    `,
  })

  const shots = new Map<string, string>()
  for (const severity of SEVERITIES) {
    const shape = it.window.locator(`.row .status-mark[data-severity="${severity}"] .status-mark__shape`).first()
    await expect(shape).toBeVisible()
    shots.set(severity, (await shape.screenshot()).toString('base64'))
  }

  // Every pair, not just neighbours. The failure this catches is one shape
  // being changed to match another — or `clip-path` being dropped, which makes
  // all four the same square and is invisible in colour.
  for (const a of SEVERITIES) {
    for (const b of SEVERITIES) {
      if (a === b) continue
      expect(shots.get(a), `${a} and ${b} render identically without colour`).not.toBe(shots.get(b))
    }
  }
})

test('the correlation badges are a second alphabet, and it is consistent', async () => {
  /**
   * Present and absent must differ by more than colour: an absent correlation
   * is drawn as a hairline placeholder rather than omitted, and "assigned to
   * me, nothing started" is a sentence the operator reads off the row.
   *
   * **Opacity is neutralised as well as colour**, and that is the whole
   * difference between this assertion and a decorative one. The two states
   * differ in three ways — hue, opacity, and a `scale(0.72)` — and the first
   * two are both tone. Leaving opacity in place let a probe that flattened the
   * colours pass, because 0.5 grey and 0.85 grey are still two greys. At 9px
   * that is not a distinction anyone reads. Size is.
   */
  await it.window.addStyleTag({
    content: `
      .badge__shape {
        background: #000 !important;
        border-color: #000 !important;
        opacity: 1 !important;
      }
    `,
  })

  /**
   * Compared **within one kind**, which the first version of this did not.
   *
   * It took the first present badge and the first absent badge on the page —
   * which are different *kinds*, so it was comparing a square to a triangle and
   * reporting that present and absent look different. It passed with the size
   * difference deliberately deleted, because the shapes never matched to begin
   * with. Found by probing, not by reading.
   */
  const kind = 'agent'
  const present = await it.window
    .locator(`.row .badge[data-kind="${kind}"][data-present="true"] .badge__shape`)
    .first()
    .screenshot()
  const absent = await it.window
    .locator(`.row .badge[data-kind="${kind}"][data-present="false"] .badge__shape`)
    .first()
    .screenshot()

  expect(
    present.toString('base64'),
    'a present and an absent agent badge are indistinguishable without colour',
  ).not.toBe(absent.toString('base64'))

  // And each carries its own word, so the row is readable without any of it.
  const labels = await it.window.evaluate(() =>
    [...document.querySelectorAll('.row .badge')].map((b) => b.textContent?.trim() ?? ''),
  )
  expect(labels.some((l) => l.startsWith('no '))).toBe(true)
  expect(labels.every((l) => l.length > 0)).toBe(true)
})

test('the board is still readable with the whole page desaturated', async () => {
  // The literal wording of SC-015 — "verified by rendering the board
  // desaturated". The assertions above are stronger, but this is the one that
  // would catch a component reintroducing a colour-only distinction somewhere
  // this file does not know to look, because it reads the text.
  await it.window.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' })

  const rows = it.window.getByRole('region', { name: 'Tickets' })
  await expect(rows.getByText('MERC-2001')).toBeVisible()

  // Severity is not the only thing colour could have been carrying. Each of
  // these is a word, in greyscale, on a row.
  await expect(rows.getByText('Blocked')).toBeVisible()
  await expect(it.window.getByRole('region', { name: 'Ball in court' }).getByText('waiting on you')).toBeVisible()
})
