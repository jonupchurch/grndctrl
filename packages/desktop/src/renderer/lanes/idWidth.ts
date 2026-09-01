/**
 * How wide the ticket-key column has to be (0.6.1).
 *
 * The key column was a fixed 82px, and `MERC-1184` at `--t-id` semibold lands
 * within a pixel or two of that — so it ellipsised, and the one column on the
 * board whose whole job is to be copied out and typed into a search box was the
 * one the operator could not read.
 *
 * ## Why this is not `auto`
 *
 * The obvious fix is a content-sized track, and it is wrong here for the reason
 * `app.css` already records against the trailing slot: **every row is its own
 * grid container**. `auto` sizes each row independently, so a lane holding
 * `MERC-9` and `PLATFORM-12345` would draw its title column at two different
 * left edges and the heading row, which has neither string in it, at a third.
 * The lane would still *look* deliberate. `board.spec.ts` asserts the headings
 * sit over their columns and would catch it, which is the only reason that is
 * not a silent failure.
 *
 * So the width is measured once for the whole lane and set on `.lane`, where
 * the column template already lives. One number, every row, headings included.
 *
 * ## Why the measurement is injected
 *
 * `identifierTrack` takes the measurer rather than reaching for a canvas, so
 * the clamping — which is the part with the decisions in it — is a pure
 * function testable under the desktop unit runner, which has no DOM at all.
 * `idTextMeasurer` is the half that needs one, and it returns `null` rather
 * than guessing when it cannot have one.
 */

/** Measures a string in the ticket key's own font, in CSS pixels. */
export type Measure = (text: string) => number

/**
 * The floor, and the width the column used to be.
 *
 * Not chosen for the keys: chosen for the *heading*, which is a sort button
 * reading `TICKET` and grows a caret when it is the sorted column. A track that
 * shrank to fit `AB-1` would render `TICK…▼` on a four-character project, and
 * the heading would go unreadable exactly when it is the one being read — the
 * mistake `app.css` records against the priority and points tracks.
 */
export const ID_TRACK_FLOOR = 82

/**
 * The ceiling.
 *
 * The title is the only flexible track, so every pixel this column takes comes
 * out of the ticket summary. A malformed or absurd key must not be able to eat
 * the lane; past this it ellipsises again, which is the old failure but bounded
 * and only for a key no tracker actually issues.
 */
export const ID_TRACK_CEILING = 220

/**
 * Slack past the measured width, in whole pixels.
 *
 * A grid track is laid out in fractional pixels and `text-overflow` fires on
 * *any* overflow, so a track rounded to the measurement exactly is a coin flip.
 * `Math.ceil` and this together mean the cell is always a little wider than the
 * string in it rather than sometimes a fifth of a pixel narrower.
 *
 * Two pixels, not more. Every pixel here comes out of the ticket summary, which
 * is the only flexible track on the row.
 */
const ID_TRACK_PAD = 2

/**
 * An identifier rewritten so a canvas measures it the way the board draws it.
 *
 * `.row__id` sets `font-variant-numeric: tabular-nums` and **there is no way to
 * tell a canvas that**: the 2D context takes a font shorthand, which carries
 * family, style, weight and size and stops there. Under tabular figures every
 * digit takes the advance of the widest one, so a proportional measurement of
 * `PLATFORM-1184` — where `1` is a narrow glyph — comes back short of what is
 * actually painted.
 *
 * Not a rounding error. On the fixture this was found with, the real cell is
 * 115.2px and the proportional reading is 110.92px; the column was built to the
 * smaller number and the key it was widened for still ended in an ellipsis. The
 * DOM agreed with the CSS and disagreed with the screen — `scrollWidth` and
 * `clientWidth` both round, so both read 115 and reported that everything fit.
 *
 * Substituting `0` for every digit measures the tabular advance directly, and
 * reproduces the laid-out width to a hundredth of a pixel. Letters are left
 * alone: `tabular-nums` does not touch them.
 */
export function tabular(identifier: string): string {
  return identifier.replace(/[0-9]/g, '0')
}

/**
 * The width of the key column for a lane holding these identifiers.
 *
 * Always returns a usable width: no identifiers, or a measurer that returns
 * nothing finite, gives the floor rather than a collapsed column.
 */
export function identifierTrack(identifiers: readonly string[], measure: Measure): number {
  let widest = 0

  for (const identifier of identifiers) {
    const width = measure(tabular(identifier))
    // A measurer that has lost its font returns 0, and `NaN` propagates through
    // `Math.max` to poison every later comparison. Neither is worth a throw —
    // both mean "no reading", and no reading means the floor.
    if (Number.isFinite(width) && width > widest) widest = width
  }

  if (widest === 0) return ID_TRACK_FLOOR

  return Math.min(ID_TRACK_CEILING, Math.max(ID_TRACK_FLOOR, Math.ceil(widest) + ID_TRACK_PAD))
}

let canvas: CanvasRenderingContext2D | null | undefined

/**
 * A measurer in `.row__id`'s font, or `null` where there is no document.
 *
 * The font is read off the custom properties rather than off a rendered cell,
 * because the first lane is measured before any cell exists. That makes this
 * the one place that has to agree with `app.css` by hand: `--t-id` and weight
 * 600 are `.row__id`'s, and `--f-ui` is what it inherits from `body`. A
 * mismatch here does not throw — it under-measures, and the column clips again.
 * `board.spec.ts` asserts against the rendered cells for that reason.
 */
export function idTextMeasurer(): Measure | null {
  if (typeof document === 'undefined') return null

  if (canvas === undefined) canvas = document.createElement('canvas').getContext('2d')
  if (canvas === null) return null

  const context = canvas
  const root = getComputedStyle(document.documentElement)
  const size = root.getPropertyValue('--t-id').trim() || '15px'
  const family = root.getPropertyValue('--f-ui').trim() || 'sans-serif'

  context.font = `600 ${size} ${family}`

  // Canvas rejects a font it cannot parse by silently keeping the previous one,
  // which starts out as 10px sans-serif. That would under-measure by a third
  // and clip every key, so an unparsed font is treated as no measurer at all.
  if (!context.font.includes(size)) return null

  return (text) => context.measureText(text).width
}
