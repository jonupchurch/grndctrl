import { branchKey, checkKey, pullRequestKey } from '../../domain/keys.js'
import type {
  BranchRef,
  CheckResult,
  CheckState,
  Comparison,
  PullRequest,
  PullRequestState,
  ReviewDecision,
  ViewerIdentity,
} from '../../domain/types.js'
import {
  providerUnavailable,
  unauthorized,
  type OperationError,
} from '../../registry/errors.js'
import { httpClient, type Fetcher } from '../http.js'
import type { CodeProvider } from '../seam.js'
import { buildComparisonQuery, REPOSITORY_QUERY } from './query.js'

/**
 * GitHub, read-only, over GraphQL.
 *
 * The shape here follows research R3: one document per repository for PRs,
 * branches, and checks, and one document for *all* branch comparisons together.
 * Comparisons are the expensive part — `Ref.compare` is a separate field
 * selection per branch, so batching them is not an optimisation to consider
 * later but the difference between a sustainable poll and one that spends the
 * hourly budget on ahead/behind alone.
 */

export interface GitHubOptions {
  token: string
  host?: string
  connectionId?: string
  fetcher?: Fetcher
  now?: () => Date
  prCount?: number
  branchCount?: number
}

interface GraphQLResponse<T> {
  data?: T
  errors?: { message?: string; type?: string }[]
}

export function githubProvider(options: GitHubOptions): CodeProvider {
  const now = options.now ?? (() => new Date())
  const host = options.host ?? 'github.com'
  const connectionId = options.connectionId ?? ''

  const client = httpClient({
    baseUrl: host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`,
    headers: {
      Authorization: `Bearer ${options.token}`,
      'GraphQL-Features': 'merge_queue',
    },
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
  })

  const graphql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await client.post<GraphQLResponse<T>>('/graphql', { query, variables })

    // GraphQL reports failures with HTTP 200 and an `errors` array, so the
    // status check in the HTTP client never sees them. Left unhandled, a
    // permission error would look like an empty repository.
    if (response.errors !== undefined && response.errors.length > 0) {
      throw graphqlError(response.errors, options.connectionId)
    }
    if (response.data === undefined) {
      throw graphqlError([{ message: 'empty response' }], options.connectionId)
    }
    return response.data
  }

  return {
    async viewer() {
      const data = await graphql<{ viewer: { id: string; login: string; name: string | null } }>(
        `query { viewer { id login name } }`,
        {},
      )
      return {
        accountId: data.viewer.id,
        displayName: data.viewer.name ?? data.viewer.login,
        email: null,
      }
    },

    async fetchRepository({ owner, repo }) {
      const data = await graphql<RepositoryData>(REPOSITORY_QUERY, {
        owner,
        repo,
        prCount: options.prCount ?? 50,
        branchCount: options.branchCount ?? 100,
      })

      const fetchedAt = now().toISOString()
      const repository = data.repository
      if (repository === null || repository === undefined) {
        return { pullRequests: [], branches: [], checks: [] }
      }

      const pullRequests: PullRequest[] = []
      const checks: CheckResult[] = []

      for (const node of repository.pullRequests?.nodes ?? []) {
        if (node === null) continue
        pullRequests.push(toPullRequest(node, owner, repo, connectionId, fetchedAt))
        checks.push(...toChecks(node, owner, repo, connectionId, fetchedAt))
      }

      const branches: BranchRef[] = (repository.refs?.nodes ?? [])
        .filter((n): n is RefNode => n !== null)
        .map((n) => ({
          key: branchKey(`${host}/${owner}/${repo}`, n.name),
          connectionId,
          name: n.name,
          headSha: n.target?.oid ?? '',
          updatedAt: n.target?.committedDate ?? fetchedAt,
          url: `https://${host}/${owner}/${repo}/tree/${n.name}`,
          fetchedAt,
        }))

      return { pullRequests, branches, checks }
    },

    async compareBranches({ owner, repo, baseRef, branches }) {
      if (branches.length === 0) return []

      const { query, aliases } = buildComparisonQuery(branches)
      const variables: Record<string, unknown> = { owner, repo, base: baseRef }
      branches.forEach((b, i) => {
        variables[`head${i}`] = b.name
      })

      const data = await graphql<ComparisonData>(query, variables)
      const fetchedAt = now().toISOString()
      const repository = data.repository ?? {}

      const comparisons: Comparison[] = []

      for (const [alias, branchName] of aliases) {
        const node = repository[alias]
        const branch = branches.find((b) => b.name === branchName)
        if (branch === undefined) continue

        comparisons.push({
          branchKey: branchKey(`${host}/${owner}/${repo}`, branchName),
          baseRef,
          // Null, never zero. A branch the host has never seen is unknown, and
          // reporting 0 would say "nothing to push" about commits that exist
          // and have gone nowhere (FR-018).
          aheadBy: node?.compare?.aheadBy ?? null,
          behindBy: node?.compare?.behindBy ?? null,
          comparedAtSha: branch.headSha,
          fetchedAt,
        })
      }

      return comparisons
    },

    async probe({ owner, repo }) {
      const checks: { name: string; ok: boolean; detail: string }[] = []
      let viewer: ViewerIdentity | null = null

      try {
        viewer = await this.viewer()
        checks.push({ name: 'authentication', ok: true, detail: `authenticated as ${viewer.displayName}` })
      } catch (e) {
        checks.push({ name: 'authentication', ok: false, detail: messageOf(e) })
        return { ok: false, viewer: null, checks }
      }

      let branchName: string | null = null

      try {
        const repository = await this.fetchRepository({ owner, repo })
        branchName = repository.branches[0]?.name ?? null
        checks.push({
          name: 'repository',
          ok: true,
          detail: `${owner}/${repo} is readable — ${repository.branches.length} branches, ${repository.pullRequests.length} open pull requests`,
        })
      } catch (e) {
        checks.push({ name: 'repository', ok: false, detail: messageOf(e) })
      }

      // Probed separately and deliberately. A token can authenticate and read a
      // repository and still lack the scope `Ref.compare` requires -- and that
      // failure is otherwise invisible until ahead/behind is quietly missing
      // everywhere on the board (research R3).
      //
      // A *real* branch name is used, not `HEAD`. `ref(qualifiedName: "HEAD")`
      // resolves to nothing, so probing with it reports "cannot compare" for
      // every token ever issued -- a false negative that would send someone to
      // widen a perfectly good read-only token for no reason. Comparing a branch
      // against itself is the cheapest valid comparison there is.
      if (branchName === null) {
        checks.push({
          name: 'branch comparison',
          ok: false,
          detail: 'no branches were readable, so the comparison could not be probed',
        })
      } else {
        try {
          const result = await this.compareBranches({
            owner,
            repo,
            baseRef: branchName,
            branches: [{ name: branchName, headSha: '' }],
          })
          const usable = result.length > 0 && result[0]?.aheadBy !== null
          checks.push({
            name: 'branch comparison',
            ok: usable,
            detail: usable
              ? `ahead/behind is available (probed with '${branchName}')`
              : `the token cannot compare branches — ahead/behind will be unavailable. A fine-grained token needs Contents: Read; a classic token needs \`repo\`.`,
          })
        } catch (e) {
          checks.push({
            name: 'branch comparison',
            ok: false,
            detail: `${messageOf(e)} — ahead/behind will be unavailable.`,
          })
        }
      }

      return { ok: checks.every((c) => c.ok), viewer, checks }
    },
  }
}

