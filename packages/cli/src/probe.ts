import { Entry } from '@napi-rs/keyring'
import {
  appDataDir,
  credentialRef,
  githubProvider,
  jiraProvider,
  mirrorRepository,
  openMirror,
  osKeychain,
  parseRepositoryRef,
} from '@grndctrl/core'
import type { Connection } from '@grndctrl/core'

/**
 * `grndctrl-cli probe` — the first thing a real credential meets.
 *
 * It exists because two Phase 0 findings could not be settled from
 * documentation, and both fail *silently* if we guessed wrong:
 *
 * - **GitHub's `Ref.compare` may need a broader scope than a read-only
 *   fine-grained token grants** (research R3). A token that authenticates fine
 *   and reads a repository fine can still return `null` for every ahead/behind,
 *   and the only symptom is a column that is quietly empty everywhere. So it is
 *   probed as its own named check rather than inferred from the sync working.
 * - **Jira's enhanced search endpoint returns no total** (research R2). The
 *   probe prints what it actually fetched, worded so it cannot be mistaken for
 *   a server-side count — because the moment a number here reads as a total,
 *   someone builds a lane counter on it.
 *
 * Nothing is written. This reads, reports, and exits.
 */

export interface ProbeArgs {
  /** Limit to one connection. Omit to probe every configured one. */
  connectionId?: string | undefined
  /** The repository to probe against, `owner/repo`. Required for GitHub. */
  repo?: string | undefined
  /** JQL for the Jira probe. Defaults to the operator's own open issues. */
  jql?: string | undefined
  dir?: string | undefined
}

export async function runProbe(args: ProbeArgs): Promise<{ output: string; exitCode: number }> {
  const dir = args.dir ?? appDataDir()
  const { db } = openMirror({ dir })

  let connections: Connection[]
  try {
    connections = mirrorRepository(db).listConnections()
  } finally {
    db.close()
  }

  const wanted = connections.filter(
    (c) => args.connectionId === undefined || c.id === args.connectionId,
  )

  if (wanted.length === 0) {
    return {
      output: [
        'No connections are configured.',
        '',
        'Fill in .env.local and import first:',
        '  npm run credential:import',
      ].join('\n'),
      exitCode: 1,
    }
  }

  const store = osKeychain((service, account) => new Entry(service, account))
  const lines: string[] = []
  let allOk = true

  for (const connection of wanted) {
    lines.push(`${connection.kind}  ${connection.siteOrHost}  (${connection.id})`)

    let secret: string | null
    try {
      secret = store.get(credentialRef(connection.id))
    } catch (e) {
      lines.push(`  x  keychain          ${messageOf(e)}`, '')
      allOk = false
      continue
    }

    if (secret === null || secret === '') {
      lines.push('  x  keychain          no credential stored for this connection', '')
      allOk = false
      continue
    }

    // The length, and nothing else. Enough to catch a truncated paste, useless
    // to anyone reading the terminal over a shoulder.
    lines.push(`  o  keychain          ${secret.length} characters`)

    const result =
      connection.kind === 'github'
        ? await probeGitHub(connection, secret, args.repo)
        : await probeJira(connection, secret, args.jql)

    for (const check of result.checks) {
      lines.push(`  ${check.ok ? 'o' : 'x'}  ${check.name.padEnd(17)} ${check.detail}`)
    }
    if (!result.ok) allOk = false
    lines.push('')
  }

  return { output: lines.join('\n').trimEnd(), exitCode: allOk ? 0 : 1 }
}

interface ProbeResult {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}

async function probeGitHub(
  connection: Connection,
  token: string,
  repo: string | undefined,
): Promise<ProbeResult> {
  // Accepts `owner/name`, a browser URL, a clone URL or an SSH remote — the
  // paste from the address bar is the likeliest input and must simply work.
  const parsed = repo === undefined ? null : parseRepositoryRef(repo)

  if (parsed === null) {
    return {
      ok: false,
      checks: [
        {
          name: 'repository',
          ok: false,
          detail:
            'set GRNDCTRL_GITHUB_REPO or pass --repo — a fine-grained token is scoped per repository, so the probe has to be told which one',
        },
      ],
    }
  }

  const { owner, name } = parsed
  const provider = githubProvider({
    token,
    host: connection.siteOrHost,
    connectionId: connection.id,
  })

  // The provider owns the probe, so the CLI and the desktop settings page ask
  // the same question and cannot disagree about the answer.
  const result = await provider.probe({ owner, repo: name })
  return { ok: result.ok, checks: result.checks }
}

async function probeJira(
  connection: Connection,
  token: string,
  jql: string | undefined,
): Promise<ProbeResult> {
  const provider = jiraProvider({
    site: connection.siteOrHost,
    email: connection.accountLabel,
    apiToken: token,
    connectionId: connection.id,
  })

  const checks: ProbeResult['checks'] = []

  try {
    const viewer = await provider.viewer()
    checks.push({
      name: 'authentication',
      ok: true,
      detail: `authenticated as ${viewer.displayName ?? viewer.accountId}`,
    })
  } catch (e) {
    return { ok: false, checks: [{ name: 'authentication', ok: false, detail: messageOf(e) }] }
  }

  let issueKeys: string[] = []
  try {
    const { tickets, nextPageToken } = await provider.searchIssues({
      jql: jql ?? 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      pageSize: 50,
    })
    issueKeys = tickets.map((t) => t.issueKey)

    // Worded so it cannot be read as a total. R2: the enhanced search endpoint
    // returns none, and the moment a number here reads like one, a lane counter
    // gets built on it.
    checks.push({
      name: 'search',
      ok: true,
      detail: `fetched ${tickets.length} (no server-side total)${nextPageToken === null ? '' : ', more pages available'}`,
    })
  } catch (e) {
    checks.push({ name: 'search', ok: false, detail: messageOf(e) })
    return { ok: false, checks }
  }

  // The finding the plan was built around and could never confirm from the
  // docs. If the bulk changelog fetch works, "last real activity" is real; if
  // it does not, staleness falls back to `updated`, which FR-027 exists to
  // distrust — and the lane must say "activity unknown" rather than guess.
  if (issueKeys.length === 0) {
    checks.push({ name: 'issue history', ok: true, detail: 'no issues fetched, nothing to check' })
  } else {
    try {
      const activity = await provider.fetchChangelogs(issueKeys.slice(0, 10))
      checks.push({
        name: 'issue history',
        ok: true,
        detail: `bulk changelog returned ${activity.length} entries — "last real activity" is available`,
      })
    } catch (e) {
      checks.push({
        name: 'issue history',
        ok: false,
        detail: `${messageOf(e)} — the ticket lane will read "activity unknown"`,
      })
    }
  }

  return { ok: checks.every((c) => c.ok), checks }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
