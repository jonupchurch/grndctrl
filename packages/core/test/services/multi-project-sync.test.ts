import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TicketProvider } from '../../src/providers/seam.js'
import { runSync } from '../../src/services/sync.js'
import { mirrorRepository, type MirrorRepository } from '../../src/store/mirror/repository.js'
import { openMirror } from '../../src/store/open.js'
import { project, settings, ticket, NOW } from '../correlation/builders.js'

/**
 * Several projects, one connection.
 *
 * Every `replaceX` on the mirror deletes by **connection id**, but the sync used
 * to fetch per **project** — so a second project on the same connection deleted
 * the first one's rows and then reported `ok: true` for both. The board lost two
 * thirds of its tickets and said everything was fresh.
 *
 * It survived 391 tests because every fixture bound exactly one project to one
 * connection. That is the shape this file exists to stop being true: the unit of
 * fetching and the unit of writing have to agree, and nothing else here checks
 * that they do.
 *
 * **006 removed the GitHub and checkout halves of this file**, which held the
 * same rule against `replaceRepository` and `replaceWorkspaces`. The rule itself
 * is unchanged and is about to matter again: 007 adds a second ticket query on
 * the same connection — 007 planned a second one — and `replaceTickets` still
 * deletes by connection, so those two result sets have to go in as one write or
 * the second discards the first. This file is where that will be caught.
 */

let dir: string
let db: Database
let mirror: MirrorRepository

const ALPHA = project({ id: 'p-alpha', code: 'ALPHA', jiraProjectKey: 'ALPHA' })

