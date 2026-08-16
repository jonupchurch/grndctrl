import { describe, expect, it } from 'vitest'
import { githubProvider } from '../../src/providers/github/index.js'
import { branchesNeedingComparison, buildComparisonQuery } from '../../src/providers/github/query.js'
import type { Fetcher } from '../../src/providers/http.js'
import { isOperationError } from '../../src/registry/errors.js'
import { branchKey } from '../../src/domain/keys.js'

const NOW = new Date('2026-08-14T12:00:00Z')
const REMOTE = 'github.com/acme/mercury'

function gql(payloads: unknown[], headers: Record<string, string> = {}) {
  const calls: { query: string; variables: Record<string, unknown> }[] = []
  let i = 0

  const fetcher: Fetcher = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }
    calls.push(body)
    const payload = payloads[Math.min(i++, payloads.length - 1)]
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }

  return {
    calls,
    github: githubProvider({ token: 'ghp_x', connectionId: 'gh-1', fetcher, now: () => NOW }),
  }
}

const prNode = (over: Record<string, unknown> = {}) => ({
  number: 451,
  title: 'fix: reconcile worktree',
  url: 'https://github.com/acme/mercury/pull/451',
  state: 'OPEN',
  isDraft: false,
  createdAt: '2026-08-10T00:00:00Z',
  updatedAt: '2026-08-14T09:00:00Z',
  mergedAt: null,
  closedAt: null,
  author: { id: 'U_me', login: 'jon', name: 'Jon' },
  headRefName: 'feature/MERC-1184',
  headRefOid: 'a1b2c3',
  baseRefName: 'main',
  reviewDecision: 'REVIEW_REQUIRED',
  reviewRequests: { nodes: [{ requestedReviewer: { id: 'U_them', login: 'sam', name: 'Sam' } }] },
  reviewThreads: {
    nodes: [
      { isResolved: false, isOutdated: false },
      { isResolved: true, isOutdated: false },
      { isResolved: false, isOutdated: true },
    ],
  },
  reviews: { nodes: [{ submittedAt: '2026-08-13T00:00:00Z', state: 'COMMENTED' }] },
  commits: {
    nodes: [
      {
        commit: {
          oid: 'a1b2c3',
          committedDate: '2026-08-14T08:00:00Z',
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'build',
                  conclusion: 'FAILURE',
                  detailsUrl: 'https://github.com/acme/mercury/runs/1',
                  completedAt: '2026-08-14T08:30:00Z',
                },
                { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS', completedAt: null },
              ],
            },
          },
        },
      },
    ],
  },
  ...over,
})

