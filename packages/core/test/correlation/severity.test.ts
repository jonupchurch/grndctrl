import { describe, expect, it } from 'vitest'
import { maxSeverity, severityOf, type SeverityInputs } from '../../src/correlation/severity.js'

const base: SeverityInputs = {
  inDrift: false,
  ticket: null,
  pullRequests: [],
  workspaces: [],
  sessions: [],
  thresholdMultiple: 0,
}

const sev = (over: Partial<SeverityInputs>) => severityOf({ ...base, ...over }).severity

/**
 * FR-029 is a table, so it is tested as a table: one case per contribution at
 * each level it can produce, plus the max-of-several case that is the actual
 * rule. The sample severities in the design files are hand-picked illustrations
 * and are deliberately not asserted here (spec Assumption 4).
 */
describe('the severity table', () => {
  it('is good when nothing is wrong', () => {
    expect(sev({})).toBe('good')
  })

  describe('drift', () => {
    // Serious, not critical. The *finding* renders critical in Attention where
    // it is actionable; the row should not outrank a failing required check,
    // which is a harder fact about the world.
    it('contributes serious', () => {
      expect(sev({ inDrift: true })).toBe('serious')
    })
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

  describe('pull request state', () => {
    const pr = (over: Partial<SeverityInputs['pullRequests'][number]>) => ({
      isDraft: false,
      reviewDecision: null,
      requiredChecksFailing: false,
      ...over,
    })

    it('is critical when a required check is failing', () => {
      expect(sev({ pullRequests: [pr({ requiredChecksFailing: true })] })).toBe('critical')
    })

    it('is serious when changes were requested', () => {
      expect(sev({ pullRequests: [pr({ reviewDecision: 'changesRequested' })] })).toBe('serious')
    })

    it('is a warning for a draft', () => {
      expect(sev({ pullRequests: [pr({ isDraft: true })] })).toBe('warning')
    })

    it('is a warning when awaiting review', () => {
      expect(sev({ pullRequests: [pr({ reviewDecision: 'reviewRequired' })] })).toBe('warning')
    })

    it('is good when approved and green', () => {
      expect(sev({ pullRequests: [pr({ reviewDecision: 'approved' })] })).toBe('good')
    })

    // An optional check failing is noise; a required one is a wall.
    it('does not go critical for an optional check failing', () => {
      expect(sev({ pullRequests: [pr({ requiredChecksFailing: false })] })).toBe('good')
    })
  })

  describe('workspace state', () => {
    const ws = (over: Partial<SeverityInputs['workspaces'][number]>) => ({
      hasUncommittedChanges: false,
      orphaned: false,
      hasLiveSession: false,
      ...over,
    })

    it('is critical when the branch or worktree is gone', () => {
      expect(sev({ workspaces: [ws({ orphaned: true })] })).toBe('critical')
    })

    // The distinction that makes this lane worth reading. Dirty with an agent
    // running is something being written right now; dirty with nobody home is
    // work somebody walked away from.
    it('is serious for uncommitted changes with no session running', () => {
      expect(sev({ workspaces: [ws({ hasUncommittedChanges: true })] })).toBe('serious')
    })

    it('is only a warning for uncommitted changes while an agent is editing', () => {
      expect(
        sev({ workspaces: [ws({ hasUncommittedChanges: true, hasLiveSession: true })] }),
      ).toBe('warning')
    })

    it('is good for a clean workspace', () => {
      expect(sev({ workspaces: [ws({})] })).toBe('good')
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

  // The actual rule: the highest of the six, not the first or the last.
  describe('combining contributions', () => {
    it('takes the maximum across contributions', () => {
      expect(
        sev({
          inDrift: true, // serious
          ticket: { isBlocked: false, awaitingOtherParty: true }, // warning
          thresholdMultiple: 1, // warning
        }),
      ).toBe('serious')

      expect(
        sev({
          inDrift: true, // serious
          pullRequests: [{ isDraft: false, reviewDecision: null, requiredChecksFailing: true }],
        }),
      ).toBe('critical')
    })

    it('is not lowered by a good contribution alongside a bad one', () => {
      expect(
        sev({
          pullRequests: [
            { isDraft: false, reviewDecision: 'approved', requiredChecksFailing: false },
            { isDraft: false, reviewDecision: 'changesRequested', requiredChecksFailing: false },
          ],
        }),
      ).toBe('serious')
    })

    it('reports why, highest contribution first', () => {
      const result = severityOf({
        ...base,
        inDrift: true,
        thresholdMultiple: 1,
        ticket: { isBlocked: true, awaitingOtherParty: false },
      })

      expect(result.severity).toBe('critical')
      expect(result.contributions[0]?.severity).toBe('critical')
      expect(result.contributions.map((c) => c.source)).toContain('drift')
      expect(result.contributions.every((c) => c.because.length > 0)).toBe(true)
    })

    it('reports no contributions when everything is fine', () => {
      expect(severityOf(base).contributions).toEqual([])
    })
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
