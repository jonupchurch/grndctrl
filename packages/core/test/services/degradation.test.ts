import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { providerUnavailable, rateLimited, unauthorized } from '../../src/registry/errors.js'
import type { CodeProvider, LocalGitProvider, TicketProvider } from '../../src/providers/seam.js'
import { runSync } from '../../src/services/sync.js'
import { mirrorRepository, type MirrorRepository } from '../../src/store/mirror/repository.js'
import { openMirror } from '../../src/store/open.js'
import { freshnessView } from '../../src/registry/envelope.js'
import {
  branch,
  check,
  project,
  pullRequest,
  settings,
  ticket,
  workspace,
  NOW,
} from '../correlation/builders.js'

/**
 * Constitution XV: a failing provider must not degrade any other provider's
 * data.
 *
 * This is the gate that decides whether the tool survives its first bad
 * morning. A developer's tools are most needed exactly when something is
 * broken, and an app that blanks itself because one of five connections failed
 * has chosen a purity that serves nobody — the failure mode is silent, because
 * the lanes just look empty, which reads as "no work" rather than "no data".
 */

let dir: string
let db: Database
let mirror: MirrorRepository

const okTickets: TicketProvider = {
  viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
  searchIssues: async () => ({ tickets: [ticket()], nextPageToken: null }),
  fetchChangelogs: async () => [],
}

const okCode: CodeProvider = {
  viewer: async () => ({ accountId: 'me', displayName: 'Jon', email: null }),
  fetchRepository: async () => ({
    pullRequests: [pullRequest()],
    branches: [branch()],
    checks: [check()],
  }),
  compareBranches: async () => [],
  probe: async () => ({ ok: true, viewer: null, checks: [] }),
}

const okGit: LocalGitProvider = { readWorkspaces: async () => [workspace()] }

const failing = <T>(error: unknown): T =>
  new Proxy({} as object, {
    get: () => async () => {
      throw error
    },
  }) as T

function targets(over: {
  tickets?: TicketProvider
  code?: CodeProvider
  git?: LocalGitProvider
} = {}) {
  return {
    projects: [project()],
    ticketProviders: new Map([['jira-1', over.tickets ?? okTickets]]),
    codeProviders: new Map([['gh-1', over.code ?? okCode]]),
    git: over.git ?? okGit,
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
    id: 'gh-1',
    kind: 'github',
    siteOrHost: 'github.com',
    accountLabel: 'work',
    viewerIdentity: null,
    credentialRef: 'grndctrl/gh-1',
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
  it('populates every lane', async () => {
    const report = await sync()

    expect(report.results.every((r) => r.ok)).toBe(true)
    expect(mirror.listTickets()).toHaveLength(1)
    expect(mirror.listPullRequests()).toHaveLength(1)
    expect(mirror.listWorkspaces()).toHaveLength(1)
  })
})

