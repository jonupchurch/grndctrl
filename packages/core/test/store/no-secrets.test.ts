import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef, credentialRefString, inMemoryKeychain } from '../../src/auth/keychain.js'
import { settingsStore } from '../../src/services/settings.js'
import { openAuthored, openMirror } from '../../src/store/open.js'

/**
 * Constitution XI and SC-011: a credential must never be written anywhere a
 * backup tool, a screenshot, or a `git add .` could pick it up.
 *
 * The keychain is the only place a secret lives. This asserts the other half —
 * that nothing else in the app's data directory ever holds one. It is cheap to
 * run and it catches the realistic mistake: someone stores the token on the
 * connection row "just for now" because the keychain lookup is one call away.
 */

const SENTINEL = 'ghp_SENTINEL_do_not_persist_2f8a1c'

let dir: string
let mirror: Database
let authored: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-secrets-'))
  mirror = openMirror({ dir }).db
  authored = openAuthored({ dir }).db
})

afterEach(() => {
  mirror.close()
  authored.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Every value in every column of every table, as strings. */
function everyStoredValue(db: Database): string[] {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]

  return tables.flatMap((t) => {
    const rows = db.prepare(`SELECT * FROM "${t.name}"`).all() as Record<string, unknown>[]
    return rows.flatMap((row) => Object.values(row).map((v) => (v === null ? '' : String(v))))
  })
}

describe('no credential reaches disk', () => {
  it('stores a lookup handle on the connection row, never the secret', () => {
    const keychain = inMemoryKeychain()
    const ref = credentialRef('c1')
    keychain.set(ref, SENTINEL)

    mirror
      .prepare(
        `INSERT INTO connections (id, kind, site_or_host, account_label, credential_ref)
         VALUES ('c1', 'github', 'github.com', 'work', ?)`,
      )
      .run(credentialRefString(ref))

    const stored = mirror.prepare('SELECT credential_ref FROM connections').get() as {
      credential_ref: string
    }

    expect(stored.credential_ref).toBe('grndctrl/c1')
    expect(keychain.get(ref)).toBe(SENTINEL)
    expect(everyStoredValue(mirror)).not.toContain(SENTINEL)
  })

  it('has the sentinel in no column of either database', () => {
    const keychain = inMemoryKeychain()
    keychain.set(credentialRef('c1'), SENTINEL)

    mirror
      .prepare(
        `INSERT INTO connections (id, kind, site_or_host, account_label, credential_ref)
         VALUES ('c1', 'jira', 'acme.atlassian.net', 'work', 'grndctrl/c1')`,
      )
      .run()

    settingsStore(authored).update({ appearance: 'dark' })
    authored
      .prepare(
        `INSERT INTO projects (id, code, name, jira_project_key, ticket_key_pattern)
         VALUES ('p1', 'MERC', 'Mercury', 'MERC', '(MERC-\\d+)')`,
      )
      .run()

    for (const db of [mirror, authored]) {
      const hit = everyStoredValue(db).find((v) => v.includes(SENTINEL))
      expect(hit).toBeUndefined()
    }
  })

  /**
   * The stronger form. A column scan only sees live rows — a secret written and
   * then deleted still sits in a database page until SQLite reuses it, and a
   * backup tool copies the file, not the query result.
   */
  it('has the sentinel in no byte of any file in the data directory', () => {
    const keychain = inMemoryKeychain()
    keychain.set(credentialRef('c1'), SENTINEL)

    mirror
      .prepare(
        `INSERT INTO connections (id, kind, site_or_host, account_label, credential_ref)
         VALUES ('c1', 'github', 'github.com', 'work', 'grndctrl/c1')`,
      )
      .run()
    settingsStore(authored).update({ mineOnly: true })

    // Flush WAL so the check sees what a backup tool would see.
    mirror.pragma('wal_checkpoint(TRUNCATE)')
    authored.pragma('wal_checkpoint(TRUNCATE)')

    const offenders = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => readFileSync(path).includes(SENTINEL))

    expect(offenders).toEqual([])
  })

  // Guards the inverse mistake: a test that passes because the sentinel was
  // never anywhere near the database in the first place.
  it('would actually detect a secret if one were written', () => {
    authored
      .prepare(
        `INSERT INTO projects (id, code, name, jira_project_key, ticket_key_pattern)
         VALUES ('leak', 'LEAK', ?, 'LEAK', '(LEAK-\\d+)')`,
      )
      .run(`token is ${SENTINEL}`)

    expect(everyStoredValue(authored).some((v) => v.includes(SENTINEL))).toBe(true)

    authored.pragma('wal_checkpoint(TRUNCATE)')
    const offenders = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => readFileSync(path).includes(SENTINEL))

    expect(offenders.length).toBeGreaterThan(0)
  })
})
