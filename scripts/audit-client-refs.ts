/**
 * The client-reference audit.
 *
 * Ground Control is developed against a real employer's Jira, and its own
 * development record is unusually specific about it. Published, a sentence
 * counting how much of a named client's backlog nobody had touched stops being
 * a note to self and becomes a public characterization of someone else's
 * business, made in the operator's name, without them being asked.
 *
 * (The original of that sentence quoted the real figures as an illustration,
 * and this audit caught its own docblock on the first run over a clean branch.
 * Worth leaving recorded: the example is always the last place anyone looks.)
 *
 * **Zero hits is the only pass**, on the same terms as the secret audit: there
 * is no "expected" occurrence to allow-list, because the moment one is allowed
 * the audit means nothing.
 *
 * ## Why the denylist is not in this file
 *
 * The obvious implementation writes the client's name into a constant, commits
 * it, and publishes the exact string it exists to suppress. So the terms live in
 * `.client-denylist`, which is gitignored — the audit is public, its subject is
 * not.
 *
 * **A missing denylist FAILS.** "Nothing was found" and "nothing was looked for"
 * produce an identical empty result and mean opposite things, and only one of
 * them is a pass. This is the same rule that made the egress recorder write a
 * marker when it loads.
 *
 * ## Why there is a shape scan too
 *
 * A denylist only finds what someone thought to list. `SITE_PATTERN` finds any
 * `*.atlassian.net` host that is not a known placeholder — a real site that
 * reached a fixture, a test, or a pasted stack trace, whether or not anyone
 * anticipated it. It is the counterpart of `CREDENTIAL_SHAPES` in the secret
 * audit: the arm that catches the instance nobody passed in.
 *
 * ## What the report does not print
 *
 * Never the matched term, and never the matched host. GitHub Actions logs on a
 * public repository are public, so an audit that prints what it found would
 * publish it on every run — including the runs that fail. File and line only;
 * whoever needs the value can open the file.
 */

export interface Finding {
  file: string
  /** What kind of match, never the matched text. */
  kind: string
  line: number
}

export interface Source {
  /** Display path. For a history scan, `<short-sha>:<path>`. */
  path: string
  text: string
}

export interface ClientAuditResult {
  denylistLoaded: boolean
  termCount: number
  sourcesScanned: number
  findings: Finding[]
}

/**
 * One term per line. `#` comments and blanks are dropped so the file can explain
 * itself to the next person without those lines becoming search terms.
 */
export function parseDenylist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * Jira sites this repository is allowed to name.
 *
 * Every one is invented. `acme` is the fixtures and tests throughout; `example`
 * is what the scrubber rewrites a real host to; `real` and `realcustomer` are
 * the *inputs* to the scrubber's own tests, which have to look like a real host
 * for the assertion to mean anything.
 */
export const PLACEHOLDER_SITES: ReadonlySet<string> = new Set([
  'acme',
  'example',
  'yourcompany',
  'real',
  'realcustomer',
  'site',
  'x',
])

/** Any Atlassian Cloud site host. The subdomain is captured so it can be judged. */
export const SITE_PATTERN = /\b([a-z0-9][a-z0-9-]*)\.atlassian\.net\b/gi

export function scanSource(source: Source, terms: readonly string[]): Finding[] {
  const findings: Finding[] = []
  const lines = source.text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lower = line.toLowerCase()

    for (const term of terms) {
      if (lower.includes(term.toLowerCase())) {
        findings.push({ file: source.path, kind: 'denylisted term', line: i + 1 })
        // One finding per line is enough to fail it; listing every term that
        // matched would leak how many distinct things are on the list.
        break
      }
    }

    // `lastIndex` is per-regex state and this one is global, so it is reset
    // rather than shared across lines.
    SITE_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SITE_PATTERN.exec(line)) !== null) {
      const subdomain = (match[1] ?? '').toLowerCase()
      if (!PLACEHOLDER_SITES.has(subdomain)) {
        findings.push({ file: source.path, kind: 'unrecognised Jira site', line: i + 1 })
        break
      }
    }
  }

  return findings
}

export function auditSources(sources: readonly Source[], denylist: readonly string[] | null): ClientAuditResult {
  // A null denylist still runs the shape scan — it is the arm that needs no
  // configuration — but the result can never pass, because coverage is partial
  // and saying so is the whole point.
  const terms = denylist ?? []
  const findings: Finding[] = []

  for (const source of sources) findings.push(...scanSource(source, terms))

  return {
    denylistLoaded: denylist !== null,
    termCount: terms.length,
    sourcesScanned: sources.length,
    findings,
  }
}

export const passed = (result: ClientAuditResult): boolean =>
  result.denylistLoaded && result.termCount > 0 && result.findings.length === 0

export function report(result: ClientAuditResult): string {
  const lines = [`Client-reference audit`, `  ${result.sourcesScanned} sources scanned`]

  if (!result.denylistLoaded) {
    lines.push('')
    lines.push('FAIL — no denylist was loaded, so nothing was searched for by name.')
    lines.push('       Only the Jira-site shape scan ran. An empty result here means')
    lines.push('       "nothing was looked for", which is not the same as "nothing is')
    lines.push('       there" and must never report the same way.')
    lines.push('')
    lines.push('       Create `.client-denylist` (gitignored, one term per line) or set')
    lines.push('       GRNDCTRL_CLIENT_DENYLIST to its contents.')
    if (result.findings.length > 0) {
      lines.push('')
      lines.push(`       The shape scan alone already found ${result.findings.length}:`)
      for (const f of result.findings.slice(0, 20)) {
        lines.push(`         ${f.file}:${f.line} — ${f.kind}`)
      }
    }
    return lines.join('\n')
  }

  lines.push(`  ${result.termCount} terms on the denylist`)
  lines.push('')

  if (result.termCount === 0) {
    lines.push('FAIL — the denylist is present but empty. See above: a search for')
    lines.push('       nothing finds nothing, and reports it as a pass.')
    return lines.join('\n')
  }

  if (result.findings.length === 0) {
    lines.push('PASS — no denylisted term, and no unrecognised Jira site, appears in')
    lines.push('       any source scanned.')
    return lines.join('\n')
  }

  lines.push(`FAIL — ${result.findings.length} occurrences. The value is deliberately not printed:`)
  lines.push('       this output reaches CI logs, which are public on a public repo.')
  lines.push('')
  for (const f of result.findings) {
    lines.push(`  ${f.file}:${f.line} — ${f.kind}`)
  }

  return lines.join('\n')
}
