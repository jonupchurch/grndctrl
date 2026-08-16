import { ticketKey } from '../../domain/keys.js'
import type {
  StatusCategory,
  Ticket,
  TicketActivity,
  ViewerIdentity,
} from '../../domain/types.js'
import { countsAsRealActivity } from '../../correlation/activity.js'
import { httpClient, type Fetcher } from '../http.js'
import type { TicketProvider } from '../seam.js'

/**
 * Jira Cloud, read-only.
 *
 * Two things here are not the obvious implementation, and both came out of
 * Phase 0 research (R2):
 *
 *   **Search returns no total.** The old `/rest/api/3/search` endpoints were
 *   deprecated and shut down; the replacement paginates on `nextPageToken` and
 *   reports no count. So the number of tickets is the number fetched, and the
 *   UI must never imply a server-side total.
 *
 *   **History is a separate call.** `expand=changelog` is not dependable on the
 *   enhanced endpoint — the bulk changelog endpoint exists precisely because of
 *   that. Staleness and three drift rules rest on this, and `updated` is the
 *   field FR-027 exists to distrust, so falling back to it would turn "we could
 *   not fetch the history" into a confident wrong answer.
 */

export interface JiraOptions {
  site: string
  email: string
  apiToken: string
  connectionId?: string
  fetcher?: Fetcher
  now?: () => Date
}

/** Issues per `changelog/bulkfetch` request. Atlassian's documented ceiling. */
const CHANGELOG_BATCH = 100

interface JiraSearchResponse {
  issues?: JiraIssue[]
  nextPageToken?: string
  isLast?: boolean
}

interface JiraIssue {
  id: string
  key: string
  fields?: {
    summary?: string
    status?: { name?: string; statusCategory?: { key?: string } }
    assignee?: JiraUser | null
    reporter?: JiraUser | null
    created?: string
    updated?: string
  }
}

interface JiraUser {
  accountId?: string
  displayName?: string
  emailAddress?: string | null
}

interface JiraChangelogResponse {
  issueChangeLogs?: {
    issueId?: string
    changeHistories?: {
      created?: string
      author?: JiraUser & { accountType?: string }
      items?: { field?: string }[]
    }[]
  }[]
}

export function jiraProvider(options: JiraOptions): TicketProvider {
  const now = options.now ?? (() => new Date())

  const client = httpClient({
    baseUrl: `https://${options.site}`,
    headers: {
      // Basic auth with an API token is Jira Cloud's documented scheme. The
      // token comes from the keychain at call time and is never stored here.
      Authorization: `Basic ${base64(`${options.email}:${options.apiToken}`)}`,
    },
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
  })

  return {
    async viewer(): Promise<ViewerIdentity> {
      const me = await client.get<JiraUser>('/rest/api/3/myself')
      return toIdentity(me) ?? { accountId: '', displayName: 'unknown', email: null }
    },

    async searchIssues({ jql, pageSize, pageToken }) {
      const response = await client.post<JiraSearchResponse>('/rest/api/3/search/jql', {
        jql,
        maxResults: pageSize ?? 100,
        fields: ['summary', 'status', 'assignee', 'reporter', 'created', 'updated'],
        // Omitted entirely on the first call. The endpoint rejects a null token
        // rather than treating it as "start from the beginning".
        ...(pageToken === undefined ? {} : { nextPageToken: pageToken }),
      })

      const fetchedAt = now().toISOString()
      const tickets = (response.issues ?? []).map((issue) =>
        toTicket(issue, options.site, options.connectionId ?? '', fetchedAt),
      )

      return {
        tickets,
        // Present only while more pages exist. There is deliberately no `total`
        // to return -- the endpoint does not provide one, and inventing an
        // estimate would be worse than admitting the count is what we fetched.
        nextPageToken: response.isLast === true ? null : (response.nextPageToken ?? null),
      }
    },

    async fetchChangelogs(issueKeys) {
      if (issueKeys.length === 0) return []

      // Batched, because `bulkfetch` bounds how many issues one request may
      // name. Until ticket search followed its pages this was invisible: the
      // search returned at most one page, so this was never handed more keys
      // than the endpoint would take. Pagination removed that accident, and an
      // over-long request here fails the whole call -- which shows up as every
      // ticket on the connection reporting "activity unknown".
      const batches: string[][] = []
      for (let i = 0; i < issueKeys.length; i += CHANGELOG_BATCH) {
        batches.push([...issueKeys].slice(i, i + CHANGELOG_BATCH))
      }

      const logs: JiraChangelogResponse['issueChangeLogs'] = []
      for (const issueIdsOrKeys of batches) {
        const response = await client.post<JiraChangelogResponse>(
          '/rest/api/3/changelog/bulkfetch',
          { issueIdsOrKeys },
        )
        logs.push(...(response.issueChangeLogs ?? []))
      }

      const activity: TicketActivity[] = []

      for (const log of logs ?? []) {
        const issueKey = log.issueId
        if (issueKey === undefined) continue

        for (const history of log.changeHistories ?? []) {
          const at = history.created
          if (at === undefined) continue

          const authorKind = classifyAuthor(history.author)

          for (const item of history.items ?? []) {
            const field = item.field ?? 'unknown'
            activity.push({
              ticketKey: ticketKey(options.site, issueKey),
              at,
              authorKind,
              field,
              // Decided here, at ingest, and stored -- so the staleness a user
              // is looking at can be traced back to the rule that produced it.
              countsAsReal: countsAsRealActivity({ authorKind, field }),
            })
          }
        }
      }

      return activity
    },
  }
}

