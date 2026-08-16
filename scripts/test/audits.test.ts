import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditDirectory,
  encodings,
  passed as secretsPassed,
  report as secretsReport,
} from '../audit-secrets.js'
import { audit as auditDeps, flatten, isReporter, report as depsReport } from '../audit-deps.js'
import {
  auditEgress,
  hostsFromLog,
  hostsInSource,
  readCapture,
  isAllowed,
  passed as egressPassed,
  report as egressReport,
} from '../audit-egress.js'
import {
  auditSources,
  parseDenylist,
  scanSource,
  passed as clientPassed,
  report as clientReport,
} from '../audit-client-refs.js'

/**
 * The privacy audits, audited (T169–T171).
 *
 * These three scripts are the only evidence for three of the promises this
 * product makes, and an audit that cannot fail is worse than no audit: it
 * converts an unknown into a false assurance, and nobody looks again. So every
 * test here plants something the audit is supposed to catch.
 */

const SENTINEL = 'ghp_SENTINELdonotpersist012345678901'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-audit-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the secret audit', () => {
  it('finds a credential written in plain text', () => {
    writeFileSync(join(dir, 'settings.json'), `{"token":"${SENTINEL}"}`)

    const result = auditDirectory(dir, SENTINEL)

    expect(secretsPassed(result)).toBe(false)
    expect(result.findings[0]?.encoding).toBe('utf-8')
    expect(result.findings[0]?.file).toBe('settings.json')
  })

  it('finds one several directories down', () => {
    // Chromium's storage is nested several levels under the data directory, and
    // it is the part of that directory this project does not write.
    const deep = join(dir, 'chromium', 'Network', 'Cache')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'data_1'), Buffer.from(`junk${SENTINEL}junk`))

    expect(secretsPassed(auditDirectory(dir, SENTINEL))).toBe(false)
  })

  it('finds a Jira credential inside a Basic auth header', () => {
    // The realistic leak, and the one a plain substring search misses entirely.
    // Jira Cloud authenticates with `Basic base64(email:token)`, so a cached
    // request header contains the token *only* in base64 — and an audit that
    // searched for the token itself would report a clean pass over a file with
    // the credential in it.
    const header = Buffer.from(`jon@example.com:${SENTINEL}`, 'utf8').toString('base64')
    writeFileSync(join(dir, 'cache_entry'), `Authorization: Basic ${header}\r\n`)

    expect(secretsPassed(auditDirectory(dir, SENTINEL))).toBe(true)

    const withIdentity = auditDirectory(dir, SENTINEL, 'jon@example.com')
    expect(secretsPassed(withIdentity)).toBe(false)
    expect(withIdentity.findings[0]?.encoding).toBe('base64(identity:secret)')
  })

  it('finds one written as UTF-16', () => {
    writeFileSync(join(dir, 'windows-artifact.bin'), Buffer.from(SENTINEL, 'utf16le'))

    const result = auditDirectory(dir, SENTINEL)
    expect(result.findings.map((f) => f.encoding)).toContain('utf-16le')
  })

  it('finds a credential nobody thought to pass in', () => {
    // The main scan can only find the secret it was given. A second
    // connection's token, or a colleague's pasted into a note, is exactly the
    // thing an audit run with one value would miss.
    writeFileSync(join(dir, 'notes.db'), 'body: use ghp_abcdefghij0123456789ABCDEFGHIJ012345 for now')

    const result = auditDirectory(dir, 'something-else-entirely')

    expect(result.findings).toEqual([])
    expect(secretsPassed(result)).toBe(false)
    expect(result.shaped[0]?.encoding).toBe('github personal access token')
  })

  it('passes a directory that holds only handles', () => {
    writeFileSync(join(dir, 'mirror.db'), 'credential_ref: grndctrl/jira-1')
    writeFileSync(join(dir, 'handshake.json'), '{"port":51234,"token":"loopback-only"}')

    expect(secretsPassed(auditDirectory(dir, SENTINEL))).toBe(true)
  })

  it('never prints the credential it is hunting for', () => {
    writeFileSync(join(dir, 'leak.txt'), SENTINEL)

    const text = secretsReport(auditDirectory(dir, SENTINEL))

    // A report that quotes the value turns every log, terminal scrollback and
    // pasted bug report into a second copy of the leak.
    expect(text).not.toContain(SENTINEL)
    expect(text).toContain('leak.txt')
    expect(text).toContain('FAIL')
  })

  it('reports files it could not read rather than counting them as clean', () => {
    const result = auditDirectory(dir, SENTINEL)
    // Nothing unreadable here, but the report must have somewhere to say so —
    // a gap in coverage is not a pass, and the shape of the result is what
    // makes that sayable.
    expect(result).toHaveProperty('unreadable')
    expect(result.filesScanned).toBe(0)
  })

  it('derives the encodings it claims to', () => {
    const names = encodings('abc', 'me@example.com').map((e) => e.name)
    expect(names).toEqual([
      'utf-8',
      'utf-16le',
      'base64',
      'percent-encoded',
      'base64(identity:secret)',
    ])
  })
})

