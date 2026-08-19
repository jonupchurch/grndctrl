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
 *
 *   **Story points and sprint have no field id.** Both are custom fields whose
 *   ids differ per site — `customfield_10016` on one, `customfield_10004` on the
 *   next — so there is nothing to hard-code and a guess would read some other
 *   field's value. The site's field list is fetched **once** per provider
 *   instance and both ids are resolved from it; see `storyPointFieldId` and
 *   `sprintFieldId`.
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
    priority?: { name?: string } | null
    created?: string
    updated?: string
    /** Story points arrive under a `customfield_*` key that varies per site. */
    [customField: string]: unknown
  }
}

/** One entry of `/rest/api/3/field`. Everything on it is optional in practice. */
interface JiraFieldDescriptor {
  id?: string
  name?: string
  custom?: boolean
  /**
   * `type` is the JSON shape; `custom` is the plugin key that says what the
   * field *is*. Sprint is identified by the second — `Sprint` is a name a team
   * can give any field, and the greenhopper key is not.
   */
  schema?: { type?: string; custom?: string }
}

/** The two per-site custom field ids the ticket lane needs, or nothing. */
interface CustomFieldIds {
  points: string | null
  sprint: string | null
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

  /**
   * The site's story point and sprint field ids, resolved once and reused.
   *
   * **One request answers both.** `/rest/api/3/field` returns the whole field
   * list, so asking twice would spend a second round trip on a payload already
   * in hand — and would let the two columns disagree about which fetch they came
   * from if one call failed and the other did not.
   *
   * Memoised on the promise rather than on its result, so the several pages of
   * one search share a single lookup instead of racing to make the same call.
   * Providers are rebuilt per sync, so this is one extra GET per sync and a
   * transient failure is not remembered past it.
   *
   * **A failure resolves to nulls rather than throwing.** The lookup needs no
   * permission the ticket search does not already have, but if it fails anyway
   * the honest outcome is a board with no points and no sprints on it -- not a
   * board with no tickets on it. Those are columns; the search is the lane.
   */
  let fieldLookup: Promise<CustomFieldIds> | undefined

  const customFields = (): Promise<CustomFieldIds> => {
    fieldLookup ??= client
      .get<JiraFieldDescriptor[]>('/rest/api/3/field')
      .then((fields) => ({ points: storyPointFieldId(fields), sprint: sprintFieldId(fields) }))
      .catch(() => ({ points: null, sprint: null }))
    return fieldLookup
  }