/**
 * Status semantics come from the **category**, never the name.
 *
 * A team that renames "Done" to "Shipped" must not break drift rule D1, and a
 * team with three in-progress columns must not need three rules. Jira's own
 * categorisation is the only stable thing here (spec Assumption 5).
 */
export function toStatusCategory(categoryKey: string | undefined): StatusCategory {
  switch (categoryKey) {
    case 'done':
      return 'done'
    case 'new':
    case 'undefined':
      return 'new'
    case 'indeterminate':
      return 'indeterminate'
    default:
      // An unknown category is treated as in-progress rather than done: calling
      // something done when it is not is the error that closes live work.
      return 'indeterminate'
  }
}

function toTicket(issue: JiraIssue, site: string, connectionId: string, fetchedAt: string): Ticket {
  const fields = issue.fields ?? {}
  const statusName = fields.status?.name ?? 'Unknown'

  return {
    key: ticketKey(site, issue.key),
    connectionId,
    issueKey: issue.key,
    summary: fields.summary ?? '',
    assignee: toIdentity(fields.assignee),
    reporter: toIdentity(fields.reporter),
    statusName,
    statusCategory: toStatusCategory(fields.status?.statusCategory?.key),
    isBlocked: /blocked|impediment/i.test(statusName),
    createdAt: fields.created ?? fetchedAt,
    updatedAt: fields.updated ?? fetchedAt,
    // Filled in from the changelog, which is a separate call. Null until then,
    // and null means unknown -- never backfilled from `updated`.
    lastRealActivityAt: null,
    lastStatusChangeAt: null,
    url: `https://${site}/browse/${issue.key}`,
    fetchedAt,
  }
}

function toIdentity(user: JiraUser | null | undefined): ViewerIdentity | null {
  if (user === null || user === undefined || user.accountId === undefined) return null
  return {
    accountId: user.accountId,
    displayName: user.displayName ?? user.accountId,
    email: user.emailAddress ?? null,
  }
}

/**
 * Distinguish a human from automation.
 *
 * FR-027 turns on this: a ticket touched hourly by an automation rule looks
 * alive and is abandoned. Jira marks app accounts with `accountType: 'app'`;
 * the name heuristic catches the rest, and errs toward `bot`, because
 * mis-classifying a bot as a human resets a staleness clock that should have
 * kept running.
 */
export function classifyAuthor(
  author: (JiraUser & { accountType?: string }) | undefined,
): 'human' | 'bot' | 'automation' {
  if (author === undefined) return 'automation'
  if (author.accountType === 'app') return 'automation'

  const name = author.displayName ?? ''
  if (/\b(bot|automation|jenkins|github|gitlab|renovate|dependabot|webhook)\b/i.test(name)) {
    return 'bot'
  }
  return 'human'
}

/** Apply fetched changelogs to the tickets they belong to. */
export function applyActivity(tickets: readonly Ticket[], activity: readonly TicketActivity[]): Ticket[] {
  const byTicket = new Map<string, TicketActivity[]>()
  for (const a of activity) {
    const list = byTicket.get(a.ticketKey) ?? []
    list.push(a)
    byTicket.set(a.ticketKey, list)
  }

  return tickets.map((ticket) => {
    const entries = byTicket.get(ticket.key) ?? []
    const real = entries.filter((e) => e.countsAsReal).map((e) => e.at).sort()
    const statusChanges = entries
      .filter((e) => e.field === 'status' && e.countsAsReal)
      .map((e) => e.at)
      .sort()

    return {
      ...ticket,
      lastRealActivityAt: real.at(-1) ?? null,
      lastStatusChangeAt: statusChanges.at(-1) ?? null,
    }
  })
}

function base64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}
