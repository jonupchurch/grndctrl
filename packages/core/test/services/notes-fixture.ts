import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import {
  branchKey,
  pullRequestKey,
  sessionKey,
  ticketKey,
  workspaceKey,
  type NaturalKey,
} from '../../src/domain/keys.js'
import type { Ctx } from '../../src/registry/types.js'
import { subjectPresenceResolver } from '../../src/runtime/presence.js'
import { notesService, type NotesService } from '../../src/services/notes.js'
import { notesRepository } from '../../src/store/authored/notes.js'
import { openAuthored, openMirror } from '../../src/store/open.js'
import { mirrorRepository } from '../../src/store/mirror/repository.js'
import { mirrorDbPath } from '../../src/store/paths.js'

/**
 * A real notes service over two real database files.
 *
 * Deliberately not a double. The properties under test — a note surviving the
 * mirror being deleted, a conflicting write losing — are properties of the
 * storage layout and of SQLite's write semantics. A fake would pass whatever
 * these tests asserted and prove nothing about either.
 */

export const REMOTE = 'git@github.com:Acme/Mercury.git'

export const SUBJECTS = {
  ticket: ticketKey('acme.atlassian.net', 'MERC-1184'),
  pull: pullRequestKey('Acme', 'Mercury', 451),
  branch: branchKey(REMOTE, 'feat/reconcile'),
  workspace: workspaceKey(REMOTE, 'feat/reconcile', 'main'),
  session: sessionKey('claude-code', 'abc123'),
} as const

export const ALL_TYPES = ['decision', 'gotcha', 'question-for-human', 'todo'] as const

export interface Fixture {
  dir: string
  service: NotesService
  authored: Database
  mirror: Database
  /** Reopen both databases — proves a fact survived a process restart, not just a cache. */
  reopen(): void
  seedMirror(): void
  /** Remove `mirror.db` entirely. The supported operation is an unlink, not a cascade. */
  dropMirror(): void
  close(): void
}

export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-notes-'))

  const f: Fixture = {
    dir,
    // Assigned by open(); declared here so the shape is visible in one place.
    service: undefined as unknown as NotesService,
    authored: undefined as unknown as Database,
    mirror: undefined as unknown as Database,

    reopen() {
      f.authored.close()
      f.mirror.close()
      open(f)
    },

    seedMirror: () => seedMirror(f.mirror),

    dropMirror() {
      f.mirror.close()
      for (const suffix of ['', '-wal', '-shm']) {
        rmSync(`${mirrorDbPath(f.dir)}${suffix}`, { force: true })
      }
      f.mirror = openMirror({ dir: f.dir }).db
      wire(f)
    },

    close() {
      f.authored.close()
      f.mirror.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }

  open(f)
  return f
}

function open(f: Fixture): void {
  f.authored = openAuthored({ dir: f.dir }).db
  f.mirror = openMirror({ dir: f.dir }).db
  wire(f)
}

function wire(f: Fixture): void {
  let n = 0
  f.service = notesService({
    notes: notesRepository(f.authored),
    subjectPresence: subjectPresenceResolver({
      mirror: mirrorRepository(f.mirror),
      hasSession: (key) =>
        f.authored.prepare('SELECT 1 FROM agent_sessions WHERE key = ?').get(key) !== undefined,
    }),
    // Sequential rather than random: a test that asserts on ordering should not
    // depend on how a UUID happened to sort.
    newId: () => `note:${String(++n).padStart(3, '0')}`,
  })
}

/**
 * The mirror as it looks after one successful sync of everything.
 *
 * The freshness rows matter as much as the data rows: without them the mirror
 * has "never synced" and every presence answer is `unknown`, which is a
 * different assertion from the one most of these tests are making.
 */
export function seedMirror(db: Database): void {
  const at = '2026-08-14T09:00:00.000Z'

  db.prepare(
    `INSERT OR REPLACE INTO connections (id, kind, site_or_host, account_label, credential_ref)
     VALUES ('c-jira', 'jira', 'acme.atlassian.net', 'work', 'grndctrl/c-jira'),
            ('c-gh', 'github', 'github.com', 'work', 'grndctrl/c-gh')`,
  ).run()

  db.prepare(
    `INSERT OR REPLACE INTO tickets (key, connection_id, issue_key, summary, status_name,
                                     status_category, created_at, updated_at, url, fetched_at)
     VALUES (?, 'c-jira', 'MERC-1184', 'Reconcile worktree state', 'In Review', 'indeterminate',
             ?, ?, 'https://acme.atlassian.net/browse/MERC-1184', ?)`,
  ).run(SUBJECTS.ticket, at, at, at)

  db.prepare(
    `INSERT OR REPLACE INTO pull_requests (key, connection_id, number, title, head_branch,
                                           base_branch, state, url, fetched_at)
     VALUES (?, 'c-gh', 451, 'Reconcile worktree state', 'feat/reconcile', 'main', 'open',
             'https://github.com/Acme/Mercury/pull/451', ?)`,
  ).run(SUBJECTS.pull, at)

  seedBranch(db)

  db.prepare(
    `INSERT OR REPLACE INTO local_workspaces (key, repo_path, canonical_remote, branch, worktree_id,
                                              head_sha, read_at)
     VALUES (?, 'D:/code/mercury', 'github.com/acme/mercury', 'feat/reconcile', 'main', 'abc1234', ?)`,
  ).run(SUBJECTS.workspace, at)

  for (const [connection, kind] of [
    ['c-jira', 'tickets'],
    ['c-gh', 'pulls'],
    ['c-gh', 'branches'],
    ['c-gh', 'checks'],
    ['local', 'local'],
  ] as const) {
    db.prepare(
      `INSERT OR REPLACE INTO freshness (connection_id, resource_kind, last_success_at)
       VALUES (?, ?, ?)`,
    ).run(connection, kind, at)
  }
}

export function seedBranch(db: Database): void {
  db.prepare(
    `INSERT OR REPLACE INTO branch_refs (key, connection_id, name, head_sha, updated_at, url, fetched_at)
     VALUES (?, 'c-gh', 'feat/reconcile', 'abc1234', ?, 'https://github.com/Acme/Mercury/tree/feat/reconcile', ?)`,
  ).run(SUBJECTS.branch, '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z')
}

export function seedSession(db: Database): void {
  const at = '2026-08-14T09:00:00.000Z'
  db.prepare(
    `INSERT OR REPLACE INTO agent_sessions (key, agent_id, session_id, started_at,
                                            last_heartbeat_at, heartbeat_interval_sec)
     VALUES (?, 'claude-code', 'abc123', ?, ?, 60)`,
  ).run(SUBJECTS.session, at, at)
}

/** A context as an adapter would stamp it. The author never comes from a payload. */
export function ctxFor(authorKind: 'user' | 'agent', at = '2026-08-14T10:00:00.000Z'): Ctx {
  return {
    authorKind,
    authorId: authorKind === 'agent' ? 'claude-code' : null,
    surface: authorKind === 'agent' ? 'mcp' : 'ipc',
    now: () => new Date(at),
  }
}

export const asKey = (s: string): NaturalKey => s as NaturalKey
