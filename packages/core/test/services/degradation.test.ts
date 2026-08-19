import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { providerUnavailable, rateLimited, unauthorized } from '../../src/registry/errors.js'
import type { TicketProvider } from '../../src/providers/seam.js'
import { runSync } from '../../src/services/sync.js'
import { mirrorRepository, type MirrorRepository } from '../../src/store/mirror/repository.js'
import { openMirror } from '../../src/store/open.js'
import { freshnessView } from '../../src/registry/envelope.js'
import { project, settings, ticket, NOW } from '../correlation/builders.js'

/**
 * Constitution XV: a failing provider must not degrade any other provider's
 * data.
 *
 * This is the gate that decides whether the tool survives its first bad
 * morning. A developer's tools are most needed exactly when something is
 * broken, and an app that blanks itself because one of five connections failed
 * has chosen a purity that serves nobody — the failure mode is silent, because
 * the lanes just look empty, which reads as "no work" rather than "no data".
 *
 * **The demonstration changed shape with 006 and did not weaken.** It used to
 * fail one of three providers and check the other two were untouched. There is
 * one provider, so the isolation is now demonstrated across **two connections of
 * the same kind** — which is the case an operator actually has: two Jira sites,
 * or a personal account and a work one, where one token expiring must not empty
 * the other's lane.
 *
 * That is not a lesser test. The boundary being checked is the same one:
 * per connection, per resource kind, with the mirror written independently. The
 * bug it exists to prevent — one try/catch around the whole sync — would fail
 * here exactly as it failed before.
 */

let dir: string
let db: Database
let mirror: MirrorRepository

const okTickets = (issueKey: string): TicketProvider => ({
  viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
  searchIssues: async () => ({ tickets: [ticket({ issueKey })], nextPageToken: null }),
  fetchChangelogs: async () => [],
})

const failing = <T>(error: unknown): T =>
  new Proxy({} as object, {
    get: () => async () => {
      throw error
    },
  }) as T

/** Two Jira connections, each with its own project bound to it. */
const MERC = project({ id: 'p-merc', code: 'MERC', jiraProjectKey: 'MERC', jiraConnectionId: 'jira-1' })
const ATLS = project({ id: 'p-atls', code: 'ATLS', jiraProjectKey: 'ATLS', jiraConnectionId: 'jira-2' })

function targets(over: { first?: TicketProvider; second?: TicketProvider } = {}) {
  return {
    projects: [MERC, ATLS],
    ticketProviders: new Map([
      ['jira-1', over.first ?? okTickets('MERC-1184')],
      ['jira-2', over.second ?? okTickets('ATLS-7')],
    ]),
  }
}

