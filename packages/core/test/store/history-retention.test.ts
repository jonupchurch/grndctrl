import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NaturalKey } from '../../src/domain/keys.js'
import { historyRepository, type HistoryRepository } from '../../src/store/authored/history.js'
import { RETENTION as PROMPT_RETENTION } from '../../src/store/authored/prompts.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 008/FR-150 — **nothing prunes the ticket history, and this is the test that
 * says so.**
 *
 * Every other authored stream in this product prunes inside its own insert:
 * `agent_updates` at fifty per session, `prompts` at two hundred globally. The
 * next person to add a table to `store/authored/` will start from one of those
 * two files, and bringing the prune along is a one-line change that passes
 * every other test in the repository. The failure would appear eighteen months
 * later, silently, on rows nobody had looked at recently — which is precisely
 * the set of rows this table exists to hold.
 *
 * So the absence is asserted rather than commented. The bound written past is
 * `prompts`' own constant, imported rather than restated: if that number ever
 * rises, this test rises with it, and the thing being proved stays "further than
 * any bound in this package" rather than "further than 200".
 *
 * **The read is by key, not by page.** A `list()` capped at its own limit cannot
 * see past the bound, and a test that could not see past the bound could not
 * detect one — that mistake was made in this repository once already, in the
 * prompt retention test, where deleting the prune left every assertion green.
 */

const WELL_PAST = PROMPT_RETENTION * 3

let dir: string
let close: () => void
let history: HistoryRepository

const keyFor = (n: number): NaturalKey =>
  `jira:acme.atlassian.net/MERC-${String(n).padStart(5, '0')}` as NaturalKey

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-history-retention-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()
  history = historyRepository(opened.db)
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the ticket history is never pruned', () => {
  it('still holds the first entry after six hundred more', () => {
    for (let n = 0; n < WELL_PAST; n++) {
      history.record({
        ticketKey: keyFor(n),
        line: `Entry ${n}.`,
        mergeNotes: () => null,
        ticketSummary: null,
        authorKind: 'agent',
        authorId: 'claude-code',
        // Ascending, so the *oldest* entry is also the one a bound would drop
        // first. An ordering that put it last would make this pass under a
        // newest-first prune, which is the shape both other tables use.
        at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
      })
    }

    // By key. `list()` takes a limit and cannot answer a question about what
    // lies past it.
    expect(history.get(keyFor(0))?.line).toBe('Entry 0.')
    expect(history.get(keyFor(WELL_PAST - 1))?.line).toBe(`Entry ${WELL_PAST - 1}.`)
  })

  it('has no DELETE anywhere except the one the operator asks for', () => {
    const first = keyFor(0)
    history.record({
      ticketKey: first,
      line: 'Kept.',
      mergeNotes: () => null,
      ticketSummary: null,
      authorKind: 'user',
      authorId: null,
      at: '2026-01-01T00:00:00.000Z',
    })

    // Writing against a *different* ticket must not touch it — the failure mode
    // of a copied prune, which deletes on every insert rather than on demand.
    history.record({
      ticketKey: keyFor(1),
      line: 'Also kept.',
      mergeNotes: () => null,
      ticketSummary: null,
      authorKind: 'user',
      authorId: null,
      at: '2026-01-02T00:00:00.000Z',
    })

    expect(history.get(first)).not.toBeNull()

    const removed = history.remove(first, 1)
    expect(removed.ok).toBe(true)
    expect(history.get(first)).toBeNull()
    // And only that one.
    expect(history.get(keyFor(1))).not.toBeNull()
  })
})

describe('one row per ticket', () => {
  it('upserts rather than inserting a second row', () => {
    const key = keyFor(7)
    for (const line of ['First.', 'Second.', 'Third.']) {
      history.record({
        ticketKey: key,
        line,
        mergeNotes: (existing) => existing,
        ticketSummary: null,
        authorKind: 'agent',
        authorId: 'claude-code',
        at: '2026-01-01T00:00:00.000Z',
      })
    }

    expect(history.list()).toHaveLength(1)
    expect(history.get(key)?.line).toBe('Third.')
    expect(history.get(key)?.revision).toBe(3)
  })

  it('keeps the stored summary when a later write cannot supply one', () => {
    const key = keyFor(8)
    const write = (summary: string | null): void => {
      history.record({
        ticketKey: key,
        line: 'Done.',
        mergeNotes: (existing) => existing,
        ticketSummary: summary,
        authorKind: 'agent',
        authorId: 'claude-code',
        at: '2026-01-01T00:00:00.000Z',
      })
    }

    write('Reconcile worktree state')
    write(null)

    // `COALESCE`, not assignment. Null means "the mirror could not answer",
    // which is the ordinary state once a ticket closes.
    expect(history.get(key)?.ticketSummary).toBe('Reconcile worktree state')
  })
})