describe('when one provider fails', () => {
  it('keeps GitHub and local data when Jira is unreachable', async () => {
    await sync() // establish good data first
    await sync({ tickets: failing<TicketProvider>(providerUnavailable('Jira is down', 'jira-1')) })

    // The lane the failure belongs to keeps its last known data...
    expect(mirror.listTickets()).toHaveLength(1)
    // ...and every other lane is untouched.
    expect(mirror.listPullRequests()).toHaveLength(1)
    expect(mirror.listWorkspaces()).toHaveLength(1)

    const ticketFreshness = mirror.listFreshness().find((f) => f.resourceKind === 'tickets')
    expect(ticketFreshness?.failureReason).toBe('network')
  })

  it('keeps Jira and local data when GitHub is unreachable', async () => {
    await sync()
    await sync({ code: failing<CodeProvider>(providerUnavailable('GitHub is down', 'gh-1')) })

    expect(mirror.listTickets()).toHaveLength(1)
    expect(mirror.listPullRequests()).toHaveLength(1)

    const kinds = mirror
      .listFreshness()
      .filter((f) => f.failureReason !== null)
      .map((f) => f.resourceKind)
      .sort()

    // Every GitHub-fed resource is marked, and nothing else is.
    expect(kinds).toEqual(['branches', 'checks', 'pulls'])
  })

  it('keeps provider data when a local checkout has moved', async () => {
    await sync()
    await sync({
      git: {
        readWorkspaces: async () => {
          throw new Error('ENOENT: D:\\work\\mercury')
        },
      },
    })

    expect(mirror.listTickets()).toHaveLength(1)
    expect(mirror.listPullRequests()).toHaveLength(1)

    const local = mirror.listFreshness().find((f) => f.resourceKind === 'local')
    expect(local?.failureReason).toBe('notFound')
  })

  it('keeps the branches it knew about when the checkout cannot be read', async () => {
    await sync()
    expect(mirror.listWorkspaces()).toHaveLength(1)

    await sync({
      git: {
        readWorkspaces: async () => {
          throw new Error('ENOENT: E:\\work\\mercury')
        },
      },
    })

    // An unmounted drive, a network share, a VPN that dropped: the branches are
    // still there and this process could not look. Writing the partial set —
    // which `replaceWorkspaces` applies with no scope — deleted them, and the
    // lane then showed an empty list *while saying it failed to refresh*. To
    // anyone not stopping to reconcile the two, that reads as "you have no
    // branches". The same rule the GitHub fetch already follows.
    expect(mirror.listWorkspaces()).toHaveLength(1)
    expect(mirror.listFreshness().find((f) => f.resourceKind === 'local')?.failureReason).toBe(
      'notFound',
    )
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
        // No provider for Jira, exactly as `buildSyncTargets` leaves it when
        // the keychain has no secret under this connection's reference.
        ticketProviders: new Map(),
        unavailable: [{ connectionId: 'jira-1', reason: 'no-credential' }],
      },
      settings: settings(),
      now: clock,
    })

    const tickets = report.results.filter((r) => r.resourceKind === 'tickets')
    expect(tickets).toHaveLength(1)
    expect(tickets[0]?.ok).toBe(false)
    expect(tickets[0]?.failureReason).toBe('auth')
    expect(tickets[0]?.detail).toContain('No credential is stored')

    // The lane says so, through the same freshness path every other failure
    // uses — so `LaneStatus` needs to know nothing new to render it.
    expect(mirror.listFreshness().find((f) => f.resourceKind === 'tickets')?.failureReason).toBe(
      'auth',
    )
    // And the data it last fetched is still there. XV: the lane degrades, it
    // does not blank.
    expect(mirror.listTickets()).toHaveLength(1)
    expect(mirror.listPullRequests()).toHaveLength(1)
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

    const detail = report.results.find((r) => r.resourceKind === 'tickets')?.detail ?? ''
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
        projects: [{ ...project(), jiraProjectKey: null }],
        ticketProviders: new Map(),
        codeProviders: new Map([['gh-1', okCode]]),
        git: okGit,
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
    await sync({ tickets: failing<TicketProvider>(unauthorized('token rejected', 'jira-1')) })
    expect(mirror.listFreshness().find((f) => f.resourceKind === 'tickets')?.failureReason).toBe('auth')
  })

  // Rate limiting is the one failure the user should wait out rather than act
  // on, so it carries a retry time (FR-015).
  it('records a retry time for a rate limit', async () => {
    await sync({ tickets: failing<TicketProvider>(rateLimited('slow down', 240, 'jira-1')) })

    const record = mirror.listFreshness().find((f) => f.resourceKind === 'tickets')
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
        tickets: {
          viewer: okTickets.viewer,
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

    expect(mirror.listTickets()).toHaveLength(1)
    expect(mirror.listTickets()[0]?.lastRealActivityAt).toBeNull()

    const degraded = report.results.find((r) => !r.ok && r.resourceKind === 'tickets')
    expect(degraded?.detail).toMatch(/activity is unknown/)
  })
})

/**
 * Constitution XV again, at the correlation layer: a work item whose ticket
 * cannot be fetched still shows its branches, PRs, and notes, marked partially
 * resolved rather than hidden.
 */
describe('correlation degrades rather than hides', () => {
  it('still renders work when the ticket lane failed', () => {
    const { workItems } = correlate({
      projects: [project()],
      tickets: [],
      pullRequests: [pullRequest()],
      checks: [],
      branches: [],
      comparisons: [],
      workspaces: [workspace()],
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
    await sync({ tickets: failing<TicketProvider>(unauthorized('nope', 'jira-1')) })

    const record = mirror.listFreshness().find((f) => f.resourceKind === 'tickets')
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
    await sync({ tickets: failing<TicketProvider>(unauthorized('nope', 'jira-1')) })
    await sync()

    const record = mirror.listFreshness().find((f) => f.resourceKind === 'tickets')
    const view = freshnessView(record, clock().getTime(), 300)

    // The failure is still on record -- a lane that failed twice this hour is a
    // different situation from one that never has -- but the state is fresh,
    // because the most recent attempt succeeded.
    expect(view.state).toBe('fresh')
    expect(view.lastFailureAt).not.toBeNull()
  })
})
