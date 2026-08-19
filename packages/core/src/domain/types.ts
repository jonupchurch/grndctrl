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

/**
 * One kind, and it stays a union rather than becoming a string.
 *
 * Connection ids, keychain references and the settings poll interval are all
 * keyed by it, and a database written by 0.3.0 holds `github` rows until
 * migration 4 deletes them. Keeping the name is what lets `buildSyncTargets`
 * and `connections.test` recognise such a row and say something useful about
 * it, rather than treating it as a Jira site that will not authenticate.
 */
export type ProviderKind = 'jira'

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

/**
 * One kind. Rows for the retired five are deleted by migration 4, or the header
 * goes on reporting resources that no longer exist (FR-111).
 */
export type ResourceKind = 'tickets'

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
  /**
   * The tracker's own priority name — `Highest`, `P1`, `Blocker` — verbatim.
   *
   * Not normalised to a band. Every team renames these, the same way they
   * rename statuses, and the lesson `statusCategory` already encodes is that
   * mapping somebody's vocabulary onto ours produces a label that is confidently
   * wrong. Unlike status there is no category to fall back on: the issue field
   * carries a name and an icon and nothing that orders them. So the name is what
   * is stored and the name is what is shown.
   *
   * `null` means the field is unset or absent from this project's screen — never
   * "lowest". An unprioritised ticket and a trivial one are different facts.
   */
  priority: string | null
  /**
   * Story points, if the connection has a field for them.
   *
   * `null` is unestimated **or** unavailable, and the two cannot be told apart
   * per ticket: story points are a Jira custom field with a per-site id, so a
   * site where the field could not be resolved reports null on every row. That
   * conflation is confined to this field and does not reach a conclusion — the
   * row renders null as an absence and never as `0`, because "nobody estimated
   * it" and "it is a zero-point ticket" are different answers.
   */
  storyPoints: number | null
  /**
   * The sprint this ticket is currently in, by name.
   *
   * A ticket can be in **several** — Jira's sprint field is an array, and a
   * ticket carried over from one sprint to the next keeps the closed one on it.
   * So this is not "the sprint field", it is a choice made at ingest: the active
   * sprint if there is one, else the nearest future sprint, else the most recent
   * closed one. The operator's question is "which sprint is this in", and the
   * answer they mean is the live one.
   *
   * The name only, and the tracker's own spelling of it — same discipline as
   * `priority`. There is no id here because nothing joins on it.
   *
   * `null` is "not in a sprint" **or** "this site has no sprint field", and the
   * two cannot be told apart per ticket for the same reason `storyPoints` cannot:
   * sprint is a custom field with a per-site id, so a site where it could not be
   * resolved reports null on every row. Neither is rendered as a sprint name.
   */
  sprint: string | null
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

/*
 * `PullRequest`, `CheckResult`, `BranchRef`, `Comparison` and `LocalWorkspace`
 * were here, with `PullRequestState`, `ReviewDecision` and `CheckState`.
 *
 * All five described a code host or a local checkout. `Comparison` is the one
 * worth a sentence on the way out: it carried ahead/behind as `number | null`
 * where `null` meant *the host has never seen this branch*, and the comment on
 * it warned against coercing that to zero, because "no commits ahead" and "we
 * have no idea" are different answers. That distinction outlived the type —
 * `links.resolve` still returns `fellBack` for the same reason.
 */

// ---------------------------------------------------------------------------
// Authored
// ---------------------------------------------------------------------------

export interface Project {
  id: string
  code: string
  name: string
  colorIndex: number | null
  jiraConnectionId: string | null
  /**
   * **Still nullable, and `projects.upsert` still refuses a null one.**
   *
   * Those are not in conflict. The write path requires it, because a project
   * with no ticket project has nothing to show and the operator is standing
   * there to be told so. The type permits it, because a database written by
   * 0.3.0 can hold a repository-only project and 006 keeps that row rather than
   * deleting the operator's data to satisfy a rule invented after it was
   * written (FR-110). A non-nullable type here would make an existing row
   * unrepresentable, which is a different way of losing it.
   */
  jiraProjectKey: string | null
  /** Stored and linked only. Never fetched, never authenticated (FR-004). */
  documentationUrl: string | null
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
  reportedStatus: string | null
  startedAt: Timestamp
  lastHeartbeatAt: Timestamp
  /** A heartbeat does not advance this. A zombie heartbeat must not look busy. */
  lastRealActivityAt: Timestamp | null
  endedAt: Timestamp | null
  outcome: 'done' | 'failed' | null
  heartbeatIntervalSec: number
}

/**
 * What can still be *produced*, which is not what can still be *read*.
 *
 * `request-review` and `cleanup-workspace` are retired: one asked a code host
 * for a review, the other cleaned up a checkout. The `outbox_actions.kind`
 * column deliberately has no CHECK constraint, so a row of a retired kind
 * written before the upgrade keeps reading, stays claimable and stays
 * completable. An action the operator confirmed is theirs, and a narrowing type
 * is not entitled to make it unopenable.
 */
export type ActionKind = 'transition-ticket' | 'investigate'

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
  /**
   * `sessions` is **new, and is not a rename of `pulls`.**
   *
   * It is the session lane's own staleness threshold. The old `pulls` value is
   * carried across as its default by migration 2, so an operator who had tuned
   * that number keeps it — but the two describe different things and the
   * naming says so rather than quietly inheriting a meaning.
   */
  laneThresholdHours: { tickets: number; sessions: number }
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
  /**
   * Which regions of the board the operator has folded away (FR-143).
   *
   * **Only the collapsed ones are stored**, and that is the whole reason this is
   * a sparse map rather than a flag per region. Storing `false` too would put a
   * key in here for every region the operator has ever *expanded* again, so the
   * map would grow with interaction rather than with state, and a region that
   * was renamed would leave a dead entry behind forever. Absent means expanded,
   * which is also the default and the state a fresh install is in.
   *
   * Keys are the region ids, which are **stable literals in the renderer**,
   * never generated — a generated id changes between builds and would silently
   * unfold everything the operator had put away.
   *
   * An unrecognised key is ignored rather than an error. Core knows nothing
   * about what regions exist; it stores what the one screen tells it, and a
   * board that refused to load because a region was renamed would be a poor
   * trade for a preference.
   */
  collapsedRegions: Record<string, boolean>
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
  /**
   * **Not nullable** (FR-106), and that is the substantive change 006 made to
   * this type rather than a consequence of one.
   *
   * A work item could be built from a pull request or a local branch, so the
   * row existed without a ticket and every consumer had to handle it: the lane
   * filtered on `ticket !== null`, the CLI had a fallback identity, the note
   * badge had a fallback subject. There is one way to build a row now and it
   * starts from a ticket, so the null is unreachable — and a nullable field
   * whose null is unreachable is a branch every future reader has to prove is
   * dead.
   */
  ticket: Ticket
  sessions: AgentSession[]
  noteCount: number
  severity: Severity
  staleness: StalenessBand
  ballInCourt: BallInCourt
  lastRealActivityAt: Timestamp | null
  /** `partial` when a contributing provider failed. The item still renders (XV). */
  resolution: 'full' | 'partial'
}

/*
 * `DriftRule`, `DriftFinding` and `DriftEvidence` were here.
 *
 * See `store/authored/config.ts` for the consequence that outlives them: the
 * D1-D9 identifier namespace is spent, because dismissal rows keyed on
 * `drift:<rule>:<subject>` are retained (FR-122). Any future finding scheme
 * starts at D10.
 */