const BETA = project({ id: 'p-beta', code: 'BETA', jiraProjectKey: 'BETA' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-multi-'))
  db = openMirror({ dir }).db
  mirror = mirrorRepository(db)

  mirror.upsertConnection({
    id: 'jira-1',
    kind: 'jira',
    siteOrHost: 'acme.atlassian.net',
    accountLabel: 'work',
    viewerIdentity: null,
    credentialRef: 'grndctrl/jira-1',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('two projects on one Jira connection', () => {
  it('keeps both projects’ tickets, and asks for them in one query', async () => {
    const queries: string[] = []

    const tickets: TicketProvider = {
      viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
      searchIssues: async ({ jql }) => {
        queries.push(jql)
        // Answer as the real endpoint would: everything the filter names.
        return {
          tickets: [ticket({ issueKey: 'ALPHA-1' }), ticket({ issueKey: 'BETA-1' })],
          nextPageToken: null,
        }
      },
      fetchChangelogs: async () => [],
    }

    await runSync({
      mirror,
      targets: {
        projects: [ALPHA, BETA],
        ticketProviders: new Map([['jira-1', tickets]]),
      },
      settings: settings(),
      now: () => NOW,
    })

    // One query, not one per project: the write below replaces the whole
    // connection, so anything fetched separately would be deleted by the next.
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('"ALPHA"')
    expect(queries[0]).toContain('"BETA"')

    const stored = mirror.listTickets().map((t) => t.issueKey).sort()
    expect(stored).toEqual(['ALPHA-1', 'BETA-1'])
  })

  it('scopes the recency arm to the bound projects', async () => {
    let jql = ''
    const tickets: TicketProvider = {
      viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
      searchIssues: async (options) => {
        jql = options.jql
        return { tickets: [], nextPageToken: null }
      },
      fetchChangelogs: async () => [],
    }

    await runSync({
      mirror,
      targets: {
        projects: [ALPHA, BETA],
        ticketProviders: new Map([['jira-1', tickets]]),
      },
      settings: settings(),
      now: () => NOW,
    })

    // JQL binds AND tighter than OR. Unparenthesised, the `updated >= -30d` arm
    // escapes the project and assignee filters and returns every recently
    // touched issue on the site — including projects the operator never bound,
    // and may not be able to see. The board would fill with a stranger's work.
    expect(jql).toMatch(/AND \(statusCategory != Done OR updated >= -30d\)/)
  })

  it('asks only for the operator’s own tickets', async () => {
    let jql = ''
    const tickets: TicketProvider = {
      viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
      searchIssues: async (options) => {
        jql = options.jql
        return { tickets: [], nextPageToken: null }
      },
      fetchChangelogs: async () => [],
    }

    await runSync({
      mirror,
      targets: {
        projects: [ALPHA, BETA],
        ticketProviders: new Map([['jira-1', tickets]]),
      },
      settings: settings(),
      now: () => NOW,
    })

    // Without this the query returns every open ticket in every bound project.
    // On real projects that is a few hundred rows of untouched backlog,
    // which the ball-in-court fallback then claims for the operator because
    // nobody else is holding them either.
    expect(jql).toContain('assignee = currentUser()')
  })
})

describe('who the operator is', () => {
  const viewerOf = (accountId: string): TicketProvider => ({
    viewer: async () => ({ accountId, displayName: 'Jon', email: null }),
    searchIssues: async () => ({ tickets: [], nextPageToken: null }),
    fetchChangelogs: async () => [],
  })

  const syncWith = (provider: TicketProvider) =>
    runSync({
      mirror,
      targets: {
        projects: [ALPHA],
        ticketProviders: new Map([['jira-1', provider]]),
      },
      settings: settings(),
      now: () => NOW,
    })

  const identityOf = (id: string) =>
    mirror.listConnections().find((c) => c.id === id)?.viewerIdentity

  it('resolves and stores it, because nothing else does', async () => {
    // The connection is written with a null identity at import time. Left that
    // way, `operatorAccountIds` is empty and every ball-in-court rule that asks
    // "is this mine?" answers no — silently, with no failure anywhere.
    expect(identityOf('jira-1')).toBeNull()

    await syncWith(viewerOf('acct-jon'))

    expect(identityOf('jira-1')?.accountId).toBe('acct-jon')
  })

  it('follows the credential when the token is swapped for another account', async () => {
    await syncWith(viewerOf('acct-jon'))
    await syncWith(viewerOf('acct-someone-else'))

    // A cached identity would keep answering for the account that left, so
    // "mine" would quietly mean a person who no longer holds the credential.
    expect(identityOf('jira-1')?.accountId).toBe('acct-someone-else')
  })

  it('does not fail the sync when identity cannot be resolved', async () => {
    const noViewer: TicketProvider = {
      viewer: async () => {
        throw new Error('nope')
      },
      searchIssues: async () => ({ tickets: [ticket({ issueKey: 'ALPHA-1' })], nextPageToken: null }),
      fetchChangelogs: async () => [],
    }

    const report = await syncWith(noViewer)

    // The tickets are still worth having. Whatever is actually wrong with the
    // credential will fail the fetch and be reported against that resource.
    expect(report.results.find((r) => r.resourceKind === 'tickets')?.ok).toBe(true)
    expect(mirror.listTickets()).toHaveLength(1)
  })
})

describe('ticket pages', () => {
  /** A provider with `pages` pages of one ticket each. */
  const paged = (pages: number, endless = false): { provider: TicketProvider; tokens: (string | undefined)[] } => {
    const tokens: (string | undefined)[] = []
    let served = 0

    return {
      tokens,
      provider: {
        viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
        searchIssues: async ({ pageToken }) => {
          tokens.push(pageToken)
          served += 1
          return {
            tickets: [ticket({ issueKey: `ALPHA-${served}` })],
            nextPageToken: endless || served < pages ? `p${served}` : null,
          }
        },
        fetchChangelogs: async () => [],
      },
    }
  }

  const syncWith = (provider: TicketProvider) =>
    runSync({
      mirror,
      targets: {
        projects: [ALPHA],
        ticketProviders: new Map([['jira-1', provider]]),
      },
      settings: settings(),
      now: () => NOW,
    })

  it('follows the token until there are no more pages', async () => {
    const { provider, tokens } = paged(3)

    const report = await syncWith(provider)

    // First call carries no token; each later one carries the previous reply's.
    expect(tokens).toEqual([undefined, 'p1', 'p2'])
    expect(mirror.listTickets()).toHaveLength(3)
    expect(report.results.find((r) => r.resourceKind === 'tickets')?.count).toBe(3)
  })

  it('stops at a ceiling and reports that it did', async () => {
    const { provider } = paged(0, true)

    const report = await syncWith(provider)

    const failed = report.results.filter((r) => r.resourceKind === 'tickets' && !r.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.detail).toMatch(/incomplete/)

    // The tickets it did get are still written. Stopping early is a reason to
    // say so, not a reason to show an empty board.
    expect(mirror.listTickets().length).toBeGreaterThan(0)
  })
})

/*
 * Three describes ended this file and all three went with their providers.
 *
 * "two projects on one GitHub connection" held the same delete-by-connection
 * rule against `replaceRepository`, including the case where one repository
 * failing must not delete the other's rows. "checkouts shared between projects"
 * checked each distinct path was read once. "a refresh scoped to one connection"
 * checked that refreshing Jira did not re-read every checkout on disk and stamp
 * the branches lane as freshly synced — work the operator did not ask for, and
 * a freshness claim about a question they did not ask.
 *
 * The scoping behaviour they tested (`--connection`, and `wanted()` inside
 * `runSync`) is still there and still applies to the one provider left. It is
 * not re-asserted here because with a single resource kind there is nothing for
 * a scoped refresh to leave alone, which is precisely what those tests were
 * about. If a second thing to refresh ever arrives, this is the gap to fill.
 */