describe('the dependency audit', () => {
  const pkg = (name: string, scripts?: Record<string, string>) => ({
    name,
    version: '1.0.0',
    path: ['root', name],
    scripts,
  })

  it('catches a reporter by exact name and by scope', () => {
    expect(isReporter('posthog-node')).toBe(true)
    expect(isReporter('@sentry/electron')).toBe(true)
    expect(isReporter('@opentelemetry/sdk-node')).toBe(true)
  })

  it('does not catch a package that merely reads like one', () => {
    // Substring matching would be the tempting implementation and it would fail
    // here — at which point the fix is to weaken the rule, and the audit stops
    // meaning anything.
    expect(isReporter('matomo-css-parser')).toBe(false)
    expect(isReporter('posthog-schema-types')).toBe(false)
    expect(isReporter('sentry-like-name')).toBe(false)
  })

  it('names the chain that brought a reporter in', () => {
    const findings = auditDeps([
      { name: 'posthog-node', version: '4.0.0', path: ['grndctrl', 'some-ui-kit', 'posthog-node'] },
    ])

    // "posthog-node is in the tree" is a fact nobody can act on. The chain names
    // the dependency to remove.
    expect(depsReport(findings, 1)).toContain('grndctrl → some-ui-kit → posthog-node')
  })

  it('catches an install script', () => {
    const findings = auditDeps([pkg('helpful-tool', { postinstall: 'node phone-home.js' })])

    expect(findings).toHaveLength(1)
    expect(findings[0]?.kind).toBe('lifecycle')
    expect(findings[0]?.detail).toContain('phone-home.js')
  })

  it('accepts the two install scripts this project depends on', () => {
    // `better-sqlite3` fetches a prebuilt binary, which is the mechanism the
    // whole ABI story rests on. Accepted by name rather than by behaviour, so a
    // *new* one anywhere else is still a finding.
    const findings = auditDeps([
      pkg('better-sqlite3', { install: 'prebuild-install || node-gyp rebuild' }),
      pkg('@napi-rs/keyring', { postinstall: 'napi-postinstall' }),
    ])

    expect(findings).toEqual([])
  })

  it('passes a clean tree, and says how much it looked at', () => {
    const findings = auditDeps([pkg('zod'), pkg('react')])

    expect(findings).toEqual([])
    expect(depsReport(findings, 2)).toContain('PASS')
    expect(depsReport(findings, 2)).toContain('2 production packages')
  })

  it('flattens an npm ls tree, keeping each package’s route in', () => {
    const flat = flatten({
      name: 'grndctrl-monorepo',
      dependencies: {
        a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } },
      },
    })

    expect(flat.map((p) => p.path.join('/'))).toEqual([
      'grndctrl-monorepo/a',
      'grndctrl-monorepo/a/b',
    ])
  })
})

