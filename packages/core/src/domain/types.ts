/**
 * Entity types for all three tiers.
 *
 * The tier boundaries are the point (constitution XIII):
 *
 *   Mirrored  — `mirror.db`.   Disposable. Delete and rebuild at will.
 *   Authored  — `authored.db`. The user's. A sync must never touch it.
 *   Derived   — memory only.   Recomputed every pass, never stored.
 *
 * Authored types reference providers by `NaturalKey` and never by a mirrored
 * row id. That is not a convention here — it is the only reference available,
 * because no mirrored type exposes an id that an authored type could hold.
 */

import type { NaturalKey } from './keys.js'

/** ISO-8601 with an offset. Stored and transmitted as a string, always absolute. */
export type Timestamp = string

// ---------------------------------------------------------------------------
// Mirrored
// ---------------------------------------------------------------------------

export type ProviderKind = 'jira' | 'github'

export interface Connection {
  id: string
  kind: ProviderKind
  siteOrHost: string
  accountLabel: string
  viewerIdentity: ViewerIdentity | null
  /**
   * A keychain lookup handle — `service/account` — never the secret itself.
   * Constitution XI, and asserted by the no-secrets test.
   */
  credentialRef: string
}

export interface ViewerIdentity {
  accountId: string
  displayName: string
  email: string | null
}

export type ResourceKind = 'tickets' | 'pulls' | 'checks' | 'branches' | 'comparisons' | 'local'

export type FailureReason = 'auth' | 'rateLimit' | 'network' | 'notFound' | 'unknown'

/**
 * Freshness is tracked per connection **per resource kind**, not per app — a
 * partial sync leaves some resources fresh and others stale, and collapsing
 * that to one number is how a board starts lying (constitution XIV).
 */
export interface FreshnessRecord {
  connectionId: string
  resourceKind: ResourceKind
  /** `null` means never synced, which is a different state from stale. */
  lastSuccessAt: Timestamp | null
  lastFailureAt: Timestamp | null
  failureReason: FailureReason | null
  nextAttemptAt: Timestamp | null
}

/** Jira's own categorisation. Drift rules read this, never the status name. */
export type StatusCategory = 'new' | 'indeterminate' | 'done'

export interface Ticket {
  key: NaturalKey
  connectionId: string
  issueKey: string
  summary: string
  assignee: ViewerIdentity | null
  reporter: ViewerIdentity | null
  statusName: string
  statusCategory: StatusCategory
  isBlocked: boolean
  createdAt: Timestamp
  /** Displayed, never used for staleness — automation moves it (FR-027). */
  updatedAt: Timestamp
  /** `null` means unknown, and is rendered as unknown rather than as "old". */
  lastRealActivityAt: Timestamp | null
  /**
   * When the status last actually changed. Distinct from `lastRealActivityAt`,
   * which any human edit advances — drift rule D7 asks specifically whether the
   * *ticket moved*, and a comment is not a transition.
   */
  lastStatusChangeAt: Timestamp | null
  url: string
  fetchedAt: Timestamp
}

export type ActivityAuthorKind = 'human' | 'bot' | 'automation'

export interface TicketActivity {
  ticketKey: NaturalKey
  at: Timestamp
  authorKind: ActivityAuthorKind
  field: string
  /**
   * Evaluated on ingest and stored, so the staleness a user is looking at can
   * be traced back to the rule that produced it months later.
   */
  countsAsReal: boolean
}

export type PullRequestState = 'open' | 'merged' | 'closed'
export type ReviewDecision = 'approved' | 'changesRequested' | 'reviewRequired'

export interface PullRequest {
  key: NaturalKey
  connectionId: string
  number: number
  title: string
  author: ViewerIdentity | null
  headBranch: string
  /** The head commit. Checks are keyed by SHA, so this is how CI attaches to a PR. */
  headSha: string
  baseBranch: string
  state: PullRequestState
  isDraft: boolean
  reviewDecision: ReviewDecision | null
  requestedReviewers: ViewerIdentity[]
  /** From `reviewThreads { isResolved, isOutdated }` — REST cannot supply this. */
  unresolvedThreadCount: number
  mergedAt: Timestamp | null
  closedAt: Timestamp | null
  lastRealActivityAt: Timestamp | null
  url: string
  fetchedAt: Timestamp
}

export type CheckState = 'success' | 'failure' | 'pending' | 'cancelled' | 'skipped'

export interface CheckResult {
  key: NaturalKey
  connectionId: string
  sha: string
  name: string
  state: CheckState
  isRequired: boolean
  url: string
  completedAt: Timestamp | null
  fetchedAt: Timestamp
}

export interface BranchRef {
  key: NaturalKey
  connectionId: string
  name: string
  headSha: string
  updatedAt: Timestamp
  url: string
  fetchedAt: Timestamp
}

export interface Comparison {
  branchKey: NaturalKey
  baseRef: string
  /**
   * `null` means unknown — the code host has never seen this branch. Never
   * coerce to zero: "no commits ahead" and "we have no idea" are different
   * answers, and only one of them is true for an unpushed branch (FR-018).
   */
  aheadBy: number | null
  behindBy: number | null
  /** Skip the next comparison while the head has not moved (rate limit, R3). */
  comparedAtSha: string
  fetchedAt: Timestamp
}

/** What only local git knows. Never a network read (FR-017). */
export interface LocalWorkspace {
  key: NaturalKey
  repoPath: string
  canonicalRemote: string
  branch: string
  worktreeId: string
  isPrimaryWorktree: boolean
  worktreePresent: boolean
  hasUncommittedChanges: boolean
  /** `null` when there is no upstream — the branch has never been pushed. */
  unpushedCommitCount: number | null
  headSha: string
  upstreamRef: string | null
  readAt: Timestamp
}

