import { subjectKindOf, type NaturalKey } from '../domain/keys.js'
import type { BranchRef, Project, PullRequest, Ticket } from '../domain/types.js'
import { invalid, notFound } from '../registry/errors.js'

/**
 * The only place a URL is produced.
 *
 * "Everything is a launcher" (FR-075) means every row on the board opens
 * something in a browser, and every one of those URLs comes from provider data
 * — ticket links, PR links, check-run links. Provider data is hostile input:
 * it is exactly where a `javascript:` or `file:` scheme would arrive from.
 *
 * Centralising resolution here means the scheme check happens once, in code
 * with no UI around it, and the Electron main process can pass the result to
 * `shell.openExternal` knowing it was validated by something testable
 * (FR-077).
 */

export type LinkTarget =
  | 'default'
  | 'ticket'
  | 'pull-request'
  | 'repository'
  | 'branch'
  | 'documentation'
  | 'check'

export interface LinkSources {
  tickets: readonly Ticket[]
  pullRequests: readonly PullRequest[]
  branches: readonly BranchRef[]
  projects: readonly Project[]
  checks: readonly { key: NaturalKey; url: string }[]
  /**
   * Needed only for a Jira *project* link, which is the one URL in the product
   * that cannot be read off a mirrored row: no ticket carries its project's
   * board address, and the site lives on the connection.
   */
  connections?: readonly { id: string; siteOrHost: string }[]
}

/**
 * Accept only `https`.
 *
 * Not `http`: every provider this application talks to is HTTPS, so a plain
 * `http` URL is either a misconfiguration or something injected. Refusing it
 * costs nothing real and closes the downgrade.
 */
export function safeExternalUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  return url.protocol === 'https:' ? url.toString() : null
}

export function resolveLink(
  subjectKey: string,
  target: LinkTarget,
  sources: LinkSources,
): { url: string; fellBack: boolean } {
  const kind = subjectKindOf(subjectKey)
  if (kind === null) throw invalid(`'${subjectKey}' is not a subject key.`)

  if (kind === 'project') return resolveProject(subjectKey, target, sources)

  if (target === 'documentation') {
    // Scoped to the subject's own project rather than to whichever project
    // happens to have a documentation URL. With one project configured the two
    // are the same; with two, the unscoped version opens the wrong team's wiki.
    const project = projectForSubject(subjectKey, sources.projects)
    const url = safeExternalUrl(project?.documentationUrl)
    if (url === null) throw notFound('No documentation link is configured for this project.')
    return { url, fellBack: false }
  }

  if (kind === 'ticket') {
    const ticket = sources.tickets.find((t) => t.key === subjectKey)
    const url = safeExternalUrl(ticket?.url)
    if (url === null) throw notFound('That ticket has no usable link.')
    return { url, fellBack: false }
  }

  if (kind === 'pull-request') {
    const pr = sources.pullRequests.find((p) => p.key === subjectKey)
    const url = safeExternalUrl(pr?.url)
    if (url === null) throw notFound('That pull request has no usable link.')
    return { url, fellBack: false }
  }

  if (kind === 'check') {
    const check = sources.checks.find((c) => c.key === subjectKey)
    const url = safeExternalUrl(check?.url)
    if (url === null) throw notFound('That check has no usable link.')
    return { url, fellBack: false }
  }

  if (kind === 'branch' || kind === 'workspace') {
    const branchName = branchNameOf(subjectKey)
    const ref = sources.branches.find((b) => b.name === branchName)

    const branchUrl = safeExternalUrl(ref?.url)
    if (branchUrl !== null) return { url: branchUrl, fellBack: false }

    // FR-076: a branch the code host has never seen has no page to open. The
    // repository is the honest fallback -- and `fellBack` is returned rather
    // than hidden, so the UI can say why it did not land where the user
    // expected.
    const repoUrl = repositoryUrlFor(subjectKey, sources.projects)
    if (repoUrl === null) throw notFound('That branch has no link and no repository to fall back to.')
    return { url: repoUrl, fellBack: true }
  }

  if (kind === 'repository') {
    const url = repositoryUrlFor(subjectKey, sources.projects)
    if (url === null) throw notFound('That repository has no usable link.')
    return { url, fellBack: false }
  }

  // Agent sessions have no web page, and inventing one would be worse than
  // saying so -- a link that goes somewhere plausible and wrong is a bug the
  // user has to discover by clicking (FR-048).
  throw notFound('That row has no page to open.')
}

