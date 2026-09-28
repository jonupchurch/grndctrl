import { describe, expect, it } from 'vitest'
import { formatHours } from '../../src/renderer/components/Row.js'

/**
 * The Logged column's figure.
 *
 * Jira sends seconds and the operator reads hours. The cases worth pinning are
 * the small ones: a quarter-hour worklog must not round to nothing, and zero —
 * which a ticket carries after its worklogs are deleted — must still read as a
 * number, since only null is the placeholder.
 */
describe('formatting logged time', () => {
  it('shows hours to a tenth, without a trailing .0', () => {
    expect(formatHours(5400)).toBe('1.5h')
    expect(formatHours(28800)).toBe('8h')
    expect(formatHours(900)).toBe('0.3h')
    expect(formatHours(0)).toBe('0h')
    expect(formatHours(3600 * 40 + 60 * 6)).toBe('40.1h')
  })
})
