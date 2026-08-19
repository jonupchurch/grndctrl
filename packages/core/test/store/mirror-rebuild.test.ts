import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketKey } from '../../src/domain/keys.js'
import { openAuthored, openMirror } from '../../src/store/open.js'
import { mirrorDbPath } from '../../src/store/paths.js'
import { MIRROR_MIGRATIONS } from '../../src/store/mirror/migrations.js'

/**
 * SC-007 and constitution XIII: delete the entire mirror, rebuild it from
 * nothing, and every authored row is still there and still attached.
 *
 * This is the promise that makes the mirror disposable. If it ever fails, the
 * correct response is to change the design — not to soften the test — because
 * the alternative is a cache rebuild destroying a user's own work with no
 * server-side copy to restore from (XI).
 */

let dir: string

const SUBJECT = ticketKey('acme.atlassian.net', 'MERC-1184')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-rebuild-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seedMirror(): void {
  const { db } = openMirror({ dir })
  db.prepare(
    `INSERT INTO connections (id, kind, site_or_host, account_label, credential_ref)
     VALUES ('c1', 'jira', 'acme.atlassian.net', 'work', 'grndctrl/c1')`,
  ).run()
  db.prepare(
    `INSERT INTO tickets (key, connection_id, issue_key, summary, status_name, status_category,
                          created_at, updated_at, url, fetched_at)
     VALUES (?, 'c1', 'MERC-1184', 'Reconcile worktree state', 'In Review', 'indeterminate',
             '2026-08-01T00:00:00Z', '2026-08-10T00:00:00Z', 'https://example.invalid/MERC-1184',
             '2026-08-14T00:00:00Z')`,
  ).run(SUBJECT)
  db.close()
}

function seedAuthored(): void {
  const { db } = openAuthored({ dir })
  const now = '2026-08-14T00:00:00Z'

  db.prepare(
    `INSERT INTO projects (id, code, name, jira_project_key)
     VALUES ('p1', 'MERC', 'Mercury', 'MERC')`,
  ).run()

  for (const [id, type, body] of [
    ['n1', 'decision', 'We are keeping the legacy queue until Q4.'],
    ['n2', 'gotcha', 'The limiter warms lazily; first request after boot is cold.'],
    ['n3', 'question-for-human', 'Do you want the export to include archived rows?'],
    ['n4', 'todo', 'Backfill the migration test for worktree deletion.'],
  ] as const) {
    db.prepare(
      `INSERT INTO notes (id, subject_key, type, body, author_kind, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 1, ?, ?)`,
    ).run(id, SUBJECT, type, body, now, now)
  }

  db.prepare(
    `INSERT INTO agent_sessions (key, agent_id, session_id, project_id, work_item_key,
                                 started_at, last_heartbeat_at, heartbeat_interval_sec)
     VALUES ('session:claude-code/abc', 'claude-code', 'abc', 'p1', ?, ?, ?, 60)`,
  ).run(SUBJECT, now, now)

  db.prepare(
    `INSERT INTO outbox_actions (id, subject_key, kind, state, confirmed_at, confirmed_via)
     VALUES ('a1', ?, 'transition-ticket', 'pending', ?, 'ui')`,
  ).run(SUBJECT, now)

  db.prepare(
    `INSERT INTO finding_dismissals (finding_id, dismissed_at, evidence_hash)
     VALUES ('drift:D1:jira:acme.atlassian.net/MERC-1184', ?, 'deadbeef')`,
  ).run(now)

  // The active ticket points into the mirror by natural key and is authored
  // (007/R3). It is here because "it survives a rebuild" is the claim R3 makes
  // for storing it in this file rather than deriving it from a session.
  db.prepare(
    `INSERT INTO active_ticket (id, ticket_key, set_by, set_by_id, set_at)
     VALUES (1, ?, 'agent', 'claude-code', ?)`,
  ).run(SUBJECT, now)

  db.close()
}

