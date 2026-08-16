/**
 * GraphQL documents.
 *
 * GraphQL rather than REST is a locked decision, and it earns its keep in one
 * field: `pullRequest.reviewThreads { isResolved, isOutdated }` has no REST
 * equivalent, and review state drives both severity (FR-029) and ball-in-court
 * (FR-032). REST would need one call per PR per thread page.
 */

export const REPOSITORY_QUERY = `
query Repository($owner: String!, $repo: String!, $prCount: Int!, $branchCount: Int!) {
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $repo) {
    pullRequests(first: $prCount, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        isDraft
        createdAt
        updatedAt
        mergedAt
        closedAt
        author { login ... on User { id name } }
        headRefName
        headRefOid
        baseRefName
        reviewDecision
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on User { id login name } } }
        }
        reviewThreads(first: 100) { nodes { isResolved isOutdated } }
        reviews(last: 20) {
          nodes { submittedAt author { login } state }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              committedDate
              statusCheckRollup {
                # The rollup state is what GitHub's own merge button reads, and
                # it is the only requiredness signal available here: CheckRun's
                # isRequired takes a pull-request number as a literal argument,
                # which cannot be parameterised per node inside this list.
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion detailsUrl completedAt }
                    ... on StatusContext { context state targetUrl createdAt }
                  }
                }
              }
            }
          }
        }
      }
    }
    refs(refPrefix: "refs/heads/", first: $branchCount, orderBy: {field: TAG_COMMIT_DATE, direction: DESC}) {
      nodes {
        name
        target { ... on Commit { oid committedDate } }
      }
    }
  }
}
`

/**
 * Build one document containing every branch comparison, aliased.
 *
 * This is the whole reason comparisons are a batch operation in the seam. Each
 * `compare` is its own field selection and cannot be batched the natural way,
 * so a 40-branch repository on a 60-second poll would spend its entire hourly
 * budget on comparisons alone if each were a request (research R3).
 *
 * Aliases are positional (`c0`, `c1`, …) rather than derived from branch names,
 * because a GraphQL alias must be a valid name and branch names contain
 * slashes, dots, and dashes.
 */
export function buildComparisonQuery(branches: readonly { name: string }[]): {
  query: string
  aliases: Map<string, string>
} {
  const aliases = new Map<string, string>()

  const selections = branches.map((branch, i) => {
    const alias = `c${i}`
    aliases.set(alias, branch.name)
    return `    ${alias}: ref(qualifiedName: $base) { compare(headRef: $head${i}) { aheadBy behindBy } }`
  })

  const params = branches.map((_, i) => `$head${i}: String!`).join(', ')

  const query = `
query Compare($owner: String!, $repo: String!, $base: String!${params === '' ? '' : `, ${params}`}) {
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $repo) {
${selections.join('\n')}
  }
}
`

  return { query, aliases }
}

/**
 * Which branches actually need comparing.
 *
 * A comparison is only re-run when the branch head has moved since the last
 * successful one. On a repository where most branches sit still between polls,
 * this is the difference between a sustainable poll and one that exhausts the
 * budget (R3).
 */
export function branchesNeedingComparison(
  branches: readonly { name: string; headSha: string }[],
  previous: readonly { branchKey: string; comparedAtSha: string }[],
  keyOf: (branchName: string) => string,
): { name: string; headSha: string }[] {
  const comparedAt = new Map(previous.map((p) => [p.branchKey, p.comparedAtSha]))
  return branches.filter((b) => comparedAt.get(keyOf(b.name)) !== b.headSha)
}