describe('fetching a repository', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    data: {
      repository: {
        pullRequests: { nodes: [prNode()] },
        refs: {
          nodes: [{ name: 'feature/MERC-1184', target: { oid: 'a1b2c3', committedDate: '2026-08-14T08:00:00Z' } }],
        },
        ...over,
      },
    },
  })

  it('maps a pull request onto the domain type', async () => {
    const { github } = gql([payload()])
    const { pullRequests } = await github.fetchRepository({ owner: 'acme', repo: 'mercury' })

    expect(pullRequests[0]).toMatchObject({
      key: 'gh:acme/mercury#451',
      number: 451,
      headBranch: 'feature/MERC-1184',
      headSha: 'a1b2c3',
      state: 'open',
      reviewDecision: 'reviewRequired',
    })
    expect(pullRequests[0]?.requestedReviewers[0]?.accountId).toBe('U_them')
  })

  // The field GraphQL is required for. An outdated thread is not an open
  // question -- it points at code that no longer exists.
  it('counts unresolved review threads and ignores outdated ones', async () => {
    const { github } = gql([payload()])
    const { pullRequests } = await github.fetchRepository({ owner: 'acme', repo: 'mercury' })

    expect(pullRequests[0]?.unresolvedThreadCount).toBe(1)
  })

  it('takes activity from commits and reviews, not from updatedAt', async () => {
    const { github } = gql([payload()])
    const { pullRequests } = await github.fetchRepository({ owner: 'acme', repo: 'mercury' })

    // updatedAt is 09:00 and would win if it were used. The newest real event
    // is the commit at 08:00 (FR-027).
    expect(pullRequests[0]?.lastRealActivityAt).toBe('2026-08-14T08:00:00Z')
  })

  it('marks a failure as required only when the rollup is failing', async () => {
    const { github } = gql([payload()])
    const { checks } = await github.fetchRepository({ owner: 'acme', repo: 'mercury' })

    const build = checks.find((c) => c.name === 'build')
    const lint = checks.find((c) => c.name === 'lint')

    expect(build).toMatchObject({ state: 'failure', isRequired: true, sha: 'a1b2c3' })
    expect(lint).toMatchObject({ state: 'success', isRequired: false })
  })

  // A check in flight is not a broken build.
  it('treats a null conclusion as pending, not as failure', async () => {
    const running = prNode({
      commits: {
        nodes: [
          {
            commit: {
              oid: 'a1',
              committedDate: '2026-08-14T08:00:00Z',
              statusCheckRollup: {
                state: 'PENDING',
                contexts: { nodes: [{ __typename: 'CheckRun', name: 'build', conclusion: null }] },
              },
            },
          },
        ],
      },
    })

    const { github } = gql([{ data: { repository: { pullRequests: { nodes: [running] }, refs: { nodes: [] } } } }])
    const { checks } = await github.fetchRepository({ owner: 'acme', repo: 'mercury' })

    expect(checks[0]?.state).toBe('pending')
    expect(checks[0]?.isRequired).toBe(false)
  })

  it('returns empty results for a repository it cannot see, rather than throwing', async () => {
    const { github } = gql([{ data: { repository: null } }])
    expect(await github.fetchRepository({ owner: 'acme', repo: 'ghost' })).toEqual({
      pullRequests: [],
      branches: [],
      checks: [],
    })
  })
})

/**
 * Research R3: each comparison is its own field selection, so a 40-branch repo
 * on a 60-second poll would spend its entire hourly budget on ahead/behind if
 * every one were a request.
 */
