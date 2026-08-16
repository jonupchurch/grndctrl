import type { DriftFinding, DriftRule } from '../domain/types.js'

/**
 * Finding identity, and why it has to be stable.
 *
 * A dismissal is stored against a finding id (FR-038). If the id changed
 * between runs — because it embedded a timestamp, an age, or a row id — every
 * dismissal would evaporate on the next sync and the operator would dismiss the
 * same finding forever. So the id is a pure function of the rule and its
 * subject, and nothing else.
 *
 * `drift:<rule>:<subjectKey>`
 */
export function findingId(rule: DriftRule, subjectKey: string): string {
  return `drift:${rule}:${subjectKey}`
}

/**
 * A hash of what the finding is *about*, so a dismissal expires when the
 * situation changes rather than when a sync merely runs.
 *
 * The evidence timestamps and facts are the situation. If the PR merges again,
 * or the ticket moves, or the age crosses into a new day, the evidence differs
 * and the dismissal lapses — which is what the operator meant by "not now"
 * rather than "never" (spec Assumption 7).
 *
 * Deliberately excludes `ageSec` and the rendered summary: age changes every
 * second and would expire every dismissal instantly, and the summary is
 * presentation, so rewording it must not resurrect dismissed findings.
 */
export function evidenceHash(finding: Pick<DriftFinding, 'rule' | 'subjectKey' | 'evidence'>): string {
  const canonical = [
    finding.rule,
    finding.subjectKey,
    ...finding.evidence.map((e) => `${e.side}|${e.fact}|${e.at ?? ''}`),
  ].join('\n')

  return fnv1a(canonical)
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