// ---------------------------------------------------------------------------

interface RepositoryData {
  repository?: {
    pullRequests?: { nodes?: (PullRequestNode | null)[] }
    refs?: { nodes?: (RefNode | null)[] }
  } | null
}

interface ComparisonData {
  repository?: Record<string, { compare?: { aheadBy?: number; behindBy?: number } | null } | undefined>
}

interface RefNode {
  name: string
  target?: { oid?: string; committedDate?: string } | null
}

interface PullRequestNode {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  closedAt: string | null
  author?: { login?: string; id?: string; name?: string | null } | null
  headRefName: string
  headRefOid: string
  baseRefName: string
  reviewDecision?: string | null
  reviewRequests?: { nodes?: ({ requestedReviewer?: { id?: string; login?: string; name?: string | null } | null } | null)[] }
  reviewThreads?: { nodes?: ({ isResolved?: boolean; isOutdated?: boolean } | null)[] }
  reviews?: { nodes?: ({ submittedAt?: string; author?: { login?: string } | null; state?: string } | null)[] }
  commits?: {
    nodes?: ({
      commit?: {
        oid?: string
        committedDate?: string
        statusCheckRollup?: {
          state?: string
          contexts?: { nodes?: (CheckContext | null)[] }
        } | null
      }
    } | null)[]
  }
}

interface CheckContext {
  __typename?: string
  name?: string
  conclusion?: string | null
  detailsUrl?: string
  completedAt?: string | null
  context?: string
  state?: string
  targetUrl?: string
  createdAt?: string
}

