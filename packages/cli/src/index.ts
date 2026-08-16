import { readFileSync } from 'node:fs'
import { correlate, detectDrift, DEFAULT_SETTINGS, freshnessView } from '@grndctrl/core'
import type { CorrelationInput, FreshnessRecord, ResourceKind, Settings } from '@grndctrl/core'
import { renderBoard } from './board.js'
import { importCredential } from './credential.js'
import { resolveEnv } from './env.js'
import { runProbe } from './probe.js'

/** Repo-root relative. The hand-off file, not a runtime one. */
const DEFAULT_ENV_FILE = '.env.local'

/**
 * `grndctrl-cli` — a dev tool, not a product surface.
 *
 * It runs the correlation engine over a fixture file and prints the board as
 * text. Two jobs: make M2 demonstrable before any UI exists, and give fixture
 * debugging a diffable output afterwards.
 */

interface Scenario {
  description?: string
  now?: string
  settings?: Partial<Settings>
  freshness?: FreshnessRecord[]
  input: Omit<CorrelationInput, 'settings' | 'now'>
}

/**
 * The commands that touch the network or the keychain are async and live in
 * their own modules; `board` is synchronous and offline, and stays that way.
 */
export async function runCliAsync(
  argv: readonly string[],
): Promise<{ output: string; exitCode: number }> {
  const command = argv[0]

  if (command === 'credential') return runCredential(argv)
  if (command === 'probe') return runProbeCommand(argv)

  return runCli(argv)
}

export function runCli(argv: readonly string[]): { output: string; exitCode: number } {
  const command = argv[0]

  if (command === undefined || command === '--help' || command === 'help') {
    return { output: usage(), exitCode: command === undefined ? 1 : 0 }
  }

  if (command !== 'board') {
    return { output: `Unknown command '${command}'.\n\n${usage()}`, exitCode: 1 }
  }

  const fixturePath = valueOf(argv, '--fixtures')
  if (fixturePath === null) {
    return { output: `board needs --fixtures <path>.\n\n${usage()}`, exitCode: 1 }
  }

  let scenario: Scenario
  try {
    scenario = JSON.parse(readFileSync(fixturePath, 'utf8')) as Scenario
  } catch (e) {
    return { output: `Could not read ${fixturePath}: ${messageOf(e)}`, exitCode: 1 }
  }

  const now = new Date(scenario.now ?? '2026-08-14T12:00:00Z')
  const settings = { ...DEFAULT_SETTINGS, ...scenario.settings }

  const correlationInput: CorrelationInput = { ...scenario.input, settings, now }

  // Two passes, matching buildBoard. Drift needs correlated work items, and
  // severity needs to know which items are in drift (FR-029) -- a single pass
  // renders a drifting row one severity lower than the real board would, which
  // is exactly the sort of quiet disagreement this CLI exists to expose.
  const first = correlate(correlationInput)
  const findings = detectDrift({
    workItems: first.workItems,
    dangling: first.dangling,
    settings,
    now,
  })
  const { workItems } = correlate({
    ...correlationInput,
    driftSubjects: findings.map((f) => f.subjectKey),
  })

  const kinds: ResourceKind[] = ['tickets', 'pulls', 'branches', 'local']
  const freshness = Object.fromEntries(
    kinds.map((kind) => {
      const record = (scenario.freshness ?? []).find((f) => f.resourceKind === kind)
      const view = freshnessView(record, now.getTime(), settings.pollIntervalSec.github * 3)
      return [kind, { state: view.state, ageSec: view.ageSec }]
    }),
  )

  const output = renderBoard({
    workItems,
    findings,
    freshness,
    projectFilter: valueOf(argv, '--project'),
    now,
  })

  return { output, exitCode: 0 }
}

/**
 * Import whichever credentials the environment actually has.
 *
 * Both providers in one command, and each one skipped rather than failed when
 * its token is absent — GitHub today and Jira tomorrow is the normal case, and
 * a command that refuses until everything is present would be run once and
 * abandoned.
 */
