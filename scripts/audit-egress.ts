import { readFileSync } from 'node:fs'

/**
 * The egress audit (T170, SC-010, constitution XI).
 *
 * The promise: over a session, this application reaches the operator's own
 * providers and nothing else — no telemetry, no analytics, no crash reporting,
 * no update check.
 *
 * ## Where the risk actually is
 *
 * Not in the renderer. `main/security.ts` gives the page `connect-src 'none'`
 * and allows only `file:` loads, so a compromised renderer has no channel at
 * all, and `test/e2e/isolation.spec.ts` proves it. The window does not even
 * fetch provider avatars — the design uses initials, so nothing on that page
 * has a reason to reach the network.
 *
 * The risk is the **main process**, which holds the credentials and does the
 * fetching, and a dependency inside it that decides to be helpful. So this
 * audits two things that fail differently:
 *
 * - **Statically**, every absolute URL in the built artifacts. This catches a
 *   destination that has been compiled in but not yet reached, which a capture
 *   of any finite length cannot.
 * - **Dynamically**, every host actually contacted during a session, recorded
 *   by `egress-recorder.cjs`. This catches a URL built at runtime from parts,
 *   which the static scan cannot see.
 *
 * Neither is sufficient. Both are cheap.
 */

export interface AllowedHosts {
  /** Hosts the operator has configured. One provider now: their Jira site. */
  providers: readonly string[]
  /** Whether the first-run runtime download is expected in this window. */
  firstRun: boolean
}

/**
 * What a provider host is, absent a `--providers` flag.
 *
 * `github.com` was here beside `atlassian.net` and left with the code host
 * (006/T056). It is **not** gone from this file: see `FIRST_RUN_ALLOWED` below,
 * and read that comment before touching either list. The two entries look like
 * duplicates of one idea and are two different ideas, which is the whole reason
 * this constant is named and exported rather than written inline at the call
 * site where it used to live.
 */
export const DEFAULT_PROVIDER_HOSTS: readonly string[] = ['atlassian.net']

/**
 * Hosts that are always permitted, and why each one is.
 *
 * `objects.githubusercontent.com` is not an oversight and is worth naming: a
 * GitHub release asset URL answers with a redirect to it, so a capture of a
 * first run sees a host that appears nowhere in the source. An auditor who did
 * not expect it would either report a false failure or, worse, widen the
 * allow-list without finding out what it was.
 */
export const ALWAYS_ALLOWED: Record<string, string> = {
  '127.0.0.1': 'the loopback API that grndctrl-mcp connects to — never leaves the machine',
  '::1': 'the loopback API, IPv6',
  localhost: 'the loopback API',
}

/**
 * **`github.com` here is not the code host, and removing it breaks every fresh
 * install.**
 *
 * Worth stating flatly, because 006 removed the GitHub provider and this looks
 * exactly like a line that should have gone with it. It did not. The launcher
 * downloads the Electron runtime from a GitHub release on first launch — the
 * binary is not in the npm package — so a capture of a first run contacts
 * `github.com` and then `objects.githubusercontent.com`, which is where a
 * release asset URL redirects.
 *
 * What left is `github.com` as a **provider** host, which is a different
 * permission with a different meaning: it allowed `api.github.com`, by the
 * subdomain rule below, for the whole session. Nothing fetches from there any
 * more, so a session that contacts it is now a finding.
 *
 * The symptom of deleting these two would appear nowhere near the cause: the
 * audit would pass on every developer machine, where the runtime is already
 * cached, and fail only on a clean one — which is the machine a release is
 * verified on.
 */
export const FIRST_RUN_ALLOWED: Record<string, string> = {
  'github.com': 'the Electron runtime download (T161), once, on first launch',
  'objects.githubusercontent.com': 'where a GitHub release asset URL redirects to',
}

export function isAllowed(host: string, allowed: AllowedHosts): boolean {
  const lower = host.toLowerCase()

  if (lower in ALWAYS_ALLOWED) return true
  if (allowed.firstRun && lower in FIRST_RUN_ALLOWED) return true

  return allowed.providers.some((provider) => {
    const p = provider.toLowerCase()
    // Exact host, or a subdomain of it. `endsWith(p)` alone would accept
    // `evil-github.com` for `github.com`, which is the classic way an allow-list
    // stops being one.
    return lower === p || lower.endsWith(`.${p}`)
  })
}

/** Hosts contacted, from the recorder's log. One host per line, deduplicated. */
export function hostsFromLog(text: string): string[] {
  return readCapture(text).hosts
}

export interface Capture {
  /**
   * Did the recorder actually run?
   *
   * The distinction this whole product keeps rediscovering: an empty result and
   * a failed one must not share a representation. "Nothing was contacted" and
   * "nothing was watching" produce the same empty host list and mean opposite
   * things — one is the strongest possible pass, the other is no evidence at
   * all. The recorder writes a `# recorder loaded in pid N` marker for exactly
   * this reason.
   */
  loaded: boolean
  /** How many processes it loaded into. Electron is a dozen; Node is one. */
  processes: number
  hosts: string[]
}

export function readCapture(text: string): Capture {
  const hosts = new Set<string>()
  let processes = 0

  for (const line of text.split('\n')) {
    const entry = line.trim()
    if (entry === '') continue
    if (entry.startsWith('#')) {
      if (entry.includes('recorder loaded')) processes += 1
      continue
    }
    hosts.add(entry.toLowerCase())
  }

  return { loaded: processes > 0, processes, hosts: [...hosts].sort() }
}