function toPullRequest(
  node: PullRequestNode,
  owner: string,
  repo: string,
  connectionId: string,
  fetchedAt: string,
): PullRequest {
  const commit = node.commits?.nodes?.[0]?.commit

  return {
    key: pullRequestKey(owner, repo, node.number),
    connectionId,
    number: node.number,
    title: node.title,
    author:
      node.author?.id === undefined
        ? null
        : {
            accountId: node.author.id,
            displayName: node.author.name ?? node.author.login ?? node.author.id,
            email: null,
          },
    headBranch: node.headRefName,
    headSha: node.headRefOid ?? commit?.oid ?? '',
    baseBranch: node.baseRefName,
    state: toState(node.state),
    isDraft: node.isDraft,
    reviewDecision: toReviewDecision(node.reviewDecision),
    requestedReviewers: (node.reviewRequests?.nodes ?? [])
      .map((r) => r?.requestedReviewer)
      .filter((r): r is { id?: string; login?: string; name?: string | null } => r !== null && r !== undefined)
      .filter((r) => r.id !== undefined)
      .map((r) => ({
        accountId: r.id as string,
        displayName: r.name ?? r.login ?? (r.id as string),
        email: null,
      })),
    unresolvedThreadCount: (node.reviewThreads?.nodes ?? []).filter(
      (t) => t !== null && t.isResolved === false && t.isOutdated !== true,
    ).length,
    mergedAt: node.mergedAt,
    closedAt: node.closedAt,
    // Human reviews and commits count; `updatedAt` does not, because a label or
    // a bot comment moves it (FR-027).
    lastRealActivityAt: latestReal(node, commit?.committedDate ?? null),
    url: node.url,
    fetchedAt,
  }
}

function latestReal(node: PullRequestNode, committedDate: string | null): string | null {
  const candidates: (string | null | undefined)[] = [
    committedDate,
    node.mergedAt,
    node.closedAt,
    ...(node.reviews?.nodes ?? []).map((r) => r?.submittedAt),
  ]

  let best: string | null = null
  for (const c of candidates) {
    if (c === null || c === undefined) continue
    if (best === null || Date.parse(c) > Date.parse(best)) best = c
  }
  return best
}

function toChecks(
  node: PullRequestNode,
  owner: string,
  repo: string,
  connectionId: string,
  fetchedAt: string,
): CheckResult[] {
  const commit = node.commits?.nodes?.[0]?.commit
  const sha = commit?.oid ?? node.headRefOid ?? ''
  if (sha === '') return []

  const rollup = commit?.statusCheckRollup
  // The rollup is what GitHub's own merge button reads. A per-check
  // `isRequired` is not obtainable in this document (see query.ts), so a
  // failing rollup is what marks the individual failures as required.
  const rollupFailing = rollup?.state === 'FAILURE'

  return (rollup?.contexts?.nodes ?? [])
    .filter((c): c is CheckContext => c !== null && c !== undefined)
    .map((c) => {
      const name = c.name ?? c.context ?? 'check'
      const state = c.__typename === 'CheckRun' ? toCheckState(c.conclusion) : toCheckState(c.state)

      return {
        key: checkKey(owner, repo, sha, name),
        connectionId,
        sha,
        name,
        state,
        isRequired: rollupFailing && state === 'failure',
        url: c.detailsUrl ?? c.targetUrl ?? `https://github.com/${owner}/${repo}/commit/${sha}/checks`,
        completedAt: c.completedAt ?? c.createdAt ?? null,
        fetchedAt,
      }
    })
}

function toState(state: string): PullRequestState {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return 'open'
}

function toReviewDecision(decision: string | null | undefined): ReviewDecision | null {
  switch (decision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changesRequested'
    case 'REVIEW_REQUIRED':
      return 'reviewRequired'
    default:
      return null
  }
}

function toCheckState(raw: string | null | undefined): CheckState {
  switch (raw) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'STARTUP_FAILURE':
      return 'failure'
    case 'CANCELLED':
      return 'cancelled'
    case 'SKIPPED':
    case 'NEUTRAL':
      return 'skipped'
    default:
      // Null conclusion means still running. Treated as pending rather than as
      // a failure -- a check in flight is not a broken build.
      return 'pending'
  }
}

/**
 * Map a GraphQL error array onto the registry taxonomy.
 *
 * These arrive with HTTP 200, so the status mapping in the HTTP client never
 * sees them. `FORBIDDEN` and `INSUFFICIENT_SCOPES` are the ones that matter:
 * they are how a token missing the `repo` scope reports itself, and rendering
 * that as "provider unavailable" would tell the user to check their network
 * when the fix is to re-authorize.
 */
function graphqlError(
  errors: { message?: string; type?: string }[],
  connectionId?: string,
): OperationError {
  const first = errors[0]
  const type = first?.type ?? ''
  const detail = first?.message ?? type ?? 'unknown'

  if (type === 'FORBIDDEN' || type === 'INSUFFICIENT_SCOPES') {
    return unauthorized(`GitHub refused the request: ${detail}`, connectionId)
  }
  return providerUnavailable(`GitHub returned an error: ${detail}`, connectionId)
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
