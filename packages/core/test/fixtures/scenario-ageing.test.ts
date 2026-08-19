import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import type { CorrelationInput } from '../../src/correlation/join.js'
import { noteFieldsOf, resolveScenarioTimes } from '../../src/fixtures/scenario.js'
import { DEFAULT_SETTINGS } from '../../src/services/settings.js'
import type { Severity } from '../../src/domain/types.js'

/**
 * The checked-in scenarios, and what happens to them as time passes (T052 —
 * FR-104, FR-118).
 *
 * `every-severity.json` is the FR-104 assertion: all four bands, reachable from
 * ticket, session and staleness alone. FR-104 says that must be *asserted by a
 * test over a fixture rather than argued*, and this is that test.
 *
 * It is also the regression test for how the fixture broke. Severity derives
 * partly from staleness, so a scenario carrying absolute dates ages: written on
 * 2026-08-14 with four items at four severities, a fortnight later every one of
 * them had passed 3× the ticket threshold and the scenario named for having all
 * four produced one. Three `greyscale.spec.ts` tests failed on `main` for that
 * reason, and had been failing long enough to look like scenery.
 *
 * So the last case here is the failure itself, run deliberately: resolve the
 * offsets once and then correlate a week later, and the four bands collapse.
 * That is the assertion that would have caught it, and it is the reason the two
 * readers resolve at load rather than at write.
 */

const SCENARIOS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
)

interface Scenario {
  now?: string
  notes?: Parameters<typeof noteFieldsOf>[0]
  input: Omit<CorrelationInput, 'settings' | 'now' | 'noteCounts' | 'openQuestionSubjects'>
}

const read = (name: string): Scenario =>
  JSON.parse(readFileSync(join(SCENARIOS, `${name}.json`), 'utf8')) as Scenario

/** Load a scenario the way both readers do, and correlate it. */
function severities(name: string, at: Date, correlateAt = at): Record<string, Severity> {
  const scenario = resolveScenarioTimes(read(name), at)

  const { workItems } = correlate({
    ...scenario.input,
    ...noteFieldsOf(scenario.notes ?? []),
    settings: DEFAULT_SETTINGS,
    now: correlateAt,
  })

  return Object.fromEntries(workItems.map((w) => [w.ticket.issueKey, w.severity]))
}

const bands = (result: Record<string, Severity>): Severity[] =>
  [...new Set(Object.values(result))].sort()

const NOW = new Date('2026-08-19T12:00:00.000Z')
const WEEK = 7 * 86_400_000

describe('every-severity.json', () => {
  /**
   * The table, item by item.
   *
   * Spelled out rather than checked as a set, because "all four appear" is also
   * true of a fixture where the wrong item produces each one — and the whole
   * point of the scenario is *which facts* produce which band. If a rule
   * changes, this says which item moved.
   */
  it('produces each band from the source it was built to demonstrate', () => {
    expect(severities('every-severity', NOW)).toEqual({
      // Ticket source.
      'MERC-2001': 'critical', // blocked
      'MERC-2005': 'warning', // in review, so waiting on someone else
      // Session source.
      'MERC-2003': 'serious', // the agent stopped reporting
      'MERC-2007': 'warning', // the agent stopped to ask
      // Staleness source, at each multiple of the ticket lane's threshold.
      'MERC-2002': 'critical', // 3x
      'MERC-2004': 'serious', // 2x
      'MERC-2006': 'warning', // 1x
      // And one with nothing wrong, which is the band that is hardest to keep:
      // every other row is one careless default away from joining it.
      'MERC-2008': 'good',
    })
  })

  /**
   * The property the offsets buy, over spans well past anything this repository
   * will still be running under.
   */
  it.each([0, WEEK, 30 * 86_400_000, 365 * 86_400_000])(
    'still produces all four bands %i ms from now',
    (offset) => {
      const at = new Date(NOW.getTime() + offset)
      expect(bands(severities('every-severity', at))).toEqual([
        'critical',
        'good',
        'serious',
        'warning',
      ])
    },
  )

  /**
   * **The defect, reproduced on purpose.**
   *
   * One resolution, then a week on the clock — which is exactly what an absolute
   * timestamp is: a resolution that happened once, when the file was written.
   * Everything ages together, the staleness rows pass 3×, and a scenario whose
   * entire job is showing four bands at once shows two.
   *
   * If this ever starts passing, the offsets have stopped mattering and the
   * assertion above has stopped being evidence of anything.
   */
  it('collapses when the offsets are resolved once and the clock moves on', () => {
    const stale = severities('every-severity', NOW, new Date(NOW.getTime() + WEEK))

    expect(bands(stale)).not.toEqual(['critical', 'good', 'serious', 'warning'])
    expect(stale['MERC-2008']).not.toBe('good')
  })
})

describe('canonical-board.json', () => {
  it('holds its shape: one warning, one serious, one clean row', () => {
    expect(severities('canonical-board', NOW)).toEqual({
      'MERC-1184': 'warning',
      'MERC-1190': 'serious',
      'MERC-1201': 'good',
    })
  })

  it('still holds it a year later', () => {
    expect(severities('canonical-board', new Date(NOW.getTime() + 365 * 86_400_000))).toEqual({
      'MERC-1184': 'warning',
      'MERC-1190': 'serious',
      'MERC-1201': 'good',
    })
  })

  /**
   * The board the rest of the suite reads has to contain the *contrasts* those
   * specs compare, and every one of them is a pair. A fixture edit that dropped
   * one half would leave a lot of green tests comparing a thing to itself.
   */
  it('carries a row with an agent and a row without, and notes on neither of them', () => {
    const scenario = read('canonical-board')
    const worked = new Set(scenario.input.sessions.map((s) => s.workItemKey))

    expect(scenario.input.tickets.filter((t) => worked.has(t.key))).toHaveLength(1)
    expect(scenario.input.tickets.filter((t) => !worked.has(t.key)).length).toBeGreaterThan(0)

    // `golden-path.spec.ts` writes a note on MERC-1184 and compares its column
    // offsets against MERC-1190, which must have none. The two notes this
    // scenario does seed are deliberately on a third row.
    const { noteCounts } = noteFieldsOf(scenario.notes ?? [])
    expect(noteCounts['jira:acme.atlassian.net/MERC-1184']).toBeUndefined()
    expect(noteCounts['jira:acme.atlassian.net/MERC-1190']).toBeUndefined()
    expect(noteCounts['jira:acme.atlassian.net/MERC-1201']).toBe(2)
  })
})
