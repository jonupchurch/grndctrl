import { sessionKey, ticketKey, type NaturalKey } from '../../src/domain/keys.js'
import type {
  AgentSession,
  Project,
  Settings,
  Ticket,
  ViewerIdentity,
} from '../../src/domain/types.js'
import { DEFAULT_SETTINGS } from '../../src/services/settings.js'
import type { CorrelationInput } from '../../src/correlation/join.js'

/**
 * Builders for correlation fixtures.
 *
 * Every field has a defensible default so a test states only what it is about.
 * A join test that has to spell out fifteen unrelated fields stops being read,
 * and a test nobody reads stops being maintained.
 *
 * **Five builders left this file**: `pullRequest`, `check`, `branch`,
 * `workspace` and the comparison helper. This module feeds most of the core
 * suite, which is why it is the change that lets the rest of the phase compile.
 */

export const SITE = 'acme.atlassian.net'
export const NOW = new Date('2026-08-14T12:00:00Z')

export const ME: ViewerIdentity = { accountId: 'me', displayName: 'Jon', email: null }
export const THEM: ViewerIdentity = { accountId: 'them', displayName: 'Sam', email: null }

/** Hours before NOW, as an ISO timestamp. */
export const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString()

export function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p-merc',
    code: 'MERC',
    name: 'Mercury',
    colorIndex: 0,
    jiraConnectionId: 'jira-1',
    jiraProjectKey: 'MERC',
    documentationUrl: null,
    statusOverrides: {},
    ...over,
  }
}

export function ticket(over: Partial<Ticket> & { issueKey?: string } = {}): Ticket {
  const issueKey = over.issueKey ?? 'MERC-1184'
  return {
    key: ticketKey(SITE, issueKey),
    connectionId: 'jira-1',
    issueKey,
    summary: 'Reconcile worktree state when a branch is deleted upstream',
    assignee: ME,
    reporter: THEM,
    statusName: 'In Progress',
    statusCategory: 'indeterminate',
    isBlocked: false,
    priority: 'Medium',
    storyPoints: 3,
    sprint: 'Sprint 12',
    createdAt: hoursAgo(200),
    updatedAt: hoursAgo(1),
    lastRealActivityAt: hoursAgo(2),
    lastStatusChangeAt: hoursAgo(2),
    url: `https://${SITE}/browse/${issueKey}`,
    fetchedAt: hoursAgo(0),
    ...over,
  }
}

export function session(over: Partial<AgentSession> & { sessionId?: string } = {}): AgentSession {
  const sessionId = over.sessionId ?? 's1'
  return {
    key: sessionKey('claude-code', sessionId),
    agentId: 'claude-code',
    sessionId,
    projectId: 'p-merc',
    workItemKey: ticketKey(SITE, 'MERC-1184'),
    reportedStatus: 'Writing tests for the cold-start path',
    startedAt: hoursAgo(3),
    lastHeartbeatAt: hoursAgo(0),
    lastRealActivityAt: hoursAgo(1),
    endedAt: null,
    outcome: null,
    heartbeatIntervalSec: 60,
    ...over,
  }
}

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over }
}

export function input(over: Partial<CorrelationInput> = {}): CorrelationInput {
  return {
    projects: [project()],
    tickets: [],
    sessions: [],
    noteCounts: {},
    openQuestionSubjects: [],
    operatorAccountIds: ['me'],
    settings: settings(),
    now: NOW,
    ...over,
  }
}

/**
 * Two key constructors, from six.
 *
 * The other four — `pr`, `branch`, `workspace`, `repo` — named subjects that
 * correlation no longer produces. `domain/keys.ts` still *constructs* and still
 * parses all six, deliberately: a note written before 006 carries one of those
 * keys and has to stay readable (T040). What is gone is any reason for a
 * correlation fixture to mint one.
 */
export const keys = {
  ticket: (issueKey: string): NaturalKey => ticketKey(SITE, issueKey),
  session: (id: string): NaturalKey => sessionKey('claude-code', id),
}