beforeEach(() => {
  tick = 0
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-degrade-'))
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
  mirror.upsertConnection({
    id: 'jira-2',
    kind: 'jira',
    siteOrHost: 'example.atlassian.net',
    accountLabel: 'other',
    viewerIdentity: null,
    credentialRef: 'grndctrl/jira-2',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A clock that advances one second per sync.
 *
 * Not incidental: freshness compares the last success against the last failure,
 * and two syncs stamped with the identical instant are genuinely unorderable —
 * the state would then depend on a tie-break rather than on what happened. Real
 * syncs are seconds apart, so the fixture should be too.
 */
let tick = 0
const clock = () => new Date(NOW.getTime() + tick * 1000)

const sync = (over: Parameters<typeof targets>[0] = {}) => {
  tick += 1
  return runSync({ mirror, targets: targets(over), settings: settings(), now: clock })
}

describe('a healthy sync', () => {
  it('populates the lane from every connection', async () => {
    const report = await sync()

    expect(report.results.every((r) => r.ok)).toBe(true)
    expect(mirror.listTickets()).toHaveLength(2)
  })
})

describe('when one connection fails', () => {
  it('keeps the other connection’s tickets when one site is unreachable', async () => {
    await sync() // establish good data first
    await sync({ first: failing<TicketProvider>(providerUnavailable('Jira is down', 'jira-1')) })

    // The failing connection keeps its last known data...
    expect(mirror.listTickets().filter((t) => t.issueKey === 'MERC-1184')).toHaveLength(1)
    // ...and the healthy one is untouched and current.
    expect(mirror.listTickets().filter((t) => t.issueKey === 'ATLS-7')).toHaveLength(1)

    const freshness = mirror.listFreshness()
    expect(freshness.find((f) => f.connectionId === 'jira-1')?.failureReason).toBe('network')
    expect(freshness.find((f) => f.connectionId === 'jira-2')?.failureReason).toBeNull()
  })

  /**
   * The failure is recorded against the connection, not the resource kind.
   *
   * Both connections feed the same lane, so a board-wide `tickets` failure flag
   * would put the healthy site's rows behind a "failed to refresh" notice they
   * have nothing to do with. This is the assertion that keeps the freshness key
   * a *pair*.
   */
  it('marks only the connection that failed', async () => {
    await sync()
    await sync({ second: failing<TicketProvider>(unauthorized('token rejected', 'jira-2')) })

    const failed = mirror
      .listFreshness()
      .filter((f) => f.failureReason !== null)
      .map((f) => f.connectionId)

    expect(failed).toEqual(['jira-2'])
  })
})

/**
 * The credential is gone, rather than rejected (FR-006).
 *
 * This is what a revoked token looks like from inside: `buildSyncTargets` finds
 * no secret in the keychain and hands `runSync` no provider for that
 * connection. It used to be indistinguishable from "nothing is bound to this
 * connection" — both produced no results — so a refresh with the credential
 * revoked returned `ok: true`, wrote nothing, recorded nothing, and left the
 * board ageing quietly with no statement anywhere that it could not refresh.
 */
describe('when the credential itself has gone', () => {
  it('reports a refresh that could not happen, rather than a refresh that did', async () => {
    await sync() // good data first, so there is something to keep

    const report = await runSync({
      mirror,
      targets: {
        ...targets(),
        // No provider for the first connection, exactly as `buildSyncTargets`
        // leaves it when the keychain has no secret under its reference.
        ticketProviders: new Map([['jira-2', okTickets('ATLS-7')]]),
        unavailable: [{ connectionId: 'jira-1', reason: 'no-credential' }],
      },
      settings: settings(),
      now: clock,
    })

    const first = report.results.filter((r) => r.connectionId === 'jira-1')
    expect(first).toHaveLength(1)
    expect(first[0]?.ok).toBe(false)
    expect(first[0]?.failureReason).toBe('auth')
    expect(first[0]?.detail).toContain('No credential is stored')

    // The lane says so, through the same freshness path every other failure
    // uses — so `LaneStatus` needs to know nothing new to render it.
    expect(mirror.listFreshness().find((f) => f.connectionId === 'jira-1')?.failureReason).toBe(
      'auth',
    )
    // And the data it last fetched is still there. XV: the lane degrades, it
    // does not blank — including the half of it that came from the other site.
    expect(mirror.listTickets()).toHaveLength(2)
  })

  it('says the keychain is unreachable rather than blaming the token', async () => {
    // A different remedy: signing in again cannot help if the credential store
    // is not running, and FR-006 requires saying so specifically — and saying
    // that nothing is stored anywhere else instead.
    const report = await runSync({
      mirror,
      targets: {
        ...targets(),
        ticketProviders: new Map(),
        unavailable: [{ connectionId: 'jira-1', reason: 'keychain-unavailable' }],
      },
      settings: settings(),
      now: clock,
    })

    const detail = report.results.find((r) => r.connectionId === 'jira-1')?.detail ?? ''
    expect(detail).toContain('credential store could not be reached')
    expect(detail).toContain('will not fall back')
  })

  it('stays silent about a connection with nothing bound to it', async () => {
    // The other half, and the reason this cannot simply report every absent
    // provider: a connection with no ticket project on it is an ordinary
    // configuration, and a red lane on a correctly configured board teaches
    // people to ignore red lanes.
    const report = await runSync({
      mirror,
      targets: {
        projects: [{ ...MERC, jiraProjectKey: null }],
        ticketProviders: new Map(),
        unavailable: [{ connectionId: 'jira-1', reason: 'no-credential' }],
      },
      settings: settings(),
      now: clock,
    })

    expect(report.results.filter((r) => r.resourceKind === 'tickets')).toEqual([])
  })
})

describe('failure reasons are distinguished', () => {
  it('reports an expired token as auth, not as a network problem', async () => {
    await sync({ first: failing<TicketProvider>(unauthorized('token rejected', 'jira-1')) })
    expect(mirror.listFreshness().find((f) => f.connectionId === 'jira-1')?.failureReason).toBe('auth')
  })

  // Rate limiting is the one failure the user should wait out rather than act
  // on, so it carries a retry time (FR-015).
  it('records a retry time for a rate limit', async () => {
    await sync({ first: failing<TicketProvider>(rateLimited('slow down', 240, 'jira-1')) })

    const record = mirror.listFreshness().find((f) => f.connectionId === 'jira-1')
    expect(record?.failureReason).toBe('rateLimit')
    expect(record?.nextAttemptAt).toBe(new Date(clock().getTime() + 240_000).toISOString())
  })
})

/**
 * Research R2: history is a separate call and can fail on its own. When it
 * does, activity is unknown — and it must stay unknown rather than falling back
 * to `updated`, which is the field FR-027 exists to distrust.
 */
describe('when ticket history fails but the search succeeds', () => {
  it('keeps the tickets and reports activity as unknown', async () => {
    const report = await runSync({
      mirror,
      targets: targets({
        first: {
          viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
          searchIssues: async () => ({
            tickets: [ticket({ lastRealActivityAt: null, lastStatusChangeAt: null })],
            nextPageToken: null,
          }),
          fetchChangelogs: async () => {
            throw providerUnavailable('changelog bulkfetch failed', 'jira-1')
          },
        },
      }),
      settings: settings(),
      now: clock,
    })

    expect(mirror.listTickets().find((t) => t.issueKey === 'MERC-1184')?.lastRealActivityAt).toBeNull()

    const degraded = report.results.find((r) => !r.ok && r.connectionId === 'jira-1')
    expect(degraded?.detail).toMatch(/activity is unknown/)
  })
})

/**
 * Constitution XV again, at the correlation layer.
 *
 * This used to say a work item whose *ticket* could not be fetched still shows
 * its branches, pull requests and notes. There is nothing left to show without a
 * ticket, so what it says now is narrower and still worth saying: the cached
 * rows render, and they are marked as possibly behind rather than presented as
 * current.
 */
describe('correlation degrades rather than hides', () => {
  it('still renders cached tickets when the ticket lane failed', () => {
    const { workItems } = correlate({
      projects: [MERC],
      tickets: [ticket()],
      sessions: [],
      noteCounts: {},
      openQuestionSubjects: [],
      operatorAccountIds: ['me'],
      failedResourceKinds: ['tickets'],
      settings: settings(),
      now: NOW,
    })

    expect(workItems).toHaveLength(1)
    expect(workItems[0]?.resolution).toBe('partial')
  })
})

/** Constitution XIV: stale, failed, and never-synced are three distinct states. */
describe('freshness stays legible through a failure', () => {
  it('reports failed rather than stale when the last attempt errored', async () => {
    await sync()
    await sync({ first: failing<TicketProvider>(unauthorized('nope', 'jira-1')) })

    const record = mirror.listFreshness().find((f) => f.connectionId === 'jira-1')
    const view = freshnessView(record, clock().getTime() + 60_000, 300)

    expect(view.state).toBe('failed')
    // The last good data is still dated. "Failed to refresh" is not "no data".
    expect(view.lastSuccessAt).not.toBeNull()
    expect(view.failureReason).toBe('auth')
  })

  it('reports never for a lane that has not synced at all', () => {
    const view = freshnessView(undefined, NOW.getTime(), 300)
    expect(view.state).toBe('never')
    expect(view.ageSec).toBeNull()
  })

  it('does not resurrect a cleared failure on the next success', async () => {
    await sync({ first: failing<TicketProvider>(unauthorized('nope', 'jira-1')) })
    await sync()

    const record = mirror.listFreshness().find((f) => f.connectionId === 'jira-1')
    const view = freshnessView(record, clock().getTime(), 300)

    // The failure is still on record -- a lane that failed twice this hour is a
    // different situation from one that never has -- but the state is fresh,
    // because the most recent attempt succeeded.
    expect(view.state).toBe('fresh')
    expect(view.lastFailureAt).not.toBeNull()
  })
})