describe('deleting the mirror', () => {
  it('leaves every authored row intact and still attached', () => {
    seedMirror()
    seedAuthored()

    // The supported operation: remove the file. Not a careful cascade, not a
    // migration -- an unlink. That is the whole point of two files.
    rmSync(mirrorDbPath(dir), { force: true })
    rmSync(`${mirrorDbPath(dir)}-wal`, { force: true })
    rmSync(`${mirrorDbPath(dir)}-shm`, { force: true })
    expect(existsSync(mirrorDbPath(dir))).toBe(false)

    const rebuilt = openMirror({ dir })
    expect(rebuilt.migration.applied.length).toBeGreaterThan(0)
    expect(rebuilt.db.prepare('SELECT COUNT(*) c FROM tickets').get()).toEqual({ c: 0 })
    rebuilt.db.close()

    const { db } = openAuthored({ dir })

    const notes = db
      .prepare('SELECT id, subject_key, type, body FROM notes ORDER BY id')
      .all() as { id: string; subject_key: string; type: string; body: string }[]

    expect(notes).toHaveLength(4)
    expect(notes.map((n) => n.type).sort()).toEqual([
      'decision',
      'gotcha',
      'question-for-human',
      'todo',
    ])
    // Still attached, and the content is byte-identical -- "survived" is not the
    // same as "survived intact".
    expect(notes.every((n) => n.subject_key === SUBJECT)).toBe(true)
    expect(notes[0]?.body).toBe('We are keeping the legacy queue until Q4.')

    expect(db.prepare('SELECT COUNT(*) c FROM projects').get()).toEqual({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get()).toEqual({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM outbox_actions').get()).toEqual({ c: 1 })
    expect(db.prepare('SELECT COUNT(*) c FROM finding_dismissals').get()).toEqual({ c: 1 })

    // Still pointing at the ticket, which the rebuilt mirror does not yet hold.
    // That is not a broken state — it is FR-131's, and the panel renders it as
    // "this is what is known" until the next sync fills the rest in.
    const active = db.prepare('SELECT ticket_key, set_by FROM active_ticket WHERE id = 1').get() as
      | { ticket_key: string; set_by: string }
      | undefined
    expect(active?.ticket_key).toBe(SUBJECT)
    expect(active?.set_by).toBe('agent')

    db.close()
  })

  it('re-attaches notes when the subject reappears', () => {
    seedMirror()
    seedAuthored()

    rmSync(mirrorDbPath(dir), { force: true })
    rmSync(`${mirrorDbPath(dir)}-wal`, { force: true })
    rmSync(`${mirrorDbPath(dir)}-shm`, { force: true })

    // A resync produces the same ticket, and therefore the same natural key.
    // No repair step, no re-linking pass: the note was never unattached.
    seedMirror()

    const mirror = openMirror({ dir })
    const authored = openAuthored({ dir })

    const ticket = mirror.db.prepare('SELECT key FROM tickets').get() as { key: string }
    const attached = authored.db
      .prepare('SELECT COUNT(*) c FROM notes WHERE subject_key = ?')
      .get(ticket.key) as { c: number }

    expect(attached.c).toBe(4)

    mirror.db.close()
    authored.db.close()
  })

  it('reports a clean migration on a fresh mirror', () => {
    // Read from the chain rather than written down, so adding a migration does
    // not need this test edited -- a literal here would have to be bumped by
    // hand every time, which makes it a record of somebody's diligence rather
    // than of the schema.
    const latest = Math.max(...MIRROR_MIGRATIONS.map((m) => m.version))

    const first = openMirror({ dir })
    expect(first.migration.from).toBe(0)
    expect(first.migration.to).toBe(latest)
    expect(first.migration.applied).toHaveLength(MIRROR_MIGRATIONS.length)
    first.db.close()

    // Reopening is not a re-migration.
    const second = openMirror({ dir })
    expect(second.migration.applied).toEqual([])
    expect(second.migration.to).toBe(latest)
    second.db.close()
  })
})
