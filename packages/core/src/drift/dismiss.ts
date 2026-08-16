import type { DriftFinding, FindingDismissal } from '../domain/types.js'
import { evidenceHash } from './id.js'

/**
 * Applying dismissals.
 *
 * "Dismiss" means *not now*, not *never*. A dismissal is stored with a hash of
 * the evidence that produced the finding, and it lapses when that evidence
 * changes — so hiding "MERC-1184 is In Review but the PR merged" today does not
 * hide the same rule when a second PR merges next week.
 *
 * The alternative — an expiry in hours — would be either too short to be
 * useful or long enough to hide a genuinely new situation, and the operator has
 * no way to reason about which.
 */
export function applyDismissals(
  findings: readonly DriftFinding[],
  dismissals: readonly FindingDismissal[],
): DriftFinding[] {
  const byId = new Map(dismissals.map((d) => [d.findingId, d]))

  return findings.filter((f) => {
    const dismissal = byId.get(f.id)
    if (dismissal === undefined) return true
    // Evidence has moved on: the dismissal no longer describes this situation.
    return dismissal.evidenceHash !== evidenceHash(f)
  })
}

/** Dismissals whose finding no longer fires at all, and which can be pruned. */
export function staleDismissals(
  findings: readonly DriftFinding[],
  dismissals: readonly FindingDismissal[],
): FindingDismissal[] {
  const live = new Set(findings.map((f) => f.id))
  return dismissals.filter((d) => !live.has(d.findingId))
}
