import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { applyDismissals, staleDismissals } from '../../src/drift/dismiss.js'
import { evidenceHash, findingId } from '../../src/drift/id.js'
import { detectDrift } from '../../src/drift/rules.js'
import type { DriftFinding, FindingDismissal } from '../../src/domain/types.js'
import type { CorrelationInput } from '../../src/correlation/join.js'
import { hoursAgo, input, pullRequest, settings, ticket, NOW } from '../correlation/builders.js'

function findings(over: Partial<CorrelationInput>): DriftFinding[] {
  const ci = input(over)
  const { workItems, dangling } = correlate(ci)
  return detectDrift({ workItems, dangling, settings: ci.settings, now: ci.now })
}

const mergedPrOpenTicket = (mergedAt: string) => ({
  tickets: [ticket({ statusName: 'In Review', statusCategory: 'indeterminate' })],
  pullRequests: [pullRequest({ state: 'merged', mergedAt })],
})

describe('finding identity', () => {
  // A dismissal is stored against this id. If it changed between runs the
  // operator would dismiss the same finding forever.
  it('is stable across runs and independent of age', () => {
    const first = findings(mergedPrOpenTicket(hoursAgo(72)))
    const second = findings(mergedPrOpenTicket(hoursAgo(72)))

    expect(first[0]?.id).toBe(second[0]?.id)
    expect(first[0]?.id).toBe(findingId('D1', first[0]!.subjectKey))
  })

  it('differs per rule and per subject', () => {
    expect(findingId('D1', 'jira:site/MERC-1')).not.toBe(findingId('D2', 'jira:site/MERC-1'))
    expect(findingId('D1', 'jira:site/MERC-1')).not.toBe(findingId('D1', 'jira:site/MERC-2'))
  })
})

describe('evidence hashing', () => {
  it('is identical for identical evidence', () => {
    const a = findings(mergedPrOpenTicket(hoursAgo(72)))[0]!
    const b = findings(mergedPrOpenTicket(hoursAgo(72)))[0]!
    expect(evidenceHash(a)).toBe(evidenceHash(b))
  })

  it('changes when the underlying facts change', () => {
    const a = findings(mergedPrOpenTicket(hoursAgo(72)))[0]!
    const b = findings(mergedPrOpenTicket(hoursAgo(96)))[0]!
    expect(evidenceHash(a)).not.toBe(evidenceHash(b))
  })

  // Age changes every second; hashing it would expire every dismissal
  // instantly. The summary is presentation, so rewording it must not resurrect
  // dismissed findings.
  it('ignores age and the rendered summary', () => {
    const base = findings(mergedPrOpenTicket(hoursAgo(72)))[0]!
    const reworded: DriftFinding = { ...base, ageSec: base.ageSec + 5000, summary: 'reworded' }
    expect(evidenceHash(reworded)).toBe(evidenceHash(base))
  })
})

describe('dismissals', () => {
  const dismissalFor = (f: DriftFinding): FindingDismissal => ({
    findingId: f.id,
    dismissedAt: NOW.toISOString(),
    evidenceHash: evidenceHash(f),
  })

  it('hides a dismissed finding while the evidence is unchanged', () => {
    const current = findings(mergedPrOpenTicket(hoursAgo(72)))
    expect(applyDismissals(current, [dismissalFor(current[0]!)])).toEqual([])
  })

  // "Dismiss" means not now, not never. Hiding today's disagreement must not
  // hide the same rule when the situation genuinely changes.
  it('lapses when the evidence moves on', () => {
    const dismissed = dismissalFor(findings(mergedPrOpenTicket(hoursAgo(72)))[0]!)
    const later = findings(mergedPrOpenTicket(hoursAgo(96)))

    expect(applyDismissals(later, [dismissed])).toHaveLength(1)
  })

  it('leaves undismissed findings alone', () => {
    const current = findings(mergedPrOpenTicket(hoursAgo(72)))
    expect(applyDismissals(current, [])).toHaveLength(current.length)
  })

  it('identifies dismissals whose finding no longer fires, so they can be pruned', () => {
    const gone = dismissalFor(findings(mergedPrOpenTicket(hoursAgo(72)))[0]!)
    // The ticket moved to Done: D1 no longer applies at all.
    const resolved = findings({
      tickets: [ticket({ statusName: 'Done', statusCategory: 'done' })],
      pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(72) })],
    })

    expect(staleDismissals(resolved, [gone])).toHaveLength(1)
  })
})

/** FR-037: a finding clears on its own when the disagreement is resolved. */
describe('auto-clearing', () => {
  it('disappears once the ticket is moved to done, with no user action', () => {
    expect(findings(mergedPrOpenTicket(hoursAgo(72))).map((f) => f.rule)).toContain('D1')

    expect(
      findings({
        tickets: [ticket({ statusName: 'Done', statusCategory: 'done' })],
        pullRequests: [pullRequest({ state: 'merged', mergedAt: hoursAgo(72) })],
      }).map((f) => f.rule),
    ).not.toContain('D1')
  })

  it('disappears once the dangling key resolves to a real ticket', () => {
    expect(
      findings({ pullRequests: [pullRequest({ headBranch: 'feature/MERC-9999' })] }).map((f) => f.rule),
    ).toContain('D6')

    expect(
      findings({
        tickets: [ticket({ issueKey: 'MERC-9999' })],
        pullRequests: [pullRequest({ headBranch: 'feature/MERC-9999' })],
      }).map((f) => f.rule),
    ).not.toContain('D6')
  })

  it('reports zero findings for a board with nothing wrong', () => {
    expect(
      detectDrift({ workItems: [], dangling: [], settings: settings(), now: NOW }),
    ).toEqual([])
  })
})
