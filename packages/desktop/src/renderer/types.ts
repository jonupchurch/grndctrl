import type { DocNode as CoreDocNode, InlineNode as CoreInlineNode } from '@grndctrl/core'
import type {
  AgentSession as CoreAgentSession,
  AgentUpdate as CoreAgentUpdate,
  Note as CoreNote,
  Prompt as CorePrompt,
  Project as CoreProject,
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
 *
 * **That is what caught 006's renderer work.** Every field this file no longer
 * names was removed because `Pick` refused it, not because somebody went
 * looking: five types and eleven fields, each one a compile error at exactly
 * the moment core stopped providing it. A hand-written mirror would have
 * compiled throughout and gone on reading `undefined`.
 */

export type BallInCourt = CoreWorkItem['ballInCourt']

/**
 * Derived by the service and never stored (FR-046), so it is part of the wire
 * shape rather than of the domain type — see `sessionSchema` in the registry.
 */
export type SessionState = 'running' | 'silent' | 'needs-you' | 'done' | 'failed'

export type Project = Pick<
  CoreProject,
  'id' | 'code' | 'name' | 'colorIndex' | 'jiraProjectKey' | 'documentationUrl'
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
  // The name of the sprint the ticket is currently in, chosen at ingest out of
  // the several a carried-over ticket carries. Null is "no sprint" or "this site
  // has no sprint field", and the lane draws a placeholder for either.
  | 'sprint'
  // Already converted, at ingest, in the provider. The renderer never sees
  // Atlassian Document Format and never sees markup — see `domain/adf.ts` and
  // `components/Document.tsx`.
  | 'description'
  | 'lastRealActivityAt'
>

/**
 * The description's node types, re-exported rather than restated.
 *
 * `Document.tsx` switches exhaustively over these, so a node kind added in core
 * and not handled here is a compile error rather than a branch that silently
 * renders nothing. Restating them would turn that into a runtime surprise, which
 * is the whole argument at the top of this file.
 */
export type DocNode = CoreDocNode
export type InlineNode = CoreInlineNode

/**
 * Every field, and there are only six.
 *
 * `Pick`ed like everything else in this file rather than aliased, so that a
 * field added in core has to be named here before the panel can read it — the
 * discipline at the top of this file is about the fields the interface renders,
 * and a full alias would quietly opt this type out of it.
 */
export type AgentUpdate = Pick<
  CoreAgentUpdate,
  'id' | 'sessionKey' | 'agentId' | 'ticketKey' | 'text' | 'postedAt'
>

/**
 * A recorded prompt. Every field, and the text is the whole text.
 *
 * The panel truncates a row for display and **must not** truncate anything here:
 * what the copy control sends is an id, and what main copies is what core holds
 * (FR-138, FR-139). A narrowed type that dropped `text` would look tidier and
 * would make the row unable to show a preview at all.
 */
export type Prompt = Pick<
  CorePrompt,
  'id' | 'text' | 'agentId' | 'sessionKey' | 'projectId' | 'recordedAt'
>

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
  // Not nullable (FR-106). A work item is built from a ticket and there is no
  // other way to construct one, so the lane's `withTickets` filter went with the
  // null it was guarding against.
  ticket: Ticket
  sessions: AgentSession[]
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
  // filtered on `!n.resolved` — which read undefined on every note, negated to
  // true, and passed all of them. It only looked correct because the operation
  // already filters server-side.
  | 'resolvedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'revision'
>

export interface BoardSummary {
  total: number
  yourCourt: number
  stalled: number
  agentsLive: number
  lanes: { tickets: number; sessions: number }
}
