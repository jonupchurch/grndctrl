import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAuthored, openMirror } from '../../src/store/open.js'

/**
 * Constitution XIII, enforced rather than trusted.
 *
 * The gate is that deleting the mirror must be safe. It is safe only while no
 * foreign key can reach from one database into the other — and in a join-heavy
 * codebase where nearly every query touches both, that is exactly the kind of
 * thing that gets violated by accident, one convenient `REFERENCES` at a time.
 */

let dir: string
let mirror: Database
let authored: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-sep-'))
  mirror = openMirror({ dir }).db
  authored = openAuthored({ dir }).db
})

afterEach(() => {
  mirror.close()
  authored.close()
  rmSync(dir, { recursive: true, force: true })
})

function tableNames(db: Database): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[]
  return rows.map((r) => r.name)
}

function foreignKeys(db: Database): { from: string; to: string }[] {
  return tableNames(db).flatMap((table) => {
    const fks = db.pragma(`foreign_key_list(${table})`) as { table: string }[]
    return fks.map((fk) => ({ from: table, to: fk.table }))
  })
}

describe('the two stores are structurally separate', () => {
  it('creates two distinct database files', () => {
    expect(tableNames(mirror)).toContain('tickets')
    expect(tableNames(authored)).toContain('notes')
  })

  it('shares no table name between them', () => {
    const shared = tableNames(mirror)
      .filter((t) => t !== 'schema_version')
      .filter((t) => tableNames(authored).includes(t))

    // A shared name is how a cross-file reference would quietly start resolving
    // against the wrong database.
    expect(shared).toEqual([])
  })

  it('has no foreign key in the mirror pointing outside the mirror', () => {
    const local = new Set(tableNames(mirror))
    const escaping = foreignKeys(mirror).filter((fk) => !local.has(fk.to))
    expect(escaping).toEqual([])
  })

  it('has no foreign key in the authored store pointing outside it', () => {
    const local = new Set(tableNames(authored))
    const escaping = foreignKeys(authored).filter((fk) => !local.has(fk.to))
    expect(escaping).toEqual([])
  })

  // The specific accident this guards against: someone adds
  // `REFERENCES tickets(key)` to `notes` because it is the obvious thing to
  // write, and a mirror rebuild starts deleting the user's notes.
  it('has no authored table referencing a mirrored table', () => {
    const mirrored = new Set(tableNames(mirror))
    const crossing = foreignKeys(authored).filter((fk) => mirrored.has(fk.to))
    expect(crossing).toEqual([])
  })

  it('tracks schema versions independently', () => {
    const mv = mirror.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }
    const av = authored.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }
    expect(mv.v).toBeGreaterThan(0)
    expect(av.v).toBeGreaterThan(0)
  })

  it('enables WAL and foreign key enforcement on both', () => {
    for (const db of [mirror, authored]) {
      expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal')
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    }
  })
})
