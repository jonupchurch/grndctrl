import { describe, expect, it } from 'vitest'
import {
  applyActivity,
  classifyAuthor,
  jiraProvider,
  toStatusCategory,
} from '../../src/providers/jira/index.js'
import type { Fetcher } from '../../src/providers/http.js'
import { isOperationError } from '../../src/registry/errors.js'
import { hoursAgo, ticket } from '../correlation/builders.js'

const NOW = new Date('2026-08-14T12:00:00Z')

/** Records requests and replays canned JSON, so no test needs a live Jira. */
function recorded(routes: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  const calls: { url: string; body: unknown }[] = []

  const fetcher: Fetcher = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })

    return new Response(JSON.stringify(routes[path] ?? {}), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }

  return { fetcher, calls }
}

const provider = (routes: Record<string, unknown>, extra: Parameters<typeof recorded>[1] = 200) => {
  const { fetcher, calls } = recorded(routes, extra)
  return {
    calls,
    jira: jiraProvider({
      site: 'acme.atlassian.net',
      email: 'jon@example.com',
      apiToken: 'token',
      connectionId: 'jira-1',
      fetcher,
      now: () => NOW,
    }),
  }
}

describe('searching issues', () => {
  const searchResponse = {
    issues: [
      {
        id: '10001',
        key: 'MERC-1184',
        fields: {
          summary: 'Reconcile worktree state',
          status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
          assignee: { accountId: 'me', displayName: 'Jon', emailAddress: 'jon@example.com' },
          created: hoursAgo(200),
          updated: hoursAgo(1),
        },
      },
    ],
    nextPageToken: 'page-2',
  }

  it('maps an issue onto a ticket with a natural key', async () => {
    const { jira } = provider({ '/rest/api/3/search/jql': searchResponse })
    const { tickets } = await jira.searchIssues({ jql: 'project = MERC' })

    expect(tickets[0]).toMatchObject({
      key: 'jira:acme.atlassian.net/MERC-1184',
      issueKey: 'MERC-1184',
      statusName: 'In Review',
      statusCategory: 'indeterminate',
      url: 'https://acme.atlassian.net/browse/MERC-1184',
    })
  })

  // The endpoint reports no count, so the number of tickets is the number
  // fetched. Anything that implies a server-side total would be invented.
  it('paginates on nextPageToken and reports no total', async () => {
    const { jira } = provider({ '/rest/api/3/search/jql': searchResponse })
    const page = await jira.searchIssues({ jql: 'project = MERC' })

    expect(page.nextPageToken).toBe('page-2')
    expect(page).not.toHaveProperty('total')
  })

  it('reports the last page as having no next token', async () => {
    const { jira } = provider({
      '/rest/api/3/search/jql': { ...searchResponse, isLast: true },
    })
    expect((await jira.searchIssues({ jql: 'x' })).nextPageToken).toBeNull()
  })

  // Never backfilled from `updated` -- that is the field FR-027 exists to
  // distrust, and substituting it would turn "history not fetched" into a
  // confident wrong answer.
  it('leaves activity unknown until the changelog is fetched', async () => {
    const { jira } = provider({ '/rest/api/3/search/jql': searchResponse })
    const { tickets } = await jira.searchIssues({ jql: 'x' })

    expect(tickets[0]?.lastRealActivityAt).toBeNull()
    expect(tickets[0]?.lastStatusChangeAt).toBeNull()
    expect(tickets[0]?.updatedAt).toBe(hoursAgo(1))
  })

  it('uses the enhanced search endpoint, not the removed one', async () => {
    const { jira, calls } = provider({ '/rest/api/3/search/jql': searchResponse })
    await jira.searchIssues({ jql: 'project = MERC' })

    expect(calls[0]?.url).toContain('/rest/api/3/search/jql')
    expect(calls[0]?.url).not.toMatch(/\/rest\/api\/3\/search$/)
  })

  it('survives an issue with missing fields rather than throwing', async () => {
    const { jira } = provider({ '/rest/api/3/search/jql': { issues: [{ id: '1', key: 'MERC-1' }] } })
    const { tickets } = await jira.searchIssues({ jql: 'x' })

    expect(tickets[0]?.summary).toBe('')
    expect(tickets[0]?.statusCategory).toBe('indeterminate')
  })
})