/**
 * The three links the header offers when the filter narrows to one project
 * (FR-070): its Jira board, its repository, and its documentation.
 *
 * Each is `notFound` when that half of the binding is not configured, rather
 * than falling back to something else. A project with no repository bound has
 * no repository to open, and quietly opening the Jira board instead would be a
 * link that goes somewhere plausible and wrong.
 */
function resolveProject(
  subjectKey: string,
  target: LinkTarget,
  sources: LinkSources,
): { url: string; fellBack: boolean } {
  const id = subjectKey.slice('project:'.length)
  const project = sources.projects.find((p) => p.id === id)
  if (project === undefined) throw notFound('That project is not configured.')

  if (target === 'documentation') {
    const url = safeExternalUrl(project.documentationUrl)
    if (url === null) throw notFound('No documentation link is configured for this project.')
    return { url, fellBack: false }
  }

  if (target === 'repository') {
    if (project.repoOwner === null || project.repoName === null) {
      throw notFound('No repository is bound to this project.')
    }
    const url = safeExternalUrl(`https://github.com/${project.repoOwner}/${project.repoName}`)
    if (url === null) throw notFound('That repository has no usable link.')
    return { url, fellBack: false }
  }

  // `default` and `ticket` both mean the Jira board — it is what a project *is*
  // to the operator, and the tickets are on it.
  if (project.jiraProjectKey === null || project.jiraConnectionId === null) {
    throw notFound('No Jira project is bound to this project.')
  }

  const connection = (sources.connections ?? []).find((c) => c.id === project.jiraConnectionId)
  if (connection === undefined) throw notFound('That project’s Jira account is not connected.')

  const url = safeExternalUrl(
    `https://${connection.siteOrHost}/jira/software/projects/${project.jiraProjectKey}/boards`,
  )
  if (url === null) throw notFound('That Jira project has no usable link.')
  return { url, fellBack: false }
}

/**
 * Which project a subject belongs to.
 *
 * Matched on the two bindings a project has — its Jira key and its repository —
 * because that is the only relationship that exists here. Correlation does the
 * richer version of this; a link does not need it.
 */
function projectForSubject(subjectKey: string, projects: readonly Project[]): Project | undefined {
  return projects.find((project) => {
    if (project.jiraProjectKey !== null && subjectKey.includes(`/${project.jiraProjectKey}-`)) {
      return true
    }
    if (project.repoOwner === null || project.repoName === null) return false
    return subjectKey.toLowerCase().includes(`${project.repoOwner}/${project.repoName}`.toLowerCase())
  })
}

/** `repo:github.com/acme/mercury#feature/x` or `ws:...#branch@worktree`. */
function branchNameOf(subjectKey: string): string | null {
  const hash = subjectKey.indexOf('#')
  if (hash === -1) return null
  const rest = subjectKey.slice(hash + 1)
  const at = rest.lastIndexOf('@')
  return at === -1 ? rest : rest.slice(0, at)
}

function repositoryUrlFor(subjectKey: string, projects: readonly Project[]): string | null {
  const hash = subjectKey.indexOf('#')
  const prefix = subjectKey.slice(subjectKey.indexOf(':') + 1, hash === -1 ? undefined : hash)

  for (const project of projects) {
    if (project.repoOwner === null || project.repoName === null) continue
    const remote = `github.com/${project.repoOwner}/${project.repoName}`.toLowerCase()
    if (prefix.toLowerCase() === remote || prefix.toLowerCase() === `${project.repoOwner}/${project.repoName}`.toLowerCase()) {
      return safeExternalUrl(`https://github.com/${project.repoOwner}/${project.repoName}`)
    }
  }
  return null
}
