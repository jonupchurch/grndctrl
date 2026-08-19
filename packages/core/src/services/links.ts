import { subjectKindOf } from '../domain/keys.js'
import type { Project, Ticket } from '../domain/types.js'
import { invalid, notFound } from '../registry/errors.js'

/**
 * The only place a URL is produced.
 *
 * "Everything is a launcher" (FR-075) means every row on the board opens
 * something in a browser, and every one of those URLs comes from provider data.
 * Provider data is hostile input: it is exactly where a `javascript:` or `file:`
 * scheme would arrive from.
 *
 * Centralising resolution here means the scheme check happens once, in code
 * with no UI around it, and the Electron main process can pass the result to
 * `shell.openExternal` knowing it was validated by something testable
 * (FR-077).
 *
 * **Four of the seven targets are gone**, with the code host and the local
 * checkout that produced them. A removed target is an explicit error and never
 * a fallback to the ticket: a caller asking for a pull-request link and being
 * handed the ticket page has been answered, wrongly, in a way it cannot detect.
 */

export type LinkTarget = 'default' | 'ticket' | 'documentation'

export interface LinkSources {
  tickets: readonly Ticket[]
  projects: readonly Project[]
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

  /*
   * Four arms were here: pull request, check, branch-or-workspace, repository.
   *
   * The branch arm was the interesting one and is the reason `fellBack` exists.
   * A branch the code host had never seen has no page to open, so it answered
   * with the repository and said it had done so — the difference between
   * "this is the page you asked for" and "this is the nearest one we could
   * find". Nothing sets it now, and the field stays in the result for the reason
   * recorded in the contract: a caller reading it is told the truth, and the
   * next link kind that needs the distinction will want it back.
   *
   * A subject key of a removed kind still *parses*. `subjectKindOf` keeps every
   * kind it can recognise, deliberately: a note written before this change
   * carries one, and a parser that stopped recognising it would turn a retained
   * note into an unreadable one. Such a key simply has nowhere to open, which is
   * what the throw below says.
   */

  // Agent sessions have no web page, and inventing one would be worse than
  // saying so -- a link that goes somewhere plausible and wrong is a bug the
  // user has to discover by clicking (FR-048). The same is now true of a pull
  // request, a branch or a check recorded before 006.
  throw notFound('That row has no page to open.')
}

/**
 * The two links the header offers when the filter narrows to one project
 * (FR-070): its Jira board and its documentation. There were three, and the
 * repository went with the provider that served it.
 *
 * Each is `notFound` when that binding is not configured, rather than falling
 * back to something else. A project with no documentation link has none to open,
 * and quietly opening the Jira board instead would be a link that goes somewhere
 * plausible and wrong.
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
 * Matched on the one binding a project has — its Jira key. It matched on the
 * repository too, which was the arm that made this work for a pull request or a
 * branch; those subjects no longer reach here. Correlation does the richer
 * version of this; a link does not need it.
 */
function projectForSubject(subjectKey: string, projects: readonly Project[]): Project | undefined {
  return projects.find(
    (project) =>
      project.jiraProjectKey !== null && subjectKey.includes(`/${project.jiraProjectKey}-`),
  )
}