describe('the egress audit', () => {
  const allowed = { providers: ['acme.atlassian.net', 'github.com'], firstRun: false }

  /** A recorder log, built from lines rather than written as one escaped string. */
  const NL = String.fromCharCode(10)
  const log = (...lines: string[]) => ['# recorder loaded in pid 1', ...lines, ''].join(NL)

  it('accepts a configured provider and a subdomain of it', () => {
    expect(isAllowed('acme.atlassian.net', allowed)).toBe(true)
    expect(isAllowed('api.github.com', allowed)).toBe(true)
  })

  it('does not accept a host that merely ends with an allowed one', () => {
    // The classic way an allow-list stops being one. `endsWith('github.com')`
    // accepts `evil-github.com`.
    expect(isAllowed('evil-github.com', allowed)).toBe(false)
    expect(isAllowed('notatlassian.net', allowed)).toBe(false)
  })

  it('allows the runtime download only when a first run is expected', () => {
    expect(isAllowed('objects.githubusercontent.com', allowed)).toBe(false)
    expect(isAllowed('objects.githubusercontent.com', { ...allowed, firstRun: true })).toBe(true)
  })

  it('always allows the loopback API, which never leaves the machine', () => {
    expect(isAllowed('127.0.0.1', allowed)).toBe(true)
    expect(isAllowed('localhost', allowed)).toBe(true)
  })

  it('catches a telemetry host contacted during a session', () => {
    const result = auditEgress(
      readCapture(log('api.github.com', 'in.telemetry.example')),
      new Map(),
      allowed,
    )

    expect(egressPassed(result)).toBe(false)
    expect(result.unexpectedContacted).toEqual(['in.telemetry.example'])
  })

  it('catches a destination compiled in but never reached', () => {
    // The half a capture cannot do. A URL that ships but has not fired yet is
    // still a destination, and a thirty-minute session is not evidence it will
    // not.
    const compiled = new Map([['updates.example.com', ['dist/main/index.cjs']]])
    const result = auditEgress(readCapture(log()), compiled, allowed)

    expect(egressPassed(result)).toBe(false)
    expect(result.unexpectedCompiled[0]?.host).toBe('updates.example.com')
    expect(egressReport(result)).toContain('dist/main/index.cjs')
  })

  it('ignores a schema URL that nothing fetches', () => {
    const compiled = new Map([['json.schemastore.org', ['tsconfig.json']]])
    expect(egressPassed(auditEgress(readCapture(log()), compiled, allowed))).toBe(true)
  })

  it('fails when the recorder never ran, rather than passing on no evidence', () => {
    // The failure that looks exactly like the strongest possible pass: nothing
    // was recorded, so nothing was unexpected. "Nothing was contacted" and
    // "nothing was watching" are opposite conclusions from an identical empty
    // list, which is the shape of defect this project keeps finding.
    const result = auditEgress(readCapture(''), new Map(), allowed)

    expect(egressPassed(result)).toBe(false)
    expect(egressReport(result)).toContain('the recorder never ran')
  })

  it('passes a session where the recorder ran and saw nothing', () => {
    // Correct for a session with no usable credentials — the seeded scratch
    // directory the e2e suite uses. Distinguishable from the case above only by
    // the recorder's own marker.
    const capture = readCapture(log('# recorder loaded in pid 2'))

    expect(capture.loaded).toBe(true)
    expect(capture.processes).toBe(2)

    const result = auditEgress(capture, new Map(), allowed)
    expect(egressPassed(result)).toBe(true)
    expect(egressReport(result)).toContain('saw no')
  })

  it('reads hosts from a recorder log, ignoring its marker lines', () => {
    const hosts = hostsFromLog('# recorder loaded in pid 123\napi.github.com\nAPI.GITHUB.COM\n\n')
    expect(hosts).toEqual(['api.github.com'])
  })

  it('finds absolute URLs in a bundle and drops the port', () => {
    const hosts = hostsInSource(
      'fetch("https://api.github.com/graphql");const u="http://127.0.0.1:51234/op"',
    )
    expect(hosts).toEqual(['127.0.0.1', 'api.github.com'])
  })
})