function runCredential(argv: readonly string[]): { output: string; exitCode: number } {
  const env = resolveEnv(valueOf(argv, '--env-file') ?? DEFAULT_ENV_FILE)
  const dir = valueOf(argv, '--dir') ?? undefined
  const results: string[] = []
  let exitCode = 0
  let imported = 0

  if ((env['GRNDCTRL_GITHUB_TOKEN'] ?? '') !== '') {
    const account = env['GRNDCTRL_GITHUB_ACCOUNT'] ?? ''
    if (account === '') {
      return {
        output: 'GRNDCTRL_GITHUB_ACCOUNT is empty. It is your GitHub login, not a secret — the board needs it to tell your pull requests from everyone else’s.',
        exitCode: 1,
      }
    }

    const result = importCredential(
      {
        // Stable, so re-running replaces the credential rather than
        // accumulating orphaned connections nobody can see.
        connectionId: 'github',
        kind: 'github',
        // `??` is wrong here: an empty variable is present-but-blank, which is
        // what a template with the line already in it always produces.
        siteOrHost: blank(env['GRNDCTRL_GITHUB_HOST']) ?? 'github.com',
        accountLabel: account,
        fromEnv: 'GRNDCTRL_GITHUB_TOKEN',
        ...(dir === undefined ? {} : { dir }),
      },
      env,
    )
    results.push(result.output)
    if (result.exitCode !== 0) exitCode = result.exitCode
    else imported += 1
  }

  if ((env['GRNDCTRL_JIRA_API_TOKEN'] ?? '') !== '') {
    const site = env['GRNDCTRL_JIRA_SITE'] ?? ''
    const email = env['GRNDCTRL_JIRA_EMAIL'] ?? ''
    if (site === '' || email === '') {
      return {
        output: 'GRNDCTRL_JIRA_SITE and GRNDCTRL_JIRA_EMAIL are both required — Jira Cloud authenticates as email plus token, and only the token is a secret.',
        exitCode: 1,
      }
    }

    const result = importCredential(
      {
        connectionId: 'jira',
        kind: 'jira',
        siteOrHost: site,
        accountLabel: email,
        fromEnv: 'GRNDCTRL_JIRA_API_TOKEN',
        ...(dir === undefined ? {} : { dir }),
      },
      env,
    )
    results.push(result.output)
    if (result.exitCode !== 0) exitCode = result.exitCode
    else imported += 1
  }

  if (imported === 0 && exitCode === 0) {
    return {
      output: [
        `No credentials found in ${valueOf(argv, '--env-file') ?? DEFAULT_ENV_FILE}.`,
        '',
        'Fill in GRNDCTRL_GITHUB_TOKEN (and GRNDCTRL_GITHUB_ACCOUNT), then run this again.',
        'See .env.example for what each variable is and why.',
      ].join('\n'),
      exitCode: 1,
    }
  }

  if (exitCode === 0) {
    results.push(
      '',
      'Now blank the token lines in .env.local. Nothing reads that file at runtime —',
      'the secret lives in the OS keychain from here on (constitution XI).',
    )
  }

  return { output: results.join('\n'), exitCode }
}

async function runProbeCommand(
  argv: readonly string[],
): Promise<{ output: string; exitCode: number }> {
  const env = resolveEnv(valueOf(argv, '--env-file') ?? DEFAULT_ENV_FILE)

  return runProbe({
    connectionId: valueOf(argv, '--connection') ?? undefined,
    // `--repo` wins, then the env file. A fine-grained token is scoped per
    // repository, so the probe has to be told which one to try.
    repo: valueOf(argv, '--repo') ?? env['GRNDCTRL_GITHUB_REPO'] ?? undefined,
    jql: valueOf(argv, '--jql') ?? undefined,
    dir: valueOf(argv, '--dir') ?? undefined,
  })
}

/** A variable that exists but is empty is not set. Templates ship every line already present. */
function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

function valueOf(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

function usage(): string {
  return [
    'grndctrl-cli — dev-only text board',
    '',
    'Usage:',
    '  grndctrl-cli board       --fixtures <path> [--project <id>]',
    '  grndctrl-cli credential  [--env-file <path>] [--dir <path>]',
    '  grndctrl-cli probe       [--repo <owner/name>] [--connection <id>] [--jql <jql>]',
    '',
    'board       Prints the correlated board for a fixture scenario: lanes with',
    '            severity, staleness and ball-in-court, plus drift findings and',
    '            their evidence. Entirely offline — no network, no Electron, no',
    '            display.',
    '',
    'credential  Reads tokens from .env.local and stores them in the OS keychain.',
    '            The secret is never an argument: an argument lands in shell',
    '            history and in the process list. Nothing is echoed but a length.',
    '',
    'probe       Checks a stored credential against the live provider — auth,',
    '            repository read, and the branch comparison that needs a scope a',
    '            read-only token may not have. Reads only; writes nothing.',
  ].join('\n')
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
