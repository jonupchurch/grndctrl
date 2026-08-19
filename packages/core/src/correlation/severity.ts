import type { Severity } from '../domain/types.js'

/**
 * Severity is correlation output, not a styling choice (FR-031). The same
 * inputs yield the same severity wherever it is rendered, which is why this is
 * a pure function over plain data rather than a prop computed in a component.
 *
 * The rule is FR-029's table: the result is the highest any contribution
 * produces. The sample severities in the design files are illustrative and
 * hand-picked — this table governs (spec Assumption 4).
 *
 * **Three of the six sources are gone: drift, pull requests and workspaces.**
 * The three that remain — ticket, session, staleness — produce exactly what
 * they produced before, for exactly the same inputs (FR-120). That is asserted
 * in `severity.test.ts` rather than left to inspection, because the tempting
 * thing while in here is to rebalance: with `critical` now reachable only from a
 * blocked ticket and 3× staleness, the remaining levels look sparse. Rebalancing
 * would be an undocumented product change wearing a removal's clothes, and the
 * operator would find their board had quietly started shouting about different
 * things.
 */

const RANK: Record<Severity, number> = { good: 0, warning: 1, serious: 2, critical: 3 }

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b
}

export interface SeverityContribution {
  source: 'ticket' | 'session' | 'staleness'
  severity: Severity
  /** Plain-language reason. Surfaced in the CLI and useful in a bug report. */
  because: string
}

export interface SeverityInputs {
  ticket: {
    isBlocked: boolean
    /** In review, or otherwise waiting on somebody who is not the operator. */
    awaitingOtherParty: boolean
  } | null

  sessions: readonly {
    state: 'running' | 'silent' | 'needs-you' | 'done' | 'failed'
  }[]

  /** Whole multiples of this lane's threshold that have elapsed. */
  thresholdMultiple: number
}

export interface SeverityResult {
  severity: Severity
  /** Every contribution above `good`, highest first. Empty means nothing is wrong. */
  contributions: SeverityContribution[]
}

export function severityOf(input: SeverityInputs): SeverityResult {
  const contributions: SeverityContribution[] = []
  const add = (c: SeverityContribution) => {
    if (c.severity !== 'good') contributions.push(c)
  }

  if (input.ticket !== null) {
    if (input.ticket.isBlocked) {
      add({ source: 'ticket', severity: 'critical', because: 'the ticket is blocked' })
    } else if (input.ticket.awaitingOtherParty) {
      add({ source: 'ticket', severity: 'warning', because: 'the ticket is waiting on someone else' })
    }
  }

  for (const session of input.sessions) {
    if (session.state === 'silent') {
      add({ source: 'session', severity: 'serious', because: 'the agent stopped reporting' })
    } else if (session.state === 'needs-you') {
      add({ source: 'session', severity: 'warning', because: 'the agent is waiting on you' })
    }
  }

  const staleness = stalenessSeverity(input.thresholdMultiple)
  if (staleness !== 'good') {
    add({
      source: 'staleness',
      severity: staleness,
      because: `no real activity in ${input.thresholdMultiple}× this lane's threshold`,
    })
  }

  contributions.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.source.localeCompare(b.source))

  return {
    severity: contributions.reduce<Severity>((acc, c) => maxSeverity(acc, c.severity), 'good'),
    contributions,
  }
}

function stalenessSeverity(multiple: number): Severity {
  if (multiple >= 3) return 'critical'
  if (multiple >= 2) return 'serious'
  if (multiple >= 1) return 'warning'
  return 'good'
}