describe('branch comparisons', () => {
  it('puts every comparison in one document', () => {
    const { query, aliases } = buildComparisonQuery([
      { name: 'main' },
      { name: 'feature/MERC-1184' },
      { name: 'release/2.0' },
    ])

    expect(aliases.size).toBe(3)
    expect(query.match(/compare\(/g)).toHaveLength(3)
    expect(query).toContain('$head0: String!')
    expect(query).toContain('$head2: String!')
  })

  // A GraphQL alias must be a valid name, and branch names contain slashes and
  // dots. Deriving aliases from them would produce an invalid document.
  it('uses positional aliases rather than branch names', () => {
    const { query } = buildComparisonQuery([{ name: 'feature/MERC-1184' }, { name: 'release/2.0' }])
    expect(query).toContain('c0: ref(')
    expect(query).toContain('c1: ref(')
    expect(query).not.toContain('feature/MERC-1184:')
  })

  it('issues exactly one request for many branches', async () => {
    const { github, calls } = gql([
      {
        data: {
          repository: {
            c0: { compare: { aheadBy: 2, behindBy: 0 } },
            c1: { compare: { aheadBy: 7, behindBy: 14 } },
          },
        },
      },
    ])

    const comparisons = await github.compareBranches({
      owner: 'acme',
      repo: 'mercury',
      baseRef: 'main',
      branches: [
        { name: 'feature/MERC-1184', headSha: 'a1' },
        { name: 'atls-402-limiter', headSha: 'b2' },
      ],
    })

    expect(calls).toHaveLength(1)
    expect(comparisons).toHaveLength(2)
    expect(comparisons[0]).toMatchObject({ aheadBy: 2, behindBy: 0, comparedAtSha: 'a1' })
    expect(comparisons[1]).toMatchObject({ aheadBy: 7, behindBy: 14 })
  })

  // FR-018. "No commits ahead" and "we have no idea" are different answers, and
  // only one is true for a branch the host has never seen.
  it('reports unknown as null, never as zero', async () => {
    const { github } = gql([{ data: { repository: { c0: null } } }])

    const [comparison] = await github.compareBranches({
      owner: 'acme',
      repo: 'mercury',
      baseRef: 'main',
      branches: [{ name: 'never-pushed', headSha: 'local-only' }],
    })

    expect(comparison?.aheadBy).toBeNull()
    expect(comparison?.behindBy).toBeNull()
  })

  it('makes no request for an empty branch list', async () => {
    const { github, calls } = gql([{ data: {} }])
    expect(
      await github.compareBranches({ owner: 'acme', repo: 'mercury', baseRef: 'main', branches: [] }),
    ).toEqual([])
    expect(calls).toEqual([])
  })

  // The other half of the budget story: on a repo where most branches sit still
  // between polls, skipping unchanged heads is what keeps the poll sustainable.
  it('skips comparisons for branches whose head has not moved', () => {
    const keyOf = (name: string) => branchKey(REMOTE, name)
    const previous = [
      { branchKey: keyOf('main'), comparedAtSha: 'unchanged' },
      { branchKey: keyOf('feature/MERC-1184'), comparedAtSha: 'old' },
    ]

    const needed = branchesNeedingComparison(
      [
        { name: 'main', headSha: 'unchanged' },
        { name: 'feature/MERC-1184', headSha: 'moved' },
        { name: 'brand-new', headSha: 'x' },
      ],
      previous,
      keyOf,
    )

    expect(needed.map((b) => b.name)).toEqual(['feature/MERC-1184', 'brand-new'])
  })
})

describe('the connection probe', () => {
  // A token can authenticate and read a repository and still lack the `repo`
  // scope Ref.compare needs. Without a separate probe that failure is invisible
  // until ahead/behind is quietly missing everywhere.
  it('reports the compare probe separately from authentication', async () => {
    const { github } = gql([
      { data: { viewer: { id: 'U_me', login: 'jon', name: 'Jon' } } },
      // A branch has to come back, because the probe compares a *real* one.
      // Probing with `HEAD` resolves to nothing and reports "cannot compare"
      // for every token ever issued — a false negative that sends someone to
      // widen a perfectly good read-only token.
      {
        data: {
          repository: {
            pullRequests: { nodes: [] },
            refs: { nodes: [{ name: 'main', target: { oid: 'a1b2c3', committedDate: '2026-08-14T08:00:00Z' } }] },
          },
        },
      },
      { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] },
    ])

    const result = await github.probe({ owner: 'acme', repo: 'mercury' })

    expect(result.ok).toBe(false)
    expect(result.viewer?.displayName).toBe('Jon')
    expect(result.checks.find((c) => c.name === 'authentication')?.ok).toBe(true)
    expect(result.checks.find((c) => c.name === 'repository')?.ok).toBe(true)

    const compare = result.checks.find((c) => c.name === 'branch comparison')
    expect(compare?.ok).toBe(false)
    expect(compare?.detail).toMatch(/ahead\/behind will be unavailable/)
  })

  it('stops at authentication when the token is rejected outright', async () => {
    const { github } = gql([{ errors: [{ type: 'FORBIDDEN', message: 'Bad credentials' }] }])
    const result = await github.probe({ owner: 'acme', repo: 'mercury' })

    expect(result.ok).toBe(false)
    expect(result.checks).toHaveLength(1)
  })
})

describe('error mapping', () => {
  // GraphQL reports failures with HTTP 200 and an errors array, so the status
  // mapping never sees them. Unhandled, a permission error looks like an empty
  // repository -- the board would render "no work" instead of "no access".
  it('turns a 200-with-errors response into a typed failure', async () => {
    const { github } = gql([{ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }] }])

    try {
      await github.fetchRepository({ owner: 'acme', repo: 'mercury' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('unauthorized')
    }
  })

  it('distinguishes a scope problem from an outage', async () => {
    const { github } = gql([{ errors: [{ type: 'INTERNAL', message: 'something broke' }] }])

    try {
      await github.fetchRepository({ owner: 'acme', repo: 'mercury' })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('provider_unavailable')
    }
  })
})