describe('fetching changelogs', () => {
  it('uses the bulk endpoint rather than one call per issue', async () => {
    const { jira, calls } = provider({ '/rest/api/3/changelog/bulkfetch': { issueChangeLogs: [] } })
    await jira.fetchChangelogs(['MERC-1', 'MERC-2', 'MERC-3'])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/rest/api/3/changelog/bulkfetch')
    expect(calls[0]?.body).toMatchObject({ issueIdsOrKeys: ['MERC-1', 'MERC-2', 'MERC-3'] })
  })

  it('makes no request at all for an empty key list', async () => {
    const { jira, calls } = provider({})
    expect(await jira.fetchChangelogs([])).toEqual([])
    expect(calls).toEqual([])
  })

  it('marks human status changes as real and bot edits as not', async () => {
    const { jira } = provider({
      '/rest/api/3/changelog/bulkfetch': {
        issueChangeLogs: [
          {
            issueId: 'MERC-1184',
            changeHistories: [
              {
                created: hoursAgo(5),
                author: { accountId: 'me', displayName: 'Jon' },
                items: [{ field: 'status' }],
              },
              {
                created: hoursAgo(1),
                author: { accountId: 'bot', displayName: 'Automation for Jira', accountType: 'app' },
                items: [{ field: 'labels' }],
              },
            ],
          },
        ],
      },
    })

    const activity = await jira.fetchChangelogs(['MERC-1184'])

    expect(activity).toHaveLength(2)
    expect(activity[0]).toMatchObject({ field: 'status', authorKind: 'human', countsAsReal: true })
    expect(activity[1]).toMatchObject({ authorKind: 'automation', countsAsReal: false })
  })
})

describe('applying activity to tickets', () => {
  it('sets last real activity and last status change separately', () => {
    const t = ticket({ issueKey: 'MERC-1184' })
    const [applied] = applyActivity(
      [t],
      [
        { ticketKey: t.key, at: hoursAgo(20), authorKind: 'human', field: 'status', countsAsReal: true },
        { ticketKey: t.key, at: hoursAgo(3), authorKind: 'human', field: 'comment', countsAsReal: true },
      ],
    )

    // A comment is activity but not a transition. D7 asks specifically whether
    // the ticket moved, so the two cannot be the same number.
    expect(applied?.lastRealActivityAt).toBe(hoursAgo(3))
    expect(applied?.lastStatusChangeAt).toBe(hoursAgo(20))
  })

  it('leaves both null when nothing counts', () => {
    const t = ticket()
    const [applied] = applyActivity(
      [t],
      [{ ticketKey: t.key, at: hoursAgo(1), authorKind: 'bot', field: 'labels', countsAsReal: false }],
    )

    expect(applied?.lastRealActivityAt).toBeNull()
    expect(applied?.lastStatusChangeAt).toBeNull()
  })
})

describe('status categories', () => {
  // Never the name. A team that renames "Done" to "Shipped" must not break D1.
  it('reads the category, not the status name', () => {
    expect(toStatusCategory('done')).toBe('done')
    expect(toStatusCategory('new')).toBe('new')
    expect(toStatusCategory('indeterminate')).toBe('indeterminate')
  })

  // Calling something done when it is not is the error that closes live work.
  it('treats an unknown category as in progress, never as done', () => {
    expect(toStatusCategory(undefined)).toBe('indeterminate')
    expect(toStatusCategory('something-new-from-atlassian')).toBe('indeterminate')
  })
})

