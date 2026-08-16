import type { Severity } from '../domain/types.js'

/**
 * Severity is correlation output, not a styling choice (FR-031). The same
 * inputs yield the same severity wherever it is rendered, which is why this is
 * a pure function over plain data rather than a prop computed in a component.
 *
 * The rule is FR-029's table: six contributions, and the result is the highest
 * any of them produces. The sample severities in the design files are
 * illustrative and hand-picked — this table governs (spec Assumption 4).
 */

const RANK: Record<Severity, number> = { good: 0, warning: 1, serious: 2, critical: 3 }

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b
}

export interface SeverityContribution {
  source: 'drift' | 'ticket' | 'pull-request' | 'workspace' | 'session' | 'staleness'
  severity: Severity
  /** Plain-language reason. Surfaced in the CLI and useful in a bug report. */
  because: string
}

export interface SeverityInputs {
  /** The item participates in an unresolved drift finding. */
  inDrift: boolean

  ticket: {
    isBlocked: boolean
    /** In review, or otherwise waiting on somebody who is not the operator. */
    awaitingOtherParty: boolean
  } | null

  pullRequests: readonly {
    isDraft: boolean
    reviewDecision: 'approved' | 'changesRequested' | 'reviewRequired' | null
    /** A *required* check is failing. An optional one failing is not critical. */
    requiredChecksFailing: boolean
  }[]

  workspaces: readonly {
    hasUncommittedChanges: boolean
    /** The worktree directory is gone, or the branch no longer exists at the host. */
    orphaned: boolean
    /** An agent session is live on this workspace right now. */
    hasLiveSession: boolean
  }[]

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

  // Drift contributes `serious`, not `critical`. The *finding* renders critical
  // in Attention, where it is actionable; the row it points at should not
  // outrank a failing required check, which is a harder fact.
  if (input.inDrift) {
    add({ source: 'drift', severity: 'serious', because: 'two sources disagree about this item' })
  }

  if (input.ticket !== null) {
    if (input.ticket.isBlocked) {
      add({ source: 'ticket', severity: 'critical', because: 'the ticket is blocked' })
    } else if (input.ticket.awaitingOtherParty) {
      add({ source: 'ticket', severity: 'warning', because: 'the ticket is waiting on someone else' })
    }
  }

  for (const pr of input.pullRequests) {
    if (pr.requiredChecksFailing) {
      add({ source: 'pull-request', severity: 'critical', because: 'a required check is failing' })
    } else if (pr.reviewDecision === 'changesRequested') {
      add({ source: 'pull-request', severity: 'serious', because: 'changes were requested' })
    } else if (pr.isDraft) {
      add({ source: 'pull-request', severity: 'warning', because: 'the pull request is still a draft' })
    } else if (pr.reviewDecision === 'reviewRequired') {
      add({ source: 'pull-request', severity: 'warning', because: 'the pull request is awaiting review' })
    }
  }

  for (const ws of input.workspaces) {
    if (ws.orphaned) {
      add({
        source: 'workspace',
        severity: 'critical',
        because: 'the branch or worktree no longer exists',
      })
    } else if (ws.hasUncommittedChanges) {
      // The distinction that makes this useful: dirty *with* a live agent is
      // expected -- something is being written right now. Dirty with nobody
      // home is work somebody walked away from.
      add(
        ws.hasLiveSession
          ? {
              source: 'workspace',
              severity: 'warning',
              because: 'an agent is editing this workspace',
            }
          : {
              source: 'workspace',
              severity: 'serious',
              because: 'uncommitted changes with no session running',
            },
      )
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
