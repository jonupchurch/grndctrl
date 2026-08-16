import type { Project, PullRequest } from '../domain/types.js'

/**
 * Finding the ticket a branch or PR belongs to.
 *
 * FR-021 fixes the precedence: branch name, then PR title, then PR body. The
 * order is not arbitrary — a branch name is chosen once and deliberately, a
 * title is edited, and a body can quote half a dozen other tickets in a
 * checklist. Searching the body first would attach work to whichever ticket
 * someone happened to link.
 */

export type MatchSource = 'branch' | 'pr-title' | 'pr-body'

export interface KeyMatch {
  issueKey: string
  source: MatchSource
  projectId: string
}

/**
 * Compile a project's key pattern once.
 *
 * A bad pattern is a configuration error, not a crash: an uncompilable pattern
 * yields a matcher that matches nothing, so one malformed project cannot take
 * the whole correlation pass down with it.
 */
export function compileKeyPattern(project: Project): RegExp | null {
  try {
    // Global so every occurrence is visible; the caller decides which to take.
    return new RegExp(project.ticketKeyPattern, 'gi')
  } catch {
    return null
  }
}

/** The default pattern for a project bound to a Jira project key. */
export function defaultKeyPattern(jiraProjectKey: string): string {
  return `(${escapeRegex(jiraProjectKey)}-\\d+)`
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function firstMatch(pattern: RegExp, text: string): string | null {
  pattern.lastIndex = 0
  const m = pattern.exec(text)
  if (m === null) return null
  // Prefer the first capture group if the pattern declares one; otherwise the
  // whole match. Patterns are user-editable, so both shapes have to work.
  return (m[1] ?? m[0]).toUpperCase()
}

/**
 * Match a branch name against the configured projects.
 *
 * When two projects' patterns both match, the first by project code wins and
 * the caller is told it was ambiguous — attributing silently would put the work
 * in a lane the user is not looking at.
 */
export function matchBranch(
  branchName: string,
  projects: readonly Project[],
): { match: KeyMatch | null; ambiguous: boolean } {
  const hits: KeyMatch[] = []

  for (const project of ordered(projects)) {
    const pattern = compileKeyPattern(project)
    if (pattern === null) continue

    const issueKey = firstMatch(pattern, branchName)
    if (issueKey !== null) hits.push({ issueKey, source: 'branch', projectId: project.id })
  }

  return { match: hits[0] ?? null, ambiguous: hits.length > 1 }
}

/**
 * Match a pull request, applying the FR-021 precedence across its three fields.
 *
 * The head branch is consulted first even here: a PR whose title was reworded
 * still belongs to the ticket its branch was cut for.
 */
export function matchPullRequest(
  pr: Pick<PullRequest, 'headBranch' | 'title'> & { body?: string },
  projects: readonly Project[],
): { match: KeyMatch | null; ambiguous: boolean } {
  const fields: { text: string; source: MatchSource }[] = [
    { text: pr.headBranch, source: 'branch' },
    { text: pr.title, source: 'pr-title' },
    { text: pr.body ?? '', source: 'pr-body' },
  ]

  for (const field of fields) {
    if (field.text === '') continue

    const hits: KeyMatch[] = []
    for (const project of ordered(projects)) {
      const pattern = compileKeyPattern(project)
      if (pattern === null) continue

      const issueKey = firstMatch(pattern, field.text)
      if (issueKey !== null) hits.push({ issueKey, source: field.source, projectId: project.id })
    }

    // First field that matches anything decides. Falling through to the body
    // after the branch already matched is how a checklist link wins.
    if (hits.length > 0) return { match: hits[0] ?? null, ambiguous: hits.length > 1 }
  }

  return { match: null, ambiguous: false }
}

/** Stable ordering, so an ambiguous match resolves the same way every run (FR-024). */
function ordered(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id))
}
