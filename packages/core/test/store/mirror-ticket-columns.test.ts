import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketKey } from '../../src/domain/keys.js'
import { migrate } from '../../src/store/migrate.js'
import { MIRROR_MIGRATIONS } from '../../src/store/mirror/migrations.js'
import { mirrorRepository } from '../../src/store/mirror/repository.js'
import { openMirror } from '../../src/store/open.js'
import { mirrorDbPath } from '../../src/store/paths.js'
import type { Ticket } from '../../src/domain/types.js'

/**
 * `priority` and `story_points` — the ticket lane's two newest columns.
 *
 * Two separate things are checked here and they fail in different ways.
 *
 * **The upgrade.** A mirror is disposable, so a migration here may not lose a
 * row but also may not *need* one — the app could delete the file and resync.
 * That is not a reason to skip the case: an installed copy has a `mirror.db` on
 * disk at version 1, and the launch that upgrades it is the launch on which
 * nothing else has changed for the operator. If it goes wrong there, the symptom
 * is a board that has silently lost every ticket.
 *
 * **The round trip.** Both columns are nullable and null means *unknown*, which
 * makes the interesting value zero: a coercion that reads a genuine 0-point
 * estimate as "unestimated" typechecks, passes any test that only uses 3 and 5,
 * and puts a dash where the tracker says zero.
 */

let dir: string

const SITE = 'acme.atlassian.net'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-ticket-columns-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const ticket = (over: Partial<Ticket> & { issueKey: string }): Ticket => ({
  key: ticketKey(SITE, over.issueKey),
  connectionId: 'c1',
  summary: 'Reconcile worktree state',
  assignee: null,
  reporter: null,
  statusName: 'In Review',
  statusCategory: 'indeterminate',
  isBlocked: false,
  priority: null,
  storyPoints: null,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-10T00:00:00Z',
  lastRealActivityAt: null,
  lastStatusChangeAt: null,
  url: `https://${SITE}/browse/${over.issueKey}`,
  fetchedAt: '2026-08-14T00:00:00Z',
  ...over,
})

const connect = (db: Database.Database): void => {
  db.prepare(
    `INSERT INTO connections (id, kind, site_or_host, account_label, credential_ref)
     VALUES ('c1', 'jira', 'acme.atlassian.net', 'work', 'grndctrl/c1')`,
  ).run()
}

describe('upgrading a mirror that predates the columns', () => {
  /** A `mirror.db` exactly as version 1 left it, with one ticket in it. */
  function seedVersionOne(): void {
    const db = new Database(mirrorDbPath(dir))
    migrate(db, [MIRROR_MIGRATIONS[0]!], () => '2026-08-14T00:00:00Z')
    connect(db)
    db.prepare(
      `INSERT INTO tickets (key, connection_id, issue_key, summary, status_name, status_category,
                            created_at, updated_at, url, fetched_at)
       VALUES (?, 'c1', 'MERC-1184', 'Reconcile worktree state', 'In Review', 'indeterminate',
               '2026-08-01T00:00:00Z', '2026-08-10T00:00:00Z',
               'https://example.invalid/MERC-1184', '2026-08-14T00:00:00Z')`,
    ).run(ticketKey(SITE, 'MERC-1184'))
    db.close()
  }

  it('applies only the migrations the file is missing', () => {
    seedVersionOne()

    const opened = openMirror({ dir })
    expect(opened.migration.from).toBe(1)
    expect(opened.migration.applied).toEqual(['2_ticket-priority-and-points'])
    opened.db.close()
  })

  it('keeps the tickets that were already there', () => {
    seedVersionOne()

    const opened = openMirror({ dir })
    const [row] = mirrorRepository(opened.db).listTickets()

    expect(row?.issueKey).toBe('MERC-1184')
    expect(row?.summary).toBe('Reconcile worktree state')
    opened.db.close()
  })

  // The reason neither column has a `DEFAULT`. A `DEFAULT 0` on story points
  // would tell the operator that every ticket they have ever synced was
  // estimated at zero — by the migration, on their behalf.
  it('reports the new columns as unknown rather than inventing values for them', () => {
    seedVersionOne()

    const opened = openMirror({ dir })
    const [row] = mirrorRepository(opened.db).listTickets()

    expect(row?.priority).toBeNull()
    expect(row?.storyPoints).toBeNull()
    opened.db.close()
  })
})

describe('storing priority and story points', () => {
  const roundTrip = (tickets: readonly Ticket[]): Ticket[] => {
    const opened = openMirror({ dir })
    connect(opened.db)
    const repo = mirrorRepository(opened.db)
    repo.replaceTickets('c1', tickets)
    const read = repo.listTickets()
    opened.db.close()
    return read
  }

  it('round-trips both columns', () => {
    const [row] = roundTrip([ticket({ issueKey: 'MERC-1', priority: 'Highest', storyPoints: 8 })])

    expect(row?.priority).toBe('Highest')
    expect(row?.storyPoints).toBe(8)
  })

  // Stored as REAL for this: rounding at the storage layer would make a
  // half-point ticket and a one-point ticket the same ticket.
  it('keeps a half-point estimate', () => {
    const [row] = roundTrip([ticket({ issueKey: 'MERC-1', storyPoints: 0.5 })])
    expect(row?.storyPoints).toBe(0.5)
  })

  /**
   * The one that matters.
   *
   * `Number(x) || null` and `x ? x : null` both turn a real zero into "we do not
   * know", and both look correct next to a 3 and a 5. Zero is an estimate
   * somebody made; null is nobody having made one, and the row draws them
   * differently.
   */
  it('distinguishes an estimate of zero from no estimate at all', () => {
    const rows = roundTrip([
      ticket({ issueKey: 'MERC-1', storyPoints: 0 }),
      ticket({ issueKey: 'MERC-2', storyPoints: null }),
    ])

    expect(rows.find((r) => r.issueKey === 'MERC-1')?.storyPoints).toBe(0)
    expect(rows.find((r) => r.issueKey === 'MERC-2')?.storyPoints).toBeNull()
  })

  // An unprioritised ticket is not a trivial one, so nothing here may fill the
  // gap with the bottom of a scale this code does not know the shape of.
  it('keeps an unset priority unset', () => {
    const [row] = roundTrip([ticket({ issueKey: 'MERC-1', priority: null, storyPoints: 3 })])
    expect(row?.priority).toBeNull()
  })

  it('stores the tracker’s own priority vocabulary without rewriting it', () => {
    const rows = roundTrip([
      ticket({ issueKey: 'MERC-1', priority: 'P2 - Major' }),
      ticket({ issueKey: 'MERC-2', priority: 'Blocker' }),
    ])

    expect(rows.map((r) => r.priority).sort()).toEqual(['Blocker', 'P2 - Major'])
  })
})