describe('classifying authors', () => {
  it('recognises app accounts and common bot names', () => {
    expect(classifyAuthor({ accountId: 'a', accountType: 'app' })).toBe('automation')
    expect(classifyAuthor({ accountId: 'b', displayName: 'Dependabot' })).toBe('bot')
    expect(classifyAuthor({ accountId: 'c', displayName: 'GitHub' })).toBe('bot')
    expect(classifyAuthor({ accountId: 'd', displayName: 'Jon Upchurch' })).toBe('human')
  })

  // Mis-classifying a bot as human resets a staleness clock that should have
  // kept running, so the ambiguous case errs toward automation.
  it('treats a missing author as automation', () => {
    expect(classifyAuthor(undefined)).toBe('automation')
  })
})

describe('error mapping', () => {
  it('reports a rejected credential as unauthorized, not as unavailable', async () => {
    const { jira } = provider({ '/rest/api/3/search/jql': {} }, 401)

    try {
      await jira.searchIssues({ jql: 'x' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('unauthorized')
      expect((e as Error).message).toMatch(/Re-authorize/)
    }
  })

  it('does not echo the request URL or the token in an error', async () => {
    const { jira } = provider({ '/rest/api/3/search/jql': {} }, 500)

    try {
      await jira.searchIssues({ jql: 'x' })
      expect.unreachable('should have thrown')
    } catch (e) {
      const message = (e as Error).message
      expect(message).not.toContain('token')
      expect(message).not.toContain('/rest/api/3')
      expect(message).toContain('acme.atlassian.net')
    }
  })
})

describe('paging', () => {
  it('sends a page token when given one, and omits the field entirely when not', async () => {
    const { jira, calls } = provider({ '/rest/api/3/search/jql': { issues: [], isLast: true } })

    await jira.searchIssues({ jql: 'x' })
    await jira.searchIssues({ jql: 'x', pageToken: 'abc' })

    // Absent, not null: the endpoint rejects an explicit null token rather than
    // reading it as "start at the beginning".
    expect(calls[0]?.body).not.toHaveProperty('nextPageToken')
    expect(calls[1]?.body).toMatchObject({ nextPageToken: 'abc' })
  })
})

describe('bulk changelog batching', () => {
  /** Enough keys to need three requests at the endpoint's ceiling of 100. */
  const keys = Array.from({ length: 250 }, (_, i) => `MERC-${i + 1}`)

  it('splits one call into batches the endpoint will accept', async () => {
    const { jira, calls } = provider({ '/rest/api/3/changelog/bulkfetch': { issueChangeLogs: [] } })

    await jira.fetchChangelogs(keys)

    expect(calls).toHaveLength(3)
    const sizes = calls.map((c) => (c.body as { issueIdsOrKeys: string[] }).issueIdsOrKeys.length)
    expect(sizes).toEqual([100, 100, 50])

    // Every key exactly once. A batching bug that drops or repeats a slice
    // shows up as tickets whose activity is silently missing, which reads on
    // the board as "nothing has happened here" rather than as an error.
    const sent = calls.flatMap((c) => (c.body as { issueIdsOrKeys: string[] }).issueIdsOrKeys)
    expect(sent).toEqual(keys)
  })

  it('returns the activity from every batch, not just the last', async () => {
    let batch = 0
    const fetcher: Fetcher = async (_url, init) => {
      batch += 1
      const body = JSON.parse(String(init.body)) as { issueIdsOrKeys: string[] }
      const first = body.issueIdsOrKeys[0] ?? 'MERC-0'
      return new Response(
        JSON.stringify({
          issueChangeLogs: [
            {
              issueId: first,
              changeHistories: [
                {
                  created: hoursAgo(batch),
                  author: { accountId: 'them', displayName: 'Sam' },
                  items: [{ field: 'status' }],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const jira = jiraProvider({
      site: 'acme.atlassian.net',
      email: 'jon@example.com',
      apiToken: 'token',
      connectionId: 'jira-1',
      fetcher,
      now: () => NOW,
    })

    const activity = await jira.fetchChangelogs(keys)
    expect(activity).toHaveLength(3)
  })
})
