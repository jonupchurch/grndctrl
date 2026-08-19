import { describe, expect, it } from 'vitest'
import { maxSeverity, severityOf, type SeverityInputs } from '../../src/correlation/severity.js'

const base: SeverityInputs = {
  ticket: null,
  sessions: [],
  thresholdMultiple: 0,
}

const sev = (over: Partial<SeverityInputs>) => severityOf({ ...base, ...over }).severity

/**
 * FR-029 is a table, so it is tested as a table: one case per contribution at
 * each level it can produce, plus the max-of-several case that is the actual
 * rule. The sample severities in the design files are hand-picked illustrations
 * and are deliberately not asserted here (spec Assumption 4).
 *
 * **Three of the six sources are gone**: drift, pull requests and workspaces.
 * What this file has to prove now is FR-120 — that the three that remain produce
 * *exactly* what they produced before, for exactly the same inputs. The tempting
 * thing while removing half the table is to rebalance the rest, because
 * `critical` suddenly looks sparse; that would be a product change wearing a
 * removal's clothes, and the first anyone would know of it is a board that had
 * started shouting about different things.
 */
describe('the severity table', () => {
  it('is good when nothing is wrong', () => {
    expect(sev({})).toBe('good')
  })

  describe('ticket state', () => {
    it('is critical when blocked', () => {
      expect(sev({ ticket: { isBlocked: true, awaitingOtherParty: false } })).toBe('critical')
    })

    it('is a warning when awaiting another party', () => {
      expect(sev({ ticket: { isBlocked: false, awaitingOtherParty: true } })).toBe('warning')
    })

    it('is good when in progress and nobody is waiting', () => {
      expect(sev({ ticket: { isBlocked: false, awaitingOtherParty: false } })).toBe('good')
    })
  })

  describe('session state', () => {
    it('is serious when an agent has gone silent', () => {
      expect(sev({ sessions: [{ state: 'silent' }] })).toBe('serious')
    })

    it('is a warning when an agent is waiting on you', () => {
      expect(sev({ sessions: [{ state: 'needs-you' }] })).toBe('warning')
    })

    it('is good for a running or finished session', () => {
      expect(sev({ sessions: [{ state: 'running' }] })).toBe('good')
      expect(sev({ sessions: [{ state: 'done' }] })).toBe('good')
    })
  })

  describe('staleness, measured against the lane threshold', () => {
    it('is good inside the threshold', () => {
      expect(sev({ thresholdMultiple: 0 })).toBe('good')
    })

    it('escalates at one, two, and three multiples', () => {
      expect(sev({ thresholdMultiple: 1 })).toBe('warning')
      expect(sev({ thresholdMultiple: 2 })).toBe('serious')
      expect(sev({ thresholdMultiple: 3 })).toBe('critical')
      expect(sev({ thresholdMultiple: 12 })).toBe('critical')
    })
  })

  /**
   * FR-120, stated as one table rather than left implicit in the cases above.
   *
   * Every surviving (input, severity) pair, in one place, so that a change to
   * any of them fails here with the old value and the new one side by side —
   * rather than as one test somewhere in the file quietly flipping.
   */
  it('produces the same severity for the same inputs as it did before 006', () => {
    const table: [string, Partial<SeverityInputs>, string][] = [
      ['blocked ticket', { ticket: { isBlocked: true, awaitingOtherParty: false } }, 'critical'],
      ['ticket awaiting another party', { ticket: { isBlocked: false, awaitingOtherParty: true } }, 'warning'],
      ['ticket in progress', { ticket: { isBlocked: false, awaitingOtherParty: false } }, 'good'],
      ['silent agent', { sessions: [{ state: 'silent' }] }, 'serious'],
      ['agent waiting on you', { sessions: [{ state: 'needs-you' }] }, 'warning'],
      ['running agent', { sessions: [{ state: 'running' }] }, 'good'],
      ['failed session', { sessions: [{ state: 'failed' }] }, 'good'],
      ['1x threshold', { thresholdMultiple: 1 }, 'warning'],
      ['2x threshold', { thresholdMultiple: 2 }, 'serious'],
      ['3x threshold', { thresholdMultiple: 3 }, 'critical'],
    ]

    for (const [label, input, expected] of table) {
      expect(sev(input), `${label} should be ${expected}`).toBe(expected)
    }
  })

  // The actual rule: the highest, not the first or the last.
  describe('combining contributions', () => {
    it('takes the maximum across contributions', () => {
      expect(
        sev({
          sessions: [{ state: 'silent' }], // serious
          ticket: { isBlocked: false, awaitingOtherParty: true }, // warning
          thresholdMultiple: 1, // warning
        }),
      ).toBe('serious')

      expect(
        sev({
          sessions: [{ state: 'silent' }], // serious
          ticket: { isBlocked: true, awaitingOtherParty: false }, // critical
        }),
      ).toBe('critical')
    })

    it('is not lowered by a good contribution alongside a bad one', () => {
      expect(sev({ sessions: [{ state: 'running' }, { state: 'silent' }] })).toBe('serious')
    })

    it('reports why, highest contribution first', () => {
      const result = severityOf({
        ...base,
        thresholdMultiple: 1,
        sessions: [{ state: 'silent' }],
        ticket: { isBlocked: true, awaitingOtherParty: false },
      })

      expect(result.severity).toBe('critical')
      expect(result.contributions[0]?.severity).toBe('critical')
      expect(result.contributions.map((c) => c.source)).toContain('ticket')
      expect(result.contributions.map((c) => c.source)).toContain('session')
      expect(result.contributions.map((c) => c.source)).toContain('staleness')
      expect(result.contributions.every((c) => c.because.length > 0)).toBe(true)
    })

    it('reports no contributions when everything is fine', () => {
      expect(severityOf(base).contributions).toEqual([])
    })
  })

  /**
   * All four severities are still reachable, and from what.
   *
   * With three of six sources removed, the question worth asking is not "does
   * the table still work" but "is any level now unreachable" — a severity that
   * nothing can produce is a shape the operator will never learn to read, and
   * `every-severity.json` exists to put all four on one screen (FR-104).
   */
  it('can still reach all four severities', () => {
    expect(sev({})).toBe('good')
    expect(sev({ thresholdMultiple: 1 })).toBe('warning')
    expect(sev({ sessions: [{ state: 'silent' }] })).toBe('serious')
    expect(sev({ ticket: { isBlocked: true, awaitingOtherParty: false } })).toBe('critical')
  })
})

describe('maxSeverity', () => {
  it('orders good < warning < serious < critical', () => {
    expect(maxSeverity('good', 'warning')).toBe('warning')
    expect(maxSeverity('serious', 'warning')).toBe('serious')
    expect(maxSeverity('critical', 'serious')).toBe('critical')
    expect(maxSeverity('good', 'good')).toBe('good')
  })
})
