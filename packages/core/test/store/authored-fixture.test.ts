import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTHORED_MIGRATIONS } from '../../src/store/authored/migrations.js'
import { migrate } from '../../src/store/migrate.js'
import { AUTHORED_FIXTURE, seedAuthored030, SETTINGS_0_3_0 } from './fixtures/authored-0.3.0.js'

/**
 * Proves the 0.3.0 fixture still loads.
 *
 * Without this, the fixture is a file nothing runs until the migration that
 * consumes it is written — and by then it would be adjusted to fit the
 * migration rather than the other way round. A fixture is only a baseline while
 * something independent keeps it honest.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-authored-fixture-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const open = (): Database.Database => {
  const db = new Database(join(dir, 'authored.db'))
  db.pragma('foreign_keys = ON')
  migrate(
    db,
    AUTHORED_MIGRATIONS.filter((m) => m.version <= 1),
    () => '2026-08-14T12:00:00Z',
  )
  seedAuthored030(db)
  return db
}

const ids = (db: Database.Database, table: string, column: string): string[] =>
  (db.prepare(`SELECT "${column}" k FROM "${table}" ORDER BY "${column}"`).all() as { k: string }[]).map(
    (r) => r.k,
  )

describe('the 0.3.0 authored fixture', () => {
  it('seeds every row it names', () => {
    const db = open()

    expect(ids(db, 'projects', 'id')).toEqual([...AUTHORED_FIXTURE.projects].sort())
    expect(ids(db, 'notes', 'id')).toEqual([...AUTHORED_FIXTURE.notes].sort())
    expect(ids(db, 'agent_sessions', 'key')).toEqual([...AUTHORED_FIXTURE.sessions].sort())
    expect(ids(db, 'outbox_actions', 'id')).toEqual([...AUTHORED_FIXTURE.actions].sort())
    expect(ids(db, 'finding_dismissals', 'finding_id')).toEqual([...AUTHORED_FIXTURE.dismissals].sort())

    db.close()
  })

  /**
   * The row 006's obvious migration deletes. A replacement CHECK requiring a
   * ticket project refuses it, and the tidy way to satisfy that constraint is
   * to drop it — so the fixture has to contain it before the migration exists.
   */
  it('contains a project with no ticket project at all', () => {
    const db = open()

    const repoOnly = db
      .prepare('SELECT jira_project_key, repo_name FROM projects WHERE id = ?')
      .get('proj-repo-only') as { jira_project_key: string | null; repo_name: string | null }

    expect(repoOnly.jira_project_key).toBeNull()
    expect(repoOnly.repo_name).toBe('tools')

    db.close()
  })

  it('contains a session with a workspace key and one without', () => {
    const db = open()

    const keys = (
      db.prepare('SELECT key, workspace_key FROM agent_sessions ORDER BY key').all() as {
        key: string
        workspace_key: string | null
      }[]
    ).map((r) => r.workspace_key)

    expect(keys.filter((k) => k !== null)).toHaveLength(1)
    expect(keys.filter((k) => k === null)).toHaveLength(1)

    db.close()
  })

  it('carries a note on every subject kind, including the four that are going', () => {
    const db = open()

    const subjects = ids(db, 'notes', 'subject_key')
    expect(subjects.some((s) => s.startsWith('jira:'))).toBe(true)
    expect(subjects.some((s) => s.startsWith('gh:') && s.includes('#'))).toBe(true)
    expect(subjects.some((s) => s.startsWith('gh:') && s.includes('@'))).toBe(true)
    expect(subjects.some((s) => s.startsWith('local:'))).toBe(true)
    expect(subjects.some((s) => s.startsWith('session:'))).toBe(true)

    db.close()
  })

  it('carries an open question-for-human note', () => {
    const db = open()

    const open_ = db
      .prepare(`SELECT COUNT(*) c FROM notes WHERE type = 'question-for-human' AND resolved_at IS NULL`)
      .get() as { c: number }

    expect(open_.c).toBe(1)

    db.close()
  })

  it('carries outbox actions in four states, including a claimed one', () => {
    const db = open()

    const states = (
      db.prepare('SELECT state FROM outbox_actions ORDER BY state').all() as { state: string }[]
    ).map((r) => r.state)

    expect(states).toEqual(['claimed', 'complete', 'failed', 'pending'])

    db.close()
  })

  it('stores the 0.3.0 settings shape, not the current one', () => {
    const db = open()

    const row = db.prepare('SELECT payload FROM settings WHERE id = 1').get() as { payload: string }
    const payload = JSON.parse(row.payload)

    // The three keys 006 reshapes. If this file ever starts importing
    // DEFAULT_SETTINGS, these assertions are what stop it going unnoticed.
    expect(payload.pollIntervalSec).toEqual(SETTINGS_0_3_0.pollIntervalSec)
    expect(payload.pollIntervalSec.github).toBe(90)
    expect(payload.laneThresholdHours).toEqual({ tickets: 48, pulls: 12, branches: 36 })
    expect(payload.driftGraceHours).toBe(24)

    db.close()
  })
})
