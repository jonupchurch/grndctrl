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

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
})

test.afterAll(async () => {
  await it.close()
})

/*
 * Three tests stood here and are gone, and this note is longer than a deletion
 * deserves because what went with them is a guarantee rather than a detail.
 *
 * They were: all four severities present on the board; each mark carrying its
 * own name in the accessibility tree; and, with colour removed entirely, the
 * four marks rendering as four different shapes. Together they were FR-074 --
 * severity is never carried by colour alone -- checked against a real window.
 *
 * **The ticket row's severity mark was removed on 2026-08-20, on the operator's
 * instruction, with this cost stated before it was taken.** `data-severity` on
 * the row is now the only carrier and it is a colour. That is the thing FR-074
 * forbids, so the requirement is departed from rather than merely untested; the
 * decision is recorded in `specs/001-ground-control-v1/spec.md` beside it.
 *
 * **These could not be repointed at another surface, and that was checked
 * rather than assumed.** `StatusMark` is still drawn by the stat tiles and the
 * session lane, so three severities still reach a mark somewhere -- but the
 * tiles can only ever produce `good` or `serious`, and a session's state maps
 * only to `good`, `serious` or `critical`. **Nothing on the board can produce a
 * `warning` mark any more**, so "all four shapes differ" has no way to put four
 * shapes on a screen.
 *
 * The test below survives because it does not depend on the row: the
 * desaturated-page check reads the whole board rather than a mark. A second one,
 * on the correlation badges, went with the Agent column in 0.7.0.
 *
 * If the row mark ever comes back, restore all three from git history rather
 * than rewriting them -- the third in particular took some care to get right,
 * and its comment explains why `grayscale(1)` was the wrong instrument.
 */

test('the board is still readable with the whole page desaturated', async () => {
  // The literal wording of SC-015 — "verified by rendering the board
  // desaturated". The assertions above are stronger, but this is the one that
  // would catch a component reintroducing a colour-only distinction somewhere
  // this file does not know to look, because it reads the text.
  await it.window.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' })

  const rows = it.window.getByRole('region', { name: 'Tickets' })
  await expect(rows.getByText('MERC-2001')).toBeVisible()

  // Severity is not the only thing colour could have been carrying. Each of
  // these is a word, in greyscale — the ticket's own status on a row, and the
  // tiles' labels above them. The ball-in-court panel carried the third and was
  // removed on 2026-08-31; the fact it stated is in the first tile's own words.
  await expect(rows.getByText('Blocked')).toBeVisible()
  await expect(it.window.getByRole('button', { name: /Your court/ })).toContainText(
    /press to show only yours|showing only yours/,
  )
})
