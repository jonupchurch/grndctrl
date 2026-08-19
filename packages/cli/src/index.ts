import { readFileSync } from 'node:fs'
import { correlate, DEFAULT_SETTINGS, freshnessView } from '@grndctrl/core'
import { noteFieldsOf, resolveScenarioTimes } from '@grndctrl/core/fixtures'
import type { ScenarioNote } from '@grndctrl/core/fixtures'
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

/**
 * The on-disk shape, which is not quite a `CorrelationInput`.
 *
 * Two of its fields are *derived* rather than stated. `noteCounts` and
 * `openQuestionSubjects` are what the notes produce, and the other reader of
 * these files — `seed.mjs` — writes notes into a real authored store where both
 * numbers come from the rows in it. A scenario that stated them could only be
 * honoured here, so it stated one thing and meant two.
 */
interface Scenario {
  description?: string
  now?: string
  settings?: Partial<Settings>
  freshness?: FreshnessRecord[]
  notes?: ScenarioNote[]
  input: Omit<CorrelationInput, 'settings' | 'now' | 'noteCounts' | 'openQuestionSubjects'>
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
    // Resolved against *this* instant, so `now-5d` means five days before the
    // command was run (FR-118). A scenario is a photograph of a board and its
    // meaning is relative to when it was taken; the absolute dates these files
    // used to carry made a fixture about staleness stop being about staleness a
    // fortnight after it was written.
    scenario = resolveScenarioTimes(
      JSON.parse(readFileSync(fixturePath, 'utf8')) as Scenario,
      new Date(),
    )
  } catch (e) {
    return { output: `Could not read ${fixturePath}: ${messageOf(e)}`, exitCode: 1 }
  }

  // Still defaulted, because a scenario with no `now` is legal and a board with
  // no clock is not. It is the load instant rather than a date in 2026: the
  // fallback used to be the day these fixtures were written, which quietly made
  // every undated scenario a period piece.
  const now = scenario.now === undefined ? new Date() : new Date(scenario.now)
  const settings = { ...DEFAULT_SETTINGS, ...scenario.settings }

  const correlationInput: CorrelationInput = {
    ...scenario.input,
    ...noteFieldsOf(scenario.notes ?? []),
    settings,
    now,
  }

  // One pass. There were two, and the second existed only because severity had
  // to know which items were in drift (FR-029) -- a single pass rendered a
  // drifting row one severity lower than the real board did, which is exactly
  // the quiet disagreement this CLI exists to expose. With drift gone the
  // second pass has nothing to feed back, and `buildBoard` is single-pass too.
  const { workItems } = correlate(correlationInput)

  const kinds: ResourceKind[] = ['tickets']
  const freshness = Object.fromEntries(
    kinds.map((kind) => {
      const record = (scenario.freshness ?? []).find((f) => f.resourceKind === kind)
      const view = freshnessView(record, now.getTime(), settings.pollIntervalSec.jira * 3)
      return [kind, { state: view.state, ageSec: view.ageSec }]
    }),
  )

  const output = renderBoard({
    workItems,
    freshness,
    projectFilter: valueOf(argv, '--project'),
    now,
  })

  return { output, exitCode: 0 }
}

/**
 * Import whichever credentials the environment actually has.
 *
 * One provider now. The loop that skipped a provider whose token was absent is
 * still the shape of this, and the reason it was written that way is worth
 * keeping: `credential` is run repeatedly while a connection is being set up,
 * and a command that refuses until everything is present gets run once and
 * abandoned.
 *
 * **This is the dev route, and it is not the supported one.** Operators add a
 * token in Settings → Connections; nothing here is published. It exists so a
 * secret can get from a hand-off file into the keychain in one step during
 * development, and the file is meant to be blanked afterwards.
 */
function runCredential(argv: readonly string[]): { output: string; exitCode: number } {
  const env = resolveEnv(valueOf(argv, '--env-file') ?? DEFAULT_ENV_FILE)
  const dir = valueOf(argv, '--dir') ?? undefined
  const results: string[] = []
  let exitCode = 0
  let imported = 0

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
        'Fill in GRNDCTRL_JIRA_SITE, GRNDCTRL_JIRA_EMAIL and GRNDCTRL_JIRA_API_TOKEN,',
        'then run this again. See .env.example for what each variable is and why.',
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

/**
 * No longer reads the env file.
 *
 * It did, for one reason: `--repo` fell back to `GRNDCTRL_GITHUB_REPO`, because
 * a fine-grained GitHub token is scoped per repository and the probe had to be
 * told which one to try. The Jira probe takes everything it needs from the
 * connection row, so `--env-file` is now accepted and ignored here — it is still
 * meaningful to `credential`, which is the command that reads secrets.
 */
async function runProbeCommand(
  argv: readonly string[],
): Promise<{ output: string; exitCode: number }> {
  return runProbe({
    connectionId: valueOf(argv, '--connection') ?? undefined,
    jql: valueOf(argv, '--jql') ?? undefined,
    dir: valueOf(argv, '--dir') ?? undefined,
  })
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
    '  grndctrl-cli probe       [--connection <id>] [--jql <jql>]',
    '',
    'board       Prints the correlated board for a fixture scenario: lanes with',
    '            severity, staleness and ball-in-court. Entirely offline — no',
    '            network, no Electron, no display.',
    '',
    'credential  Reads tokens from .env.local and stores them in the OS keychain.',
    '            The secret is never an argument: an argument lands in shell',
    '            history and in the process list. Nothing is echoed but a length.',
    '',
    'probe       Checks a stored credential against the live provider — that it',
    '            authenticates, that search works, and that issue history is',
    '            readable. Reads only; writes nothing.',
  ].join('\n')
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
