/**
 * The dependency audit (T171, constitution XI).
 *
 * XI says no telemetry, no analytics, no crash reporting, and no phoning home.
 * That is a promise about *this* code and about every line of code shipped
 * alongside it — and the realistic way it gets broken is not somebody adding
 * `analytics.track()`. It is a dependency two levels down that posts an install
 * ping, or a package added for one small utility that carries a usage reporter.
 *
 * So this walks the **production** dependency tree — what a user installs, not
 * what a contributor installs — and fails on two things:
 *
 * 1. **A package whose purpose is reporting.** Matched by name against the list
 *    below, which is the set that actually turns up in npm trees.
 * 2. **A lifecycle script.** `postinstall`, `preinstall` and `install` run
 *    arbitrary code on a user's machine at `npx` time, before anything has been
 *    reviewed or verified. `better-sqlite3` legitimately has one (it fetches a
 *    prebuild), so this reports rather than forbids — but it reports, because a
 *    new one appearing is a thing to look at rather than a thing to discover.
 */

export interface Package {
  name: string
  version: string
  /** How it got here: the chain from a root workspace. */
  path: readonly string[]
  scripts?: Record<string, string> | undefined
}

/**
 * Packages whose whole job is to send data somewhere.
 *
 * Matched on the package name, including scope. Substring matching would be
 * tempting and wrong: `@sentry/…` must match, but a package legitimately named
 * `matomo-css-parser` must not, and neither must `posthog-schema-types`.
 */
export const REPORTERS = new Set([
  '@sentry/node',
  '@sentry/electron',
  '@sentry/browser',
  '@sentry/core',
  'bugsnag',
  '@bugsnag/js',
  '@bugsnag/electron',
  'rollbar',
  'raygun',
  'airbrake-js',
  'appcenter-crashes',
  'electron-log-uploader',
  'mixpanel',
  'mixpanel-browser',
  'amplitude-js',
  '@amplitude/analytics-node',
  'posthog-node',
  'posthog-js',
  'analytics-node',
  '@segment/analytics-node',
  'universal-analytics',
  'ga-lite',
  'matomo-tracker',
  'insight',
  'nodejs-insights',
  'applicationinsights',
  'newrelic',
  'datadog-metrics',
  'dd-trace',
  'elastic-apm-node',
  'opentelemetry-instrumentation-http',
  'electron-updater',
  'update-notifier',
  'preact-cli-telemetry',
])

/**
 * Scoped prefixes where every package under them reports.
 *
 * Kept separate from the exact-name set so the matching stays a *scope* check
 * rather than a substring one.
 */
export const REPORTER_SCOPES = ['@sentry/', '@bugsnag/', '@opentelemetry/', '@datadog/']

export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const

/**
 * Lifecycle scripts that are known, understood and accepted.
 *
 * An allow-list of *packages*, not of the behaviour: a new lifecycle script
 * anywhere else is a finding. `better-sqlite3` downloads a prebuilt native
 * binary, which is the mechanism this project depends on for the whole ABI
 * story — see `packages/desktop/scripts/fetch-native.mjs`.
 */
export const ACCEPTED_LIFECYCLE = new Set(['better-sqlite3', '@napi-rs/keyring'])

export interface DepFinding {
  kind: 'reporter' | 'lifecycle'
  name: string
  version: string
  detail: string
  path: readonly string[]
}

export function isReporter(name: string): boolean {
  if (REPORTERS.has(name)) return true
  return REPORTER_SCOPES.some((scope) => name.startsWith(scope))
}

export function audit(packages: readonly Package[]): DepFinding[] {
  const findings: DepFinding[] = []

  for (const pkg of packages) {
    if (isReporter(pkg.name)) {
      findings.push({
        kind: 'reporter',
        name: pkg.name,
        version: pkg.version,
        detail: 'sends data off the machine as its purpose',
        path: pkg.path,
      })
    }

    if (ACCEPTED_LIFECYCLE.has(pkg.name)) continue

    for (const script of LIFECYCLE_SCRIPTS) {
      const body = pkg.scripts?.[script]
      if (body === undefined) continue
      findings.push({
        kind: 'lifecycle',
        name: pkg.name,
        version: pkg.version,
        detail: `runs on install: ${script} = ${body}`,
        path: pkg.path,
      })
    }
  }

  return findings
}

/**
 * Flatten `npm ls --json` into a list, keeping the chain that brought each
 * package in.
 *
 * The chain is the useful half of the output. "`posthog-node` is in the tree" is
 * a fact nobody can act on; "`posthog-node` is here because of
 * `some-ui-kit → analytics-helper`" names the dependency to remove.
 */
export function flatten(tree: unknown, path: readonly string[] = []): Package[] {
  const node = tree as {
    name?: string
    version?: string
    dependencies?: Record<string, unknown>
    _scripts?: Record<string, string>
  } | null

  if (node === null || typeof node !== 'object') return []

  const packages: Package[] = []
  const here = node.name === undefined ? path : [...path, node.name]

  if (node.name !== undefined && path.length > 0) {
    packages.push({
      name: node.name,
      version: node.version ?? '0.0.0',
      path: here,
      scripts: node._scripts,
    })
  }

  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    const named = child as Record<string, unknown>
    packages.push(...flatten({ ...named, name: (named['name'] as string) ?? name }, here))
  }

  return packages
}

export function report(findings: readonly DepFinding[], scanned: number): string {
  if (findings.length === 0) {
    return [
      `Dependency audit: ${scanned} production packages`,
      '',
      'PASS — nothing in the shipped tree reports usage, crashes or updates,',
      '       and no unexpected package runs code at install time.',
    ].join('\n')
  }

  const lines = [`Dependency audit: ${scanned} production packages`, '', 'FAIL — constitution XI:', '']

  for (const f of findings) {
    lines.push(`  ${f.kind === 'reporter' ? 'reporter' : 'install script'}: ${f.name}@${f.version}`)
    lines.push(`    ${f.detail}`)
    lines.push(`    reached by ${f.path.join(' → ')}`)
    lines.push('')
  }

  return lines.join('\n')
}
