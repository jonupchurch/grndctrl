import { describe, expect, it } from 'vitest'
import {
  identifierTrack,
  idTextMeasurer,
  tabular,
  ID_TRACK_CEILING,
  ID_TRACK_FLOOR,
  type Measure,
} from '../../src/renderer/lanes/idWidth.js'

/**
 * The width of the ticket key column (0.6.1).
 *
 * The property under test is one-directional: the column may be wider than the
 * key, never narrower. A column that is too wide costs the summary some
 * characters and is visibly a design choice; a column that is too narrow
 * ellipsises the identifier, which is the string the operator is reading the
 * row to get.
 *
 * So the assertions below are mostly `toBeGreaterThanOrEqual`. An exact width
 * would pin this to a font and break on a machine that resolves `system-ui`
 * differently, which is every second machine.
 *
 * The measurer is faked here because the desktop unit runner has no DOM at all.
 * `board.spec.ts` is where a real Chromium checks that a rendered key actually
 * fits its cell — this file checks the arithmetic that sits between them.
 */

/** A stand-in font: eight pixels a character, and nothing is proportional. */
const monospace =
  (perCharacter = 8): Measure =>
  (text) =>
    text.length * perCharacter

describe('identifierTrack', () => {
  it('fits the widest identifier it is given', () => {
    const width = identifierTrack(['MERC-1', 'PLATFORM-12345', 'MERC-1184'], monospace())

    expect(width).toBeGreaterThanOrEqual('PLATFORM-12345'.length * 8)
  })

  it('is not decided by character count, but by measured width', () => {
    // Same length, and the second is the wider string in any real font. A
    // widest-by-`.length` implementation passes every other test in this file
    // and fails this one.
    const measure: Measure = (text) => (text.startsWith('W') ? 200 : 40)

    expect(identifierTrack(['IIII-1', 'WWWW-1'], measure)).toBeGreaterThanOrEqual(200)
  })

  it('holds the floor for short keys, so the heading keeps its caret', () => {
    expect(identifierTrack(['AB-1'], monospace())).toBe(ID_TRACK_FLOOR)
  })

  it('holds the floor for a lane with nothing in it', () => {
    expect(identifierTrack([], monospace())).toBe(ID_TRACK_FLOOR)
  })

  it('will not let one absurd key eat the summary', () => {
    const width = identifierTrack(['A'.repeat(400)], monospace())

    expect(width).toBe(ID_TRACK_CEILING)
  })

  it('falls back to the floor rather than collapsing when the measurer is blind', () => {
    // What `idTextMeasurer` returning null resolves to at the call site, and
    // what a canvas that has lost its font returns on its own.
    expect(identifierTrack(['PLATFORM-12345'], () => 0)).toBe(ID_TRACK_FLOOR)
  })

  it('survives a measurer returning NaN, which would otherwise poison every later key', () => {
    const measure: Measure = (text) => (text === 'BAD-1' ? Number.NaN : text.length * 8)

    expect(identifierTrack(['BAD-1', 'PLATFORM-12345'], measure)).toBeGreaterThanOrEqual(
      'PLATFORM-12345'.length * 8,
    )
  })
})

describe('tabular figures', () => {
  it('measures every digit at the same advance, because the cell draws them that way', () => {
    // The bug this exists for: `1` is a narrow glyph proportionally and a
    // full-width one under `font-variant-numeric: tabular-nums`, which is what
    // `.row__id` sets and what a canvas cannot be told. A column built to the
    // proportional reading is a column the key does not fit.
    const proportional: Measure = (text) =>
      [...text].reduce((width, glyph) => width + (glyph === '1' ? 2 : 10), 0)

    // `AAAA-1111` proportionally reads 4 letters and a dash at 10 plus four 1s
    // at 2 — 58. Drawn, the digits take 10 each, so it is 90.
    expect(identifierTrack(['AAAA-1111'], proportional)).toBeGreaterThanOrEqual(90)
  })

  it('leaves letters alone, which tabular-nums does not touch', () => {
    expect(tabular('PLATFORM-1184')).toBe('PLATFORM-0000')
    expect(tabular('MERC-1184')).toBe('MERC-0000')
    expect(tabular('NODIGITS')).toBe('NODIGITS')
  })
})

describe('idTextMeasurer', () => {
  it('declines rather than guessing when there is no document', () => {
    // This runner is the `node` environment, which is the condition itself.
    expect(typeof document).toBe('undefined')
    expect(idTextMeasurer()).toBeNull()
  })
})