  return {
    async viewer(): Promise<ViewerIdentity> {
      const me = await client.get<JiraUser>('/rest/api/3/myself')
      return toIdentity(me) ?? { accountId: '', displayName: 'unknown', email: null }
    },

    async searchIssues({ jql, pageSize, pageToken }) {
      const custom = await customFields()

      const response = await client.post<JiraSearchResponse>('/rest/api/3/search/jql', {
        jql,
        maxResults: pageSize ?? 100,
        fields: [
          'summary',
          'status',
          'assignee',
          'reporter',
          'priority',
          'created',
          'updated',
          // Only when the site actually has them. Naming a field id that does
          // not exist is not ignored -- Jira rejects the whole search, which
          // would take the ticket lane down over a column.
          ...(custom.points === null ? [] : [custom.points]),
          ...(custom.sprint === null ? [] : [custom.sprint]),
        ],
        // Omitted entirely on the first call. The endpoint rejects a null token
        // rather than treating it as "start from the beginning".
        ...(pageToken === undefined ? {} : { nextPageToken: pageToken }),
      })

      const fetchedAt = now().toISOString()
      const tickets = (response.issues ?? []).map((issue) =>
        toTicket(issue, options.site, options.connectionId ?? '', fetchedAt, custom),
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

function toTicket(
  issue: JiraIssue,
  site: string,
  connectionId: string,
  fetchedAt: string,
  custom: CustomFieldIds,
): Ticket {
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
    // Jira's own word for it, unmapped. An unset priority is null, never the
    // bottom of a scale this code does not know the shape of.
    priority: nonEmpty(fields.priority?.name),
    storyPoints: custom.points === null ? null : toPoints(fields[custom.points]),
    sprint: custom.sprint === null ? null : currentSprint(fields[custom.sprint]),
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

/**
 * Which of a site's fields holds story points.
 *
 * There is no stable id to hard-code. Jira Cloud ships two different fields
 * depending on how the project was created — `Story Points` on company-managed
 * projects, `Story point estimate` on team-managed ones — and both are custom
 * fields whose numeric id is assigned per site. A site can have both, when a
 * team has migrated between project types, and then the company-managed one is
 * the one that carries the historical estimates.
 *
 * The match is on the **name**, anchored at the start, and the result is
 * required to be a custom numeric field:
 *
 * - `custom: false` rules out `timeestimate`, which is seconds of work and
 *   would render as an eight-thousand-point ticket.
 * - a declared schema type other than `number` rules out a text field somebody
 *   named "Story points (old)". A field that declares no schema is allowed
 *   through, because absence is not a contradiction, and `toPoints` will refuse
 *   a value that turns out not to be numeric anyway.
 *
 * Returns `null` when nothing matches, which is a real answer: plenty of Jira
 * sites do not estimate in points at all.
 */
export function storyPointFieldId(fields: unknown): string | null {
  if (!Array.isArray(fields)) return null

  const candidates = (fields as JiraFieldDescriptor[]).filter((field) => {
    if (typeof field?.id !== 'string' || typeof field.name !== 'string') return false
    if (field.custom === false) return false
    if (field.schema?.type !== undefined && field.schema.type !== 'number') return false
    return /^story point/i.test(field.name.trim())
  })

  const named = (want: string): string | undefined =>
    candidates.find((f) => (f.name ?? '').trim().toLowerCase() === want)?.id

  return named('story points') ?? named('story point estimate') ?? candidates[0]?.id ?? null
}

/**
 * A custom field's value as a number, or nothing.
 *
 * Jira sends these as JSON numbers, but a field id resolved by name is still a
 * field this code did not choose, so a non-numeric value is refused rather than
 * coerced — `Number(null)` is 0, and a zero-point estimate the operator never
 * made is exactly the kind of confident wrong number this project keeps finding.
 * `0` itself passes through: a ticket really can be estimated at zero.
 */
export function toPoints(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null

  // Some Jira configurations return a numeric custom field as a string. Only a
  // string that is entirely a number is taken; `''` and `'TBD'` are not zero.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

/** The plugin key Jira Software stamps on the sprint field, on every site. */
const SPRINT_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint'

/**
 * Which of a site's fields holds sprints.
 *
 * Resolved by **schema key first, name second**, which is the opposite emphasis
 * from `storyPointFieldId` and for a good reason: Jira Software stamps every
 * sprint field with `com.pyxis.greenhopper.jira:gh-sprint` regardless of what
 * the site calls it, so there is one exact answer available here that the story
 * point lookup simply does not have. A site that has been renamed to "Iteration"
 * still matches; a text field somebody called "Sprint" does not.
 *
 * The name match is a fallback for a payload that omits `schema` — some Jira
 * deployments return the field list without it — and is deliberately narrow: an
 * exact `sprint`, not a prefix. `Sprint Goal` is a different field and putting
 * its text in this column would be a confident wrong answer.
 *
 * `null` when nothing matches, which is a real answer: a site with no Jira
 * Software project has no sprints at all.
 */
export function sprintFieldId(fields: unknown): string | null {
  if (!Array.isArray(fields)) return null

  const named = (fields as JiraFieldDescriptor[]).filter((f) => typeof f?.id === 'string')

  const bySchema = named.find((f) => f.schema?.custom === SPRINT_SCHEMA)?.id
  if (bySchema !== undefined) return bySchema

  return (
    named.find(
      (f) =>
        f.custom !== false &&
        f.schema?.custom === undefined &&
        (f.name ?? '').trim().toLowerCase() === 'sprint',
    )?.id ?? null
  )
}

/**
 * The one sprint a ticket is *in*, out of everything its sprint field carries.
 *
 * The field is an array and a carried-over ticket keeps its old sprints on it —
 * a ticket in its third sprint has three entries, two of them closed. Rendering
 * the first would show a sprint that ended a month ago; rendering all of them
 * would not fit a column and would not answer the question either. So: the
 * **active** sprint if there is one, else the nearest **future** one, else the
 * most recent **closed** one. Within a rank the last entry wins, because Jira
 * returns them oldest first.
 *
 * Two payload shapes are accepted, because two are sent. Jira Cloud's v3 search
 * returns objects; older deployments return the Java `toString` of the sprint
 * object — `...Sprint@1[id=7,name=Sprint 12,state=CLOSED,...]` — and a site
 * answering that would otherwise put the whole class name in the column.
 *
 * A ticket in no sprint has `null` or `[]` here, and that is `null`: not in a
 * sprint is a fact, and "Backlog" would be a word this code invented.
 */
export function currentSprint(value: unknown): string | null {
  const entries = (Array.isArray(value) ? value : [value]).flatMap((entry) => {
    const parsed = toSprint(entry)
    return parsed === null ? [] : [parsed]
  })

  if (entries.length === 0) return null

  const rank = (state: string): number => {
    switch (state) {
      case 'active':
        return 0
      case 'future':
        return 1
      case 'closed':
        return 3
      // A state this code does not recognise sits between future and closed:
      // worth showing over something known to be over, not over something known
      // to be running.
      default:
        return 2
    }
  }

  let best: { name: string; state: string } | null = null
  for (const entry of entries) {
    // `<=` rather than `<`, so the last entry of the winning rank is the one
    // kept -- the newest closed sprint rather than the oldest.
    if (best === null || rank(entry.state) <= rank(best.state)) best = entry
  }

  return best === null ? null : best.name
}

/** One sprint entry, in either of the two shapes Jira sends, or nothing. */
function toSprint(entry: unknown): { name: string; state: string } | null {
  if (typeof entry === 'string') {
    // `name` can itself contain a comma, so the value runs to the next `key=`
    // or to the closing bracket rather than to the next comma.
    const name = /[[,]name=(.*?)(?:,\w+=|\]$)/.exec(entry)?.[1]
    const state = /[[,]state=(\w+)/.exec(entry)?.[1]
    return name === undefined || name.trim() === ''
      ? null
      : { name: name.trim(), state: (state ?? '').toLowerCase() }
  }

  if (typeof entry === 'object' && entry !== null) {
    const record = entry as { name?: unknown; state?: unknown }
    if (typeof record.name !== 'string' || record.name.trim() === '') return null
    return {
      name: record.name.trim(),
      state: typeof record.state === 'string' ? record.state.toLowerCase() : '',
    }
  }

  return null
}

/** A present, non-blank string, or null. `''` from a provider is not a value. */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
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
