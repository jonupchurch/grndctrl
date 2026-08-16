import { credentialRef, credentialRefString, type CredentialStore } from '../auth/keychain.js'
import type { Connection, Project, ProviderKind, ViewerIdentity } from '../domain/types.js'
import { parseRepositoryRef } from '../domain/keys.js'
import { githubProvider } from '../providers/github/index.js'
import { jiraProvider } from '../providers/jira/index.js'
import type { Fetcher } from '../providers/http.js'
import { invalid, notFound } from '../registry/errors.js'
import type { MirrorRepository } from '../store/mirror/repository.js'

/**
 * Adding, testing and removing a provider connection.
 *
 * This is the only path by which a secret enters the application, and every
 * rule it holds to rules out somewhere secrets normally leak:
 *
 * - **The secret is written to the keychain and nowhere else** (XI, FR-005).
 *   The connection row stores a `service/account` handle, which is a lookup
 *   address, not a credential.
 * - **The round trip is verified before the row is written.** Writing the row
 *   first and assuming the keychain worked is how an operator discovers a broken
 *   keyring at the first sync instead of here, against a connection that claims
 *   to be configured.
 * - **Nothing echoes the secret.** Not the value, not a prefix, not the last
 *   four characters — `add` returns the `Connection`, which by construction
 *   cannot carry one.
 * - **An unreachable keychain fails loudly and stores nothing** (FR-006). There
 *   is deliberately no fallback: an environment-variable escape hatch is exactly
 *   what XI forbids, and it is the one that would get used.
 *
 * `test` is separate from `add` because authenticating and being *useful* are
 * different questions. A GitHub token can authenticate perfectly, read a
 * repository perfectly, and still lack the scope `compare` needs — and the only
 * symptom is an ahead/behind column that is quietly empty everywhere (research
 * R3). So the compare probe is reported as its own named check rather than
 * inferred from the sync working.
 */

export interface ConnectionCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ConnectionTestResult {
  ok: boolean
  viewerIdentity: ViewerIdentity | null
  checks: ConnectionCheck[]
}

export interface AddConnectionInput {
  kind: ProviderKind
  /** `acme.atlassian.net` or `github.com`. Never a scheme, never a trailing slash. */
  siteOrHost: string
  /** Jira: the account email. GitHub: the login. An identifier, never a secret. */
  accountLabel: string
  secret: string
}

export interface ConnectionsService {
  list(): Connection[]
  add(input: AddConnectionInput): Connection
  test(input: { connectionId: string; repo?: string | undefined }): Promise<ConnectionTestResult>
  remove(connectionId: string): { removed: boolean }
}

export interface ConnectionsServiceDeps {
  mirror: MirrorRepository
  credentials: CredentialStore
  /** Bound projects, so a GitHub test knows which repository to probe. */
  projects(): readonly Project[]
  fetcher?: Fetcher | undefined
  now?: (() => Date) | undefined
}

export function connectionsService(deps: ConnectionsServiceDeps): ConnectionsService {
  const service: ConnectionsService = {
    list: () => deps.mirror.listConnections(),

    add(input) {
      const siteOrHost = normaliseHost(input.siteOrHost)
      if (siteOrHost === '') throw invalid('A site or host is required.')
      if (input.accountLabel.trim() === '') {
        throw invalid(
          input.kind === 'jira'
            ? 'A Jira account email is required — Jira Cloud authenticates as email plus token.'
            : 'A GitHub login is required, so the board can tell your pull requests from everyone else’s.',
        )
      }

      // Trailing whitespace from a copy-paste is the single most common cause of
      // a token that looks right and authenticates as nobody. Rejected rather
      // than trimmed: silently altering a secret is its own class of confusion.
      if (input.secret.trim() !== input.secret) {
        throw invalid('That secret has leading or trailing whitespace. A stray newline reads as a different token.')
      }
      if (input.secret === '') throw invalid('A secret is required.')

      // Re-authorizing an account replaces its credential rather than
      // accumulating a second connection nobody can tell apart (FR-007).
      const existing = deps.mirror
        .listConnections()
        .find(
          (c) =>
            c.kind === input.kind &&
            c.siteOrHost === siteOrHost &&
            c.accountLabel === input.accountLabel,
        )

      const id = existing?.id ?? idFor(input.kind, input.accountLabel, deps.mirror.listConnections())
      const ref = credentialRef(id)

      deps.credentials.set(ref, input.secret)
      if (deps.credentials.get(ref) !== input.secret) {
        throw invalid('The credential store accepted the secret but did not return it. Nothing further was written.')
      }

      const connection: Connection = {
        id,
        kind: input.kind,
        siteOrHost,
        accountLabel: input.accountLabel,
        // Resolved by the next sync, which asks the provider (FR-033). Guessing
        // it here from the label would make "mine" a string comparison.
        viewerIdentity: existing?.viewerIdentity ?? null,
        credentialRef: credentialRefString(ref),
      }

      deps.mirror.upsertConnection(connection)
      return connection
    },

    async test({ connectionId, repo }) {
      const connection = deps.mirror.listConnections().find((c) => c.id === connectionId)
      if (connection === undefined) throw notFound(`No connection '${connectionId}'.`)

      let secret: string | null
      try {
        secret = deps.credentials.get(credentialRef(connection.id))
      } catch (e) {
        // Unreachable keychain is its own condition with its own remedy (FR-006),
        // and must not read as "your token is wrong".
        return fail('credential store', messageOf(e))
      }

      if (secret === null || secret === '') {
        return fail('credential', 'no secret is stored for this connection')
      }

      return connection.kind === 'jira'
        ? testJira(connection, secret, deps)
        : testGitHub(connection, secret, repo, deps)
    },

    remove(connectionId) {
      const connection = deps.mirror.listConnections().find((c) => c.id === connectionId)
      if (connection === undefined) return { removed: false }

      // The credential goes first. If the row went first and this threw, the
      // secret would be left in the keychain with nothing referencing it —
      // unreachable, unremovable through the interface, and still a secret.
      deps.credentials.delete(credentialRef(connectionId))
      deps.mirror.deleteConnection(connectionId)
      return { removed: true }
    },
  }

  return service
}

