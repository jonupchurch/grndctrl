import type {
  AgentSession as CoreAgentSession,
  Comparison as CoreComparison,
  DriftFinding as CoreDriftFinding,
  LocalWorkspace as CoreWorkspace,
  Note as CoreNote,
  Project as CoreProject,
  PullRequest as CorePullRequest,
  Ticket as CoreTicket,
  WorkItem as CoreWorkItem,
} from '@grndctrl/core'

/**
 * The shapes the renderer reads — narrowed from the domain types, not restated.
 *
 * The renderer is an IPC client and must never import core *code*: a
 * `better-sqlite3` import reaching a sandboxed process is the thing the ESLint
 * boundary exists to prevent. But `import type` is erased before the bundler
 * runs, so nothing here survives into the bundle, and the rule allows types
 * only.
 *
 * These were once written out by hand, and the duplication did exactly what
 * duplication does. The renderer read `aheadBy`, `behindBy` and `repoKey` off a
 * workspace — none of which core has ever sent — and declared
 * `unpushedCommitCount` non-null when core uses null to mean "never pushed".
 * Every one of those typechecked on both sides, and the board printed
 * conclusions drawn from `undefined`.
 *
 * `Pick` keeps the original intent — only the fields the interface actually
 * renders get a name here — while making a field core does not have a compile
 * error rather than a confident wrong string on screen.
 */

export type BallInCourt = CoreWorkItem['ballInCourt']

/**
 * Derived by the service and never stored (FR-046), so it is part of the wire
 * shape rather than of the domain type — see `sessionSchema` in the registry.
 */
export type SessionState = 'running' | 'silent' | 'needs-you' | 'done' | 'failed'

export type Project = Pick<
  CoreProject,
  'id' | 'code' | 'name' | 'colorIndex' | 'jiraProjectKey' | 'repoOwner' | 'repoName' | 'documentationUrl'
>

export type Ticket = Pick<
  CoreTicket,
  | 'key'
  | 'issueKey'
  | 'summary'
  | 'statusName'
  | 'statusCategory'
  | 'isBlocked'
  // Both are nullable in the domain and null means *unknown* in both cases —
  // the ticket lane draws a placeholder for either, and never a zero.
  | 'priority'
  | 'storyPoints'
  | 'lastRealActivityAt'
>

export type PullRequest = Pick<
  CorePullRequest,
  | 'key'
  | 'number'
  | 'title'
  | 'headBranch'
  | 'state'
  | 'isDraft'
  | 'reviewDecision'
  | 'unresolvedThreadCount'
  | 'lastRealActivityAt'
>

export type Workspace = Pick<
  CoreWorkspace,
  'key' | 'branch' | 'canonicalRemote' | 'hasUncommittedChanges' | 'unpushedCommitCount'
>

/** Ahead/behind, which comes from the code host and never from local git (FR-018). */
export type Comparison = Pick<CoreComparison, 'branchKey' | 'aheadBy' | 'behindBy'>

export type AgentSession = Pick<
  CoreAgentSession,
  | 'key'
  | 'agentId'
  | 'sessionId'
  | 'projectId'
  | 'workItemKey'
  | 'reportedStatus'
  | 'startedAt'
  | 'lastRealActivityAt'
> & { state: SessionState }

export type WorkItem = Pick<
  CoreWorkItem,
  | 'key'
  | 'projectId'
  | 'noteCount'
  | 'severity'
  | 'staleness'
  | 'ballInCourt'
  | 'lastRealActivityAt'
  | 'resolution'
> & {
  ticket: Ticket | null
  workspaces: Workspace[]
  pullRequests: PullRequest[]
  checks: { key: string; conclusion: string | null; status: string }[]
  sessions: AgentSession[]
  comparisons: Comparison[]
}

export type DriftFinding = Pick<
  CoreDriftFinding,
  'id' | 'rule' | 'subjectKey' | 'projectId' | 'summary' | 'ageSec' | 'suggestedAction' | 'dispatchable'
> & {
  evidence: { side: string; fact: string; at: string | null }[]
}

export type Note = Pick<
  CoreNote,
  | 'id'
  | 'subjectKey'
  | 'type'
  | 'body'
  | 'authorKind'
  | 'authorId'
  // A timestamp, not a boolean. The renderer declared `resolved: boolean` and
  // filtered Attention nudges on `!n.resolved` — which read undefined on every
  // note, negated to true, and passed all of them. It only looked correct
  // because `notes.attention` already filters server-side.
  | 'resolvedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'revision'
>

export interface BoardSummary {
  total: number
  yourCourt: number
  drifting: number
  stalled: number
  agentsLive: number
  lanes: { tickets: number; pulls: number; branches: number; sessions: number }
}
