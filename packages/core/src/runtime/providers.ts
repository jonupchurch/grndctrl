import type { CredentialStore } from '../auth/keychain.js'
import { credentialRef } from '../auth/keychain.js'
import type { Connection, Project } from '../domain/types.js'
import { githubProvider } from '../providers/github/index.js'
import { jiraProvider } from '../providers/jira/index.js'
import type { CodeProvider, LocalGitProvider, TicketProvider } from '../providers/seam.js'
import type { Fetcher } from '../providers/http.js'
import type { SyncTargets } from '../services/sync.js'

/**
 * Turning stored connections into live providers.
 *
 * The credential never travels further than this function. It is read from the
 * OS keychain, handed to the provider client that will put it in an
 * `Authorization` header, and never written anywhere else — not into the
 * connection row, not into a log, not into the returned structure (XI). The
 * connection row holds only a *reference* to where the secret lives.
 *
 * A connection with no usable credential is skipped and reported, not
 * substituted with an anonymous client. An unauthenticated request to Jira
 * succeeds against public issues and returns a plausible, wrong, much shorter
 * board — which is worse than a lane that says it failed (XV).
 */

export interface BuildTargetsOptions {
  projects: readonly Project[]
  connections: readonly Connection[]
  credentials: CredentialStore
  git: LocalGitProvider
  /** Injected in tests so provider construction never needs the network. */
  fetcher?: Fetcher | undefined
  now?: (() => Date) | undefined
}

export interface BuiltTargets {
  targets: SyncTargets
  /** Connections that could not be built, and why. Surfaced, never swallowed. */
  unavailable: { connectionId: string; reason: 'no-credential' | 'keychain-unavailable' }[]
}

export function buildSyncTargets(options: BuildTargetsOptions): BuiltTargets {
  const ticketProviders = new Map<string, TicketProvider>()
  const codeProviders = new Map<string, CodeProvider>()
  const unavailable: BuiltTargets['unavailable'] = []

  for (const connection of options.connections) {
    let secret: string | null
    try {
      secret = options.credentials.get(credentialRef(connection.id))
    } catch {
      // The keychain being unreachable is its own condition (FR-006). It is not
      // "no credential", and the remedy is different — so it is reported
      // separately rather than folded together.
      unavailable.push({ connectionId: connection.id, reason: 'keychain-unavailable' })
      continue
    }

    if (secret === null || secret === '') {
      unavailable.push({ connectionId: connection.id, reason: 'no-credential' })
      continue
    }

    if (connection.kind === 'jira') {
      // The email is an identifier, not a secret, so it lives on the connection
      // row and only the API token goes to the keychain. Keeping the keychain
      // payload a pure secret is what lets the no-secrets audit scan for one
      // thing rather than parse a blob.
      ticketProviders.set(
        connection.id,
        jiraProvider({
          site: connection.siteOrHost,
          email: connection.accountLabel,
          apiToken: secret,
          connectionId: connection.id,
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
      )
      continue
    }

    codeProviders.set(
      connection.id,
      githubProvider({
        token: secret,
        host: connection.siteOrHost,
        connectionId: connection.id,
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    )
  }

  return {
    targets: {
      projects: options.projects,
      ticketProviders,
      codeProviders,
      git: options.git,
    },
    unavailable,
  }
}