/** Absolute URLs compiled into a build artifact. */
export function hostsInSource(contents: string): string[] {
  const hosts = new Set<string>()
  for (const match of contents.matchAll(/\bhttps?:\/\/([A-Za-z0-9._-]+(?::\d+)?)/g)) {
    const host = match[1]
    if (host === undefined) continue
    // Strip a port: the audit is about *where*, not about which service on it.
    hosts.add(host.replace(/:\d+$/, '').toLowerCase())
  }
  return [...hosts].sort()
}

export function hostsInFiles(files: readonly string[]): Map<string, string[]> {
  const byHost = new Map<string, string[]>()

  for (const file of files) {
    let contents: string
    try {
      contents = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const host of hostsInSource(contents)) {
      const seen = byHost.get(host) ?? []
      if (!seen.includes(file)) seen.push(file)
      byHost.set(host, seen)
    }
  }

  return byHost
}

/**
 * Hosts that are documentation rather than destinations.
 *
 * A schema URL in a JSON file and a licence URL in a comment are not egress —
 * nothing fetches them. Kept short and exact on purpose: the moment this list
 * grows a wildcard, the static half of the audit stops meaning anything.
 */
export const NOT_DESTINATIONS = new Set([
  'json.schemastore.org',
  // The SVG namespace, written into every `<svg>` React renders. A namespace
  // identifier that happens to be spelled as a URL; nothing resolves it.
  'www.w3.org',
  // React's minified-error decoder. It appears exactly once, as the literal
  // `https://react.dev/errors/`, concatenated into an error *message* so a
  // developer can look the code up. Nothing fetches it — and the renderer could
  // not if it tried: `main/security.ts` gives that page `connect-src 'none'`.
  //
  // Checked rather than assumed. This entry is the one that proves the list is
  // dangerous: the first real run of this audit reported `react.dev`, and the
  // tempting response was to widen the rule until it went quiet.
  'react.dev',
  'schemas.microsoft.com',
  'spdx.org',
  'opensource.org',
  'keepachangelog.com',
  'semver.org',
  'unlicense.org',
  'www.apache.org',
])

export interface EgressResult {
  allowed: AllowedHosts
  capture: Capture
  contacted: readonly string[]
  compiled: ReadonlyMap<string, readonly string[]>
  unexpectedContacted: readonly string[]
  unexpectedCompiled: readonly { host: string; files: readonly string[] }[]
}

export function auditEgress(
  capture: Capture | readonly string[],
  compiled: ReadonlyMap<string, readonly string[]>,
  allowed: AllowedHosts,
): EgressResult {
  const resolved: Capture = Array.isArray(capture)
    ? { loaded: capture.length > 0, processes: 0, hosts: [...capture] }
    : (capture as Capture)

  const contacted = resolved.hosts
  const unexpectedContacted = contacted.filter((host) => !isAllowed(host, allowed))

  const unexpectedCompiled = [...compiled.entries()]
    .filter(([host]) => !isAllowed(host, allowed) && !NOT_DESTINATIONS.has(host))
    .map(([host, files]) => ({ host, files }))

  return { allowed, capture: resolved, contacted, compiled, unexpectedContacted, unexpectedCompiled }
}

/**
 * A pass needs three things, and the third is the one that is easy to forget:
 * the recorder has to have been watching. A capture nobody took is not a clean
 * capture.
 */
export const passed = (result: EgressResult): boolean =>
  result.capture.loaded &&
  result.unexpectedContacted.length === 0 &&
  result.unexpectedCompiled.length === 0

export function report(result: EgressResult): string {
  const lines = [
    'Egress audit',
    `  provider hosts configured: ${result.allowed.providers.join(', ') || '(none)'}`,
    `  first-run download expected: ${result.allowed.firstRun ? 'yes' : 'no'}`,
    `  hosts contacted during the session: ${result.contacted.length}`,
    `  hosts compiled into the build: ${result.compiled.size}`,
    '',
  ]

  if (!result.capture.loaded) {
    // The failure that would otherwise look exactly like the strongest possible
    // pass. No recorder means no evidence, not clean evidence.
    lines.push('FAIL — the recorder never ran, so nothing was watching. Load it with')
    lines.push('       NODE_OPTIONS="--require scripts/egress-recorder.cjs" and set')
    lines.push('       GRNDCTRL_EGRESS_LOG. A capture nobody took is not a clean capture.')
    lines.push('')
  } else if (result.contacted.length === 0) {
    lines.push(`NOTE — the recorder ran in ${result.capture.processes} processes and saw no`)
    lines.push('       outbound request at all. That is the correct result for a session')
    lines.push('       with no usable credentials; over a session that actually synced, it')
    lines.push('       means the session did nothing rather than that nothing leaked.')
    lines.push('')
  }

  if (passed(result)) {
    lines.push('PASS — every destination is a configured provider, the loopback API,')
    lines.push('       or the one-time runtime download.')
    return lines.join('\n')
  }

  lines.push('FAIL — constitution XI: no telemetry, analytics, crash reporting or')
  lines.push('       phoning home.')
  lines.push('')

  for (const host of result.unexpectedContacted) {
    lines.push(`  contacted: ${host}`)
  }
  for (const { host, files } of result.unexpectedCompiled) {
    lines.push(`  compiled in: ${host}`)
    for (const file of files) lines.push(`      ${file}`)
  }

  return lines.join('\n')
}