async function testJira(
  connection: Connection,
  apiToken: string,
  deps: ConnectionsServiceDeps,
): Promise<ConnectionTestResult> {
  const provider = jiraProvider({
    site: connection.siteOrHost,
    email: connection.accountLabel,
    apiToken,
    connectionId: connection.id,
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })

  const checks: ConnectionCheck[] = []
  let viewer: ViewerIdentity | null = null

  try {
    viewer = await provider.viewer()
    checks.push({
      name: 'authentication',
      ok: true,
      detail: `authenticated as ${viewer.displayName}`,
    })
  } catch (e) {
    return { ok: false, viewerIdentity: null, checks: [check('authentication', false, messageOf(e))] }
  }

  try {
    const { tickets } = await provider.searchIssues({
      jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      pageSize: 1,
    })
    // Worded so it cannot be read as a total: the enhanced search endpoint
    // returns none, and the moment a number here reads like one someone builds
    // a lane counter on it (R2).
    checks.push(check('search', true, `search reachable (${tickets.length} fetched, no server-side total)`))
  } catch (e) {
    checks.push(check('search', false, messageOf(e)))
  }

  return { ok: checks.every((c) => c.ok), viewerIdentity: viewer, checks }
}

async function testGitHub(
  connection: Connection,
  token: string,
  repo: string | undefined,
  deps: ConnectionsServiceDeps,
): Promise<ConnectionTestResult> {
  const provider = githubProvider({
    token,
    host: connection.siteOrHost,
    connectionId: connection.id,
    ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })

  // An explicit repository wins; otherwise any project already bound to this
  // connection. A fine-grained token is scoped per repository, so "can it read
  // a repository" is not answerable without naming one.
  const bound = deps
    .projects()
    .find((p) => p.githubConnectionId === connection.id && p.repoOwner !== null && p.repoName !== null)

  const target =
    repo !== undefined
      ? parseRepositoryRef(repo)
      : bound === undefined
        ? null
        : { owner: bound.repoOwner as string, name: bound.repoName as string }

  if (target === null) {
    let viewer: ViewerIdentity | null = null
    try {
      viewer = await provider.viewer()
    } catch (e) {
      return { ok: false, viewerIdentity: null, checks: [check('authentication', false, messageOf(e))] }
    }

    return {
      ok: false,
      viewerIdentity: viewer,
      checks: [
        check('authentication', true, `authenticated as ${viewer.displayName}`),
        check(
          'repository',
          false,
          'no repository to test against — bind a project to this connection, or name one. A fine-grained token is scoped per repository.',
        ),
      ],
    }
  }

  // The provider owns the probe, so this screen and `grndctrl-cli probe` ask the
  // same question and cannot disagree about the answer.
  const result = await provider.probe({ owner: target.owner, repo: target.name })
  return { ok: result.ok, viewerIdentity: result.viewer, checks: result.checks }
}

const check = (name: string, ok: boolean, detail: string): ConnectionCheck => ({ name, ok, detail })

const fail = (name: string, detail: string): ConnectionTestResult => ({
  ok: false,
  viewerIdentity: null,
  checks: [check(name, false, detail)],
})

/** A host, not a URL. `https://acme.atlassian.net/` and `acme.atlassian.net` are the same site. */
function normaliseHost(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/**
 * A stable id derived from the account, so re-adding the same account replaces
 * its credential instead of leaving an orphan nobody can see.
 *
 * The bare kind is used for the first connection of that kind, which keeps the
 * ids the CLI has already written (`github`, `jira`) valid.
 */
function idFor(kind: ProviderKind, accountLabel: string, existing: readonly Connection[]): string {
  if (!existing.some((c) => c.id === kind)) return kind

  const slug = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const base = slug === '' ? kind : `${kind}-${slug}`
  if (!existing.some((c) => c.id === base)) return base

  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!existing.some((c) => c.id === candidate)) return candidate
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
