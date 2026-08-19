import {
  branchKey,
  checkKey,
  pullRequestKey,
  repositoryKey,
  sessionKey,
  ticketKey,
  workspaceKey,
  type NaturalKey,
} from '../../src/domain/keys.js'
import type {
  AgentSession,
  BranchRef,
  CheckResult,
  LocalWorkspace,
  Project,
  PullRequest,
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
 */

export const SITE = 'acme.atlassian.net'
export const REMOTE = 'github.com/acme/mercury'
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
    githubConnectionId: 'gh-1',
    repoOwner: 'acme',
    repoName: 'mercury',
    documentationUrl: null,
    ticketKeyPattern: '(MERC-\\d+)',
    checkoutPaths: ['D:\\work\\mercury'],
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

export function pullRequest(over: Partial<PullRequest> & { number?: number } = {}): PullRequest {
  const number = over.number ?? 451
  return {
    key: pullRequestKey('acme', 'mercury', number),
    connectionId: 'gh-1',
    number,
    title: 'fix: reconcile worktree on upstream branch delete',
    author: ME,
    headBranch: 'feature/MERC-1184',
    headSha: 'a1b2c3',
    baseBranch: 'main',
    state: 'open',
    isDraft: false,
    reviewDecision: null,
    requestedReviewers: [],
    unresolvedThreadCount: 0,
    mergedAt: null,
    closedAt: null,
    lastRealActivityAt: hoursAgo(2),
    url: `https://github.com/acme/mercury/pull/${number}`,
    fetchedAt: hoursAgo(0),
    ...over,
  }
}

export function check(over: Partial<CheckResult> & { name?: string } = {}): CheckResult {
  const name = over.name ?? 'build'
  const sha = over.sha ?? 'a1b2c3'
  return {
    key: checkKey('acme', 'mercury', sha, name),
    connectionId: 'gh-1',
    sha,
    name,
    state: 'success',
    isRequired: true,
    url: `https://github.com/acme/mercury/actions/runs/1`,
    completedAt: hoursAgo(2),
    fetchedAt: hoursAgo(0),
    ...over,
  }
}

export function branch(over: Partial<BranchRef> & { name?: string } = {}): BranchRef {
  const name = over.name ?? 'feature/MERC-1184'
  return {
    key: branchKey(REMOTE, name),
    connectionId: 'gh-1',
    name,
    headSha: 'a1b2c3',
    updatedAt: hoursAgo(2),
    url: `https://github.com/acme/mercury/tree/${name}`,
    fetchedAt: hoursAgo(0),
    ...over,
  }
}

export function workspace(over: Partial<LocalWorkspace> & { branch?: string } = {}): LocalWorkspace {
  const branchName = over.branch ?? 'feature/MERC-1184'
  return {
    key: workspaceKey(REMOTE, branchName, 'main'),
    repoPath: 'D:\\work\\mercury',
    canonicalRemote: REMOTE,
    branch: branchName,
    worktreeId: 'main',
    isPrimaryWorktree: true,
    worktreePresent: true,
    hasUncommittedChanges: false,
    unpushedCommitCount: 0,
    headSha: 'a1b2c3',
    upstreamRef: 'origin/feature/MERC-1184',
    readAt: hoursAgo(0),
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
    workspaceKey: workspaceKey(REMOTE, 'feature/MERC-1184', 'main'),
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
    pullRequests: [],
    checks: [],
    branches: [],
    comparisons: [],
    workspaces: [],
    sessions: [],
    noteCounts: {},
    openQuestionSubjects: [],
    operatorAccountIds: ['me'],
    settings: settings(),
    now: NOW,
    ...over,
  }
}

export const keys = {
  ticket: (issueKey: string): NaturalKey => ticketKey(SITE, issueKey),
  pr: (n: number): NaturalKey => pullRequestKey('acme', 'mercury', n),
  branch: (name: string): NaturalKey => branchKey(REMOTE, name),
  workspace: (name: string): NaturalKey => workspaceKey(REMOTE, name, 'main'),
  repo: (): NaturalKey => repositoryKey('acme', 'mercury'),
  session: (id: string): NaturalKey => sessionKey('claude-code', id),
}