describe('the client-reference audit', () => {
  const DENY = ['contoso', 'fabrikam backlog']

  /**
   * A host that is *not* on the placeholder allow-list, assembled rather than
   * written.
   *
   * This file is scanned by the very audit it tests, so a literal here is a
   * literal in the tree — and the first version of these tests failed the gate
   * on its own source. Adding the host to `PLACEHOLDER_SITES` instead would put
   * a hole in the rule to make its test pass, which is the wrong direction.
   * Joining the halves keeps the assertion honest and the file clean.
   */
  const UNKNOWN_SITE = ['northwind.atlassian', '.net'].join('')

  it('catches a denylisted term regardless of case', () => {
    const result = auditSources([{ path: 'STATUS.md', text: 'synced against CONTOSO today' }], DENY)
    expect(clientPassed(result)).toBe(false)
    expect(result.findings).toEqual([{ file: 'STATUS.md', kind: 'denylisted term', line: 1 }])
  })

  it('catches a real Jira site the denylist never mentioned', () => {
    // The arm that matters: nobody listed this host, and it is still caught.
    const result = auditSources([{ path: 'notes.md', text: `see https://${UNKNOWN_SITE}/browse/AB-1` }], DENY)
    expect(clientPassed(result)).toBe(false)
    expect(result.findings[0]?.kind).toBe('unrecognised Jira site')
  })

  it('leaves the invented placeholder sites alone', () => {
    // The control. These are all over the fixtures and tests, and a gate that
    // fires on them would be turned off within a day.
    const text = 'acme.atlassian.net example.atlassian.net real.atlassian.net'
    expect(scanSource({ path: 'keys.test.ts', text }, DENY)).toEqual([])
  })

  it('fails when no denylist was loaded, even with nothing found', () => {
    // "Nothing was found" and "nothing was looked for" are the same empty list
    // and opposite facts. Only one of them is a pass.
    const result = auditSources([{ path: 'README.md', text: 'entirely clean' }], null)
    expect(result.findings).toEqual([])
    expect(clientPassed(result)).toBe(false)
    expect(clientReport(result)).toContain('nothing was searched for by name')
  })

  it('fails when the denylist is present but empty', () => {
    const result = auditSources([{ path: 'README.md', text: 'entirely clean' }], [])
    expect(clientPassed(result)).toBe(false)
    expect(clientReport(result)).toContain('present but empty')
  })

  it('never prints the matched term or the matched host', () => {
    // CI logs are public on a public repo, so a report that names what it found
    // publishes it on every failing run -- which is every run until it is fixed.
    const result = auditSources(
      [{ path: 'STATUS.md', text: `contoso, at ${UNKNOWN_SITE}, has a fabrikam backlog` }],
      DENY,
    )
    const text = clientReport(result)
    expect(text).toContain('STATUS.md:1')
    expect(text).not.toContain('contoso')
    expect(text).not.toContain(UNKNOWN_SITE)
    expect(text).not.toContain('fabrikam')
  })

  it('drops comments and blank lines from the denylist file', () => {
    expect(parseDenylist('# a comment\n\n  contoso  \n\n# another\nfabrikam\n')).toEqual([
      'contoso',
      'fabrikam',
    ])
  })

  it('passes on a clean tree with a loaded denylist', () => {
    const result = auditSources(
      [{ path: 'README.md', text: 'configure acme.atlassian.net and go' }],
      DENY,
    )
    expect(clientPassed(result)).toBe(true)
    expect(clientReport(result)).toContain('PASS')
  })
})