// ---------------------------------------------------------------------------
// Authored
// ---------------------------------------------------------------------------

export interface Project {
  id: string
  code: string
  name: string
  colorIndex: number | null
  jiraConnectionId: string | null
  jiraProjectKey: string | null
  githubConnectionId: string | null
  repoOwner: string | null
  repoName: string | null
  /** Stored and linked only. Never fetched, never authenticated (FR-004). */
  documentationUrl: string | null
  ticketKeyPattern: string
  checkoutPaths: string[]
  statusOverrides: Record<string, 'blocked' | 'terminal' | 'in-progress' | 'backlog'>
}

export type NoteType = 'decision' | 'gotcha' | 'question-for-human' | 'todo'
export type AuthorKind = 'user' | 'agent'

export interface Note {
  id: string
  subjectKey: NaturalKey
  type: NoteType
  body: string
  /** Stamped from the transport, never from the payload — an agent cannot post as the user. */
  authorKind: AuthorKind
  authorId: string | null
  /** Optimistic concurrency. A stale write is rejected, never merged (FR-055). */
  revision: number
  createdAt: Timestamp
  updatedAt: Timestamp
  resolvedAt: Timestamp | null
}

export type SessionState = 'running' | 'silent' | 'needs-you' | 'done' | 'failed'

export interface AgentSession {
  key: NaturalKey
  agentId: string
  sessionId: string
  projectId: string | null
  workItemKey: NaturalKey | null
  workspaceKey: NaturalKey | null
  reportedStatus: string | null
  startedAt: Timestamp
  lastHeartbeatAt: Timestamp
  /** A heartbeat does not advance this. A zombie heartbeat must not look busy. */
  lastRealActivityAt: Timestamp | null
  endedAt: Timestamp | null
  outcome: 'done' | 'failed' | null
  heartbeatIntervalSec: number
}

export type ActionKind = 'transition-ticket' | 'request-review' | 'cleanup-workspace' | 'investigate'

export type ActionState = 'pending' | 'claimed' | 'complete' | 'failed' | 'expired' | 'cancelled'

export interface OutboxAction {
  id: string
  subjectKey: NaturalKey
  kind: ActionKind
  payload: Record<string, unknown>
  motivatingFindingId: string | null
  state: ActionState
  /** Non-null at insert. An action cannot exist unconfirmed (FR-059, XVI). */
  confirmedAt: Timestamp
  confirmedVia: string
  claimedBy: string | null
  claimedAt: Timestamp | null
  claimExpiresAt: Timestamp | null
  result: string | null
  failureReason: string | null
  completedAt: Timestamp | null
  history: ActionHistoryEntry[]
}

export interface ActionHistoryEntry {
  at: Timestamp
  from: ActionState | null
  to: ActionState
  actor: string
  detail: string | null
}

export interface FindingDismissal {
  findingId: string
  dismissedAt: Timestamp
  /** Of the evidence tuple — so the dismissal expires on evidence change, not on a sync. */
  evidenceHash: string
}

export type Appearance = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

export interface Settings {
  appearance: Appearance
  density: Density
  pollIntervalSec: Record<ProviderKind, number>
  laneThresholdHours: { tickets: number; pulls: number; branches: number }
  driftGraceHours: number
  heartbeatMissMultiplier: number
  activeProjectId: string | null
  mineOnly: boolean
  windowGeometry: { x: number; y: number; width: number; height: number } | null
  /**
   * Keep the window above other applications.
   *
   * Window state, so it sits beside the geometry rather than with appearance: a
   * command station is a thing you glance at while working in something else,
   * and one that disappears behind the editor is one you stop glancing at.
   * Core stores it and has no opinion on it — only the shell can act on it, and
   * only `BrowserWindow.setAlwaysOnTop` can.
   */
  alwaysOnTop: boolean
}

// ---------------------------------------------------------------------------
// Derived — memory only
// ---------------------------------------------------------------------------

export type Severity = 'good' | 'warning' | 'serious' | 'critical'
export type StalenessBand = 'idle' | 'recent' | 'aging' | 'stale' | 'abandoned'
export type BallInCourt = 'you' | 'them' | 'agent'

export interface WorkItem {
  key: NaturalKey
  projectId: string | null
  ticket: Ticket | null
  workspaces: LocalWorkspace[]
  pullRequests: PullRequest[]
  checks: CheckResult[]
  /**
   * Ahead/behind for this item's branches, keyed by branch.
   *
   * Carried here rather than folded into `LocalWorkspace`, which is documented
   * as what local git alone knows: ahead/behind comes from the code host, and a
   * local read can never produce it without a network fetch FR-017 forbids.
   * Empty means the host has not been asked or could not answer — which is
   * "unknown", never "in sync" (FR-018).
   */
  comparisons: Comparison[]
  sessions: AgentSession[]
  noteCount: number
  severity: Severity
  staleness: StalenessBand
  ballInCourt: BallInCourt
  lastRealActivityAt: Timestamp | null
  /** `partial` when a contributing provider failed. The item still renders (XV). */
  resolution: 'full' | 'partial'
}

export type DriftRule = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7' | 'D8' | 'D9'

export interface DriftFinding {
  /** `drift:<rule>:<subjectKey>` — stable across restarts, so dismissals survive. */
  id: string
  rule: DriftRule
  subjectKey: NaturalKey
  projectId: string | null
  summary: string
  evidence: DriftEvidence[]
  ageSec: number
  suggestedAction: { kind: ActionKind; label: string } | null
  dispatchable: boolean
}

export interface DriftEvidence {
  side: string
  fact: string
  at: Timestamp | null
}
