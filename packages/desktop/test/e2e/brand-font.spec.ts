import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The wordmark is set in the font it names.
 *
 * `--f-brand: Archivo, var(--f-ui)` sat in the tokens for weeks with no Archivo
 * anywhere in the tree, so the wordmark quietly set in the UI face and the
 * locked brand direction — 1a "Tracking", chosen on Archivo 600's letterforms —
 * was never on screen. Nothing failed, because a CSS font stack falling through
 * to its next entry *is* the correct behaviour of a font stack.
 *
 * That is why this test exists rather than a unit test over the CSS. Every step
 * between the file and the glyph can fail silently and independently: esbuild
 * might not emit the asset, the rewritten relative URL might not resolve under
 * `file:`, and `font-src 'self'` in the CSP might refuse it. All three produce a
 * page that looks fine and a wordmark in the wrong typeface, and only the
 * running application can tell them apart.
 *
 * **`document.fonts.check()` cannot answer this, and the first version of this
 * file used it.** It reports whether every matching face is loaded — so with no
 * `@font-face` for Archivo at all there are zero unloaded faces and it returns
 * `true`. Deleting the whole rule left all three tests passing. It answers
 * "nothing is missing", not "the font is here", which is the same empty-versus-
 * could-not-look confusion this project keeps finding, this time inside a
 * browser API.
 *
 * So the assertions below look at `document.fonts` itself — a face with this
 * family, in `loaded` state — and then measure. Two strings rendered in Archivo
 * and in the fallback have different advance widths; if they match to the pixel,
 * the glyphs on screen are not the ones this file claims.
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

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
})

test.afterAll(async () => {
  await it.close()
})

test('an Archivo face exists and reached the loaded state', async () => {
  // The set, not `check()`. An empty result here is a failure rather than a
  // pass, which is the entire difference between this and the version that
  // passed with the rule deleted.
  //
  // `fonts.ready` first, because `font-display: swap` means the first paint
  // deliberately happens before the face arrives — without it this would race
  // the behaviour the declaration asks for.
  await expect
    .poll(() =>
      it.window.evaluate(async () => {
        await document.fonts.ready
        return [...document.fonts]
          .filter((face) => face.family.replace(/['"]/g, '') === 'Archivo')
          .map((face) => face.status)
      }),
    )
    .toEqual(['loaded'])
})

test('the glyphs on screen are Archivo, not the fallback wearing its name', async () => {
  // The strongest available evidence short of a screenshot. A declared-but-
  // unreachable face leaves the browser drawing the fallback while every piece
  // of metadata still says Archivo; the advance widths are what actually differ.
  const { archivo, fallback } = await it.window.evaluate(async () => {
    await document.fonts.ready
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx === null) return { archivo: 0, fallback: 0 }

    ctx.font = '600 15px Archivo'
    const archivo = ctx.measureText('Ground Control').width
    // A family that certainly does not exist, so the browser resolves it to the
    // default face. If Archivo were also missing, both measurements would come
    // from that same default and land on the identical number.
    ctx.font = '600 15px NoSuchFamilyAnywhere'
    const fallback = ctx.measureText('Ground Control').width
    return { archivo, fallback }
  })

  expect(archivo).toBeGreaterThan(0)
  expect(archivo).not.toBeCloseTo(fallback, 1)
})

test('the wordmark actually resolves to Archivo, not to the fallback', async () => {
  // The stack is `Archivo, var(--f-ui)`, so `getComputedStyle` reports the whole
  // stack whether or not the first entry loaded — reading that would pass in
  // exactly the broken state this is here to catch. The load check above is what
  // makes this meaningful; this asserts the element is asking for it at all.
  const family = await it.window.evaluate(() => {
    const word = document.querySelector('.titlebar__word')
    return word === null ? null : getComputedStyle(word).fontFamily
  })

  expect(family).not.toBeNull()
  expect(family).toContain('Archivo')
})

test('the subset covers the characters a heading can contain', async () => {
  // Subset to printable ASCII rather than to the eleven letters of "Ground
  // Control", because `--f-brand` is on `.shell h1` too and that heading carries
  // whatever text the state needs. A per-glyph fallback inside a single word is
  // the kind of defect nobody reports and everybody notices.
  //
  // Measured rather than asked. `check(font, text)` has the same vacuous-true
  // problem as the bare form, and would report full coverage of a font that is
  // not there — so each string is compared against the fallback the same way.
  const widths = await it.window.evaluate(async () => {
    await document.fonts.ready
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx === null) return []

    return ['Ground Control', 'Could not reach the service (0-9)', 'jq: {}[]/@#%&*'].map((text) => {
      ctx.font = '600 15px Archivo'
      const withFont = ctx.measureText(text).width
      ctx.font = '600 15px NoSuchFamilyAnywhere'
      return { text, withFont, fallback: ctx.measureText(text).width }
    })
  })

  expect(widths).toHaveLength(3)
  for (const { withFont, fallback } of widths) {
    // A string containing one uncovered glyph falls back for that glyph alone,
    // which moves the total width toward the fallback's — so equality here is
    // the signal that the subset does not reach.
    expect(withFont).toBeGreaterThan(0)
    expect(withFont).not.toBeCloseTo(fallback, 1)
  }
})
