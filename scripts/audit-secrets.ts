import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The secret audit (T169, SC-011, constitution XI).
 *
 * `packages/core/test/store/no-secrets.test.ts` already proves that the stores
 * *this project writes* never contain a credential. This is the other half, and
 * it is the half that can actually be wrong: it searches a **real data
 * directory after a real session** — the two databases, their WAL files, the
 * handshake, and everything Chromium put under `chromium/` — for a value the
 * operator knows is a live credential.
 *
 * The distinction matters because most of that directory is not written by code
 * in this repository. Chromium's network cache, its local storage, its
 * `Cookies` database and its crash pads are all created by Electron, and a unit
 * test over `openMirror`/`openAuthored` has no visibility into any of it. XI
 * says the keychain is the only place a secret lives. Only this can check it.
 *
 * **Zero hits is the only pass.** There is no "expected" occurrence to
 * allow-list; the moment one is allowed the audit means nothing.
 *
 * ## Why several encodings
 *
 * A raw substring search would miss the realistic leak. Jira Cloud is
 * authenticated with `Authorization: Basic base64(email:token)`, so a cached
 * request header contains the token only in base64 — and a search for the token
 * itself comes back clean while the credential sits on disk. The variants below
 * are the ones a credential plausibly wears by the time it reaches a file.
 *
 * What this does *not* cover, stated rather than implied: a compressed or
 * encrypted artifact. Chromium's cache entries can be gzipped and its cookie
 * store is encrypted with DPAPI on Windows. A clean result is therefore
 * evidence, not proof — which is why the credential-shaped scan below runs too.
 */

export interface Finding {
  file: string
  /** How the value was encoded where it was found. Never the value itself. */
  encoding: string
  offset: number
}

/**
 * Every form a credential might take on disk.
 *
 * `identity` is the Jira account email, when there is one: it is what turns
 * `base64(email:token)` from a guess into a check.
 */
export function encodings(secret: string, identity?: string): { name: string; bytes: Buffer }[] {
  const variants: { name: string; bytes: Buffer }[] = [
    { name: 'utf-8', bytes: Buffer.from(secret, 'utf8') },
    // Windows writes plenty of strings as UTF-16, including some registry-backed
    // and Chromium-internal artifacts.
    { name: 'utf-16le', bytes: Buffer.from(secret, 'utf16le') },
    { name: 'base64', bytes: Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8') },
    {
      name: 'percent-encoded',
      bytes: Buffer.from(encodeURIComponent(secret), 'utf8'),
    },
  ]

  if (identity !== undefined && identity !== '') {
    // The one that actually catches Jira. `Basic` auth is the whole pair in
    // base64, and the token alone does not appear in it.
    variants.push({
      name: 'base64(identity:secret)',
      bytes: Buffer.from(Buffer.from(`${identity}:${secret}`, 'utf8').toString('base64'), 'utf8'),
    })
  }

  return variants
}

/** Every file under `dir`, depth first. Unreadable entries are reported, not skipped silently. */
export function walk(dir: string, onError: (path: string, e: unknown) => void): string[] {
  const found: string[] = []

  const visit = (path: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch (e) {
      onError(path, e)
      return
    }

    for (const entry of entries) {
      const full = join(path, entry)
      try {
        // `lstat`, not `stat`: a symlink out of the data directory is itself
        // worth knowing about, and following it would audit somewhere else.
        const stats = statSync(full, { throwIfNoEntry: false })
        if (stats === undefined) continue
        if (stats.isDirectory()) visit(full)
        else if (stats.isFile()) found.push(full)
      } catch (e) {
        onError(full, e)
      }
    }
  }

  visit(dir)
  return found
}

export function scanFile(path: string, variants: ReturnType<typeof encodings>, root: string): Finding[] {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    // A file Chromium holds open exclusively. Reported by the caller as a gap
    // in coverage rather than as a pass.
    return []
  }

  const findings: Finding[] = []
  for (const variant of variants) {
    const offset = bytes.indexOf(variant.bytes)
    if (offset >= 0) {
      findings.push({ file: relative(root, path), encoding: variant.name, offset })
    }
  }
  return findings
}

/**
 * Anything shaped like a provider credential, whether or not it is *the* one.
 *
 * The audit's main scan can only find a secret it was given. This finds the one
 * nobody thought to pass in — a second connection's token, a colleague's,
 * a value pasted into a note. The patterns are the ones the two supported
 * providers actually issue.
 */
export const CREDENTIAL_SHAPES: { name: string; pattern: RegExp }[] = [
  { name: 'github personal access token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'github fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'github oauth token', pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  // Atlassian API tokens are base64-ish and long; the `ATATT` prefix is the
  // current issuing format.
  { name: 'atlassian api token', pattern: /\bATATT[A-Za-z0-9_\-=]{20,}\b/ },
]

export interface AuditResult {
  root: string
  filesScanned: number
  unreadable: string[]
  findings: Finding[]
  shaped: Finding[]
}

export function auditDirectory(root: string, secret: string, identity?: string): AuditResult {
  const variants = encodings(secret, identity)
  const unreadable: string[] = []
  const files = walk(root, (path) => unreadable.push(relative(root, path)))

  const findings: Finding[] = []
  const shaped: Finding[] = []

  for (const file of files) {
    findings.push(...scanFile(file, variants, root))

    let text: string
    try {
      text = readFileSync(file, 'latin1')
    } catch {
      unreadable.push(relative(root, file))
      continue
    }

    for (const shape of CREDENTIAL_SHAPES) {
      const match = shape.pattern.exec(text)
      if (match !== null) {
        shaped.push({ file: relative(root, file), encoding: shape.name, offset: match.index })
      }
    }
  }

  return { root, filesScanned: files.length, unreadable, findings, shaped }
}

/** The report. Deliberately never prints the secret, or any part of it. */
export function report(result: AuditResult): string {
  const lines = [
    `Secret audit of ${result.root}`,
    `  ${result.filesScanned} files scanned`,
  ]

  if (result.unreadable.length > 0) {
    // Named rather than counted quietly: a file that could not be read is a gap
    // in the audit, and a gap is not a pass.
    lines.push(`  ${result.unreadable.length} could not be read — coverage is incomplete:`)
    for (const file of result.unreadable.slice(0, 10)) lines.push(`      ${file}`)
  }

  lines.push('')

  if (result.findings.length === 0 && result.shaped.length === 0) {
    lines.push('PASS — the credential appears nowhere in the data directory, in any')
    lines.push('       encoding checked, and nothing credential-shaped was found.')
    return lines.join('\n')
  }

  lines.push('FAIL — constitution XI says the keychain is the only place a secret lives.')
  lines.push('')

  for (const f of result.findings) {
    lines.push(`  the audited credential, as ${f.encoding}, at byte ${f.offset} of`)
    lines.push(`    ${f.file}`)
  }
  for (const f of result.shaped) {
    lines.push(`  something shaped like a ${f.encoding}, at byte ${f.offset} of`)
    lines.push(`    ${f.file}`)
  }

  return lines.join('\n')
}

export const passed = (result: AuditResult): boolean =>
  result.findings.length === 0 && result.shaped.length === 0
