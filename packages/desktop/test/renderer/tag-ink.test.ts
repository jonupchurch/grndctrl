import { describe, expect, it } from 'vitest'
import { tagInk } from '../../src/renderer/components/TicketTag.js'

/** The tag's text colour follows the fill the operator chose (010). */
describe('tag text colour', () => {
  it('is white on the default red and green, black on the default yellow', () => {
    expect(tagInk('#d64545')).toBe('#ffffff')
    expect(tagInk('#2f9e44')).toBe('#ffffff')
    expect(tagInk('#e0b100')).toBe('#000000')
  })

  it('is black on white and white on black', () => {
    expect(tagInk('#ffffff')).toBe('#000000')
    expect(tagInk('#000000')).toBe('#ffffff')
  })

  it('falls back to black for something that is not #rrggbb', () => {
    expect(tagInk('red')).toBe('#000000')
  })
})
