import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NaturalKey } from '../../src/domain/keys.js'
import { OperationError } from '../../src/registry/errors.js'
import type { Ctx } from '../../src/registry/types.js'
import { historyService, MAX_LINE, type HistoryService } from '../../src/services/history.js'
import { historyRepository } from '../../src/store/authored/history.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 008 — the rules the ticket history is, as distinct from where it is stored.
 *
 * Five of these describe behaviour that has no other test anywhere, because it
 * is behaviour nothing else in the product has:
 *
 * - the line is refused rather than reshaped when it is not one line;
 * - recording appends and does not duplicate;
 * - the ticket summary is a snapshot that **survives the ticket leaving**;
 * - a revision race is visible rather than silent;
 * - and nothing prunes.
 *
 * The last two are tested against the real store rather than a fake, because
 * both are properties of the write rather than of the service's arithmetic.
 */

const KEY = 'jira:acme.atlassian.net/MERC-1184' as NaturalKey
const OTHER = 'jira:acme.atlassian.net/MERC-1201' as NaturalKey

let dir: string
let close: () => void
let service: HistoryService
/** What the mirror would answer for a ticket. Mutable, so a ticket can leave. */
let summaries: Map<string, string>

function ctx(at = '2026-08-20T10:00:00.000Z', who: 'user' | 'agent' = 'agent'): Ctx {
  return {
    authorKind: who,
    authorId: who === 'agent' ? 'claude-code' : null,
    surface: who === 'agent' ? 'mcp' : 'ipc',
    now: () => new Date(at),
  }
}

function failure(run: () => unknown): OperationError {
  try {
    run()
  } catch (e) {
    if (e instanceof OperationError) return e
    throw e
  }
  throw new Error('expected the write to be refused, and it was not')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-history-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()

  summaries = new Map([[KEY, 'Reconcile worktree state when a branch is deleted upstream']])
  service = historyService({
    history: historyRepository(opened.db),
    ticketSummary: (key) => summaries.get(key) ?? null,
  })
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the line', () => {
  it('refuses a line with a break in it, and says where the paragraph goes', () => {
    const error = failure(() =>
      service.record({ ticketKey: KEY, line: 'Fixed the guard.\nIt was in the caller.' }, ctx()),
    )

    expect(error.code).toBe('invalid')
    // The message is the requirement here, not decoration. The caller is a
    // model, and "invalid line" alone leaves it with nowhere to put the text —
    // it will shorten the line and lose the sentence rather than move it.
    expect(error.message).toContain('notes')
    expect(service.list()).toHaveLength(0)
  })

  it('trims the ends, because a trailing newline is how text arrives', () => {
    const entry = service.record({ ticketKey: KEY, line: '  Fixed the guard.\n' }, ctx())
    expect(entry.line).toBe('Fixed the guard.')
  })

  it('refuses a line past the bound rather than truncating it', () => {
    const error = failure(() =>
      service.record({ ticketKey: KEY, line: 'x'.repeat(MAX_LINE + 1) }, ctx()),
    )

    expect(error.code).toBe('invalid')
    expect(service.list()).toHaveLength(0)
  })
})

describe('recording', () => {
  it('keeps one entry per ticket, replacing the line and appending the notes', () => {
    service.record(
      { ticketKey: KEY, line: 'Reproduced it.', notes: 'Fails only on a rerun.' },
      ctx(),
    )
    const second = service.record(
      { ticketKey: KEY, line: 'Fixed and merged.', notes: 'The guard went in the callee.' },
      ctx('2026-08-20T12:00:00.000Z'),
    )

    expect(service.list()).toHaveLength(1)
    expect(second.line).toBe('Fixed and merged.')
    // Both paragraphs, oldest first. The append is the whole reason detail
    // written at the start of a piece of work is still there at the end of it.
    expect(second.notes).toBe('Fails only on a rerun.\n\nThe guard went in the callee.')
    expect(second.revision).toBe(2)
    // Created when the first write happened, not on the most recent one.
    expect(second.createdAt).toBe('2026-08-20T10:00:00.000Z')
    expect(second.updatedAt).toBe('2026-08-20T12:00:00.000Z')
  })

  it('does not append text the notes already end with', () => {
    service.record({ ticketKey: KEY, line: 'Done.', notes: 'Only on a rerun.' }, ctx())
    const again = service.record(
      { ticketKey: KEY, line: 'Done.', notes: 'Only on a rerun.' },
      ctx(),
    )

    // An agent that records at the end of every turn would otherwise triple the
    // notes, and the operator would be the one to notice.
    expect(again.notes).toBe('Only on a rerun.')
  })

  it('leaves the notes alone when a record carries none', () => {
    service.record({ ticketKey: KEY, line: 'Started.', notes: 'Reproduced on Windows.' }, ctx())
    const second = service.record({ ticketKey: KEY, line: 'Finished.' }, ctx())

    expect(second.notes).toBe('Reproduced on Windows.')
  })

  it('stamps the author from the transport and not from the payload', () => {
    // The service takes no author field at all, so this is the only way one can
    // arrive — which is the property being pinned.
    const entry = service.record({ ticketKey: KEY, line: 'Done.' }, ctx(undefined, 'user'))
    expect(entry.authorKind).toBe('user')
    expect(entry.authorId).toBeNull()
  })

  it('refuses a subject that is not a ticket', () => {
    const error = failure(() =>
      service.record(
        { ticketKey: 'session:claude-code/run-1' as NaturalKey, line: 'Done.' },
        ctx(),
      ),
    )
    expect(error.code).toBe('invalid')
  })

  it('asks the site check before writing, not after', () => {
    let asked: string | null = null
    const checked = historyService({
      history: historyRepository(openAuthored({ dir: mkdtempSync(join(tmpdir(), 'gc-h2-')) }).db),
      assertKnownSite: (key) => {
        asked = key
        throw new OperationError('invalid', 'no connection for that site')
      },
    })

    const error = failure(() => checked.record({ ticketKey: KEY, line: 'Done.' }, ctx()))

    expect(asked).toBe(KEY)
    expect(error.code).toBe('invalid')
    // Nothing was written. An entry against a site nothing is configured for is
    // one nobody will ever see again — the defect this check closed on the notes
    // path, applied to the third write path.
    expect(checked.list()).toHaveLength(0)
  })
})

describe('the ticket summary it keeps', () => {
  it('snapshots the summary the mirror holds', () => {
    const entry = service.record({ ticketKey: KEY, line: 'Done.' }, ctx())
    expect(entry.ticketSummary).toBe('Reconcile worktree state when a branch is deleted upstream')
  })

  it('keeps the last summary it saw after the ticket leaves the mirror', () => {
    service.record({ ticketKey: KEY, line: 'Done.' }, ctx())

    // The ticket closes and the next sync drops it. This is the ordinary case
    // rather than an edge one: an entry is written *because* the work finished.
    summaries.delete(KEY)
    const later = service.record({ ticketKey: KEY, line: 'Reopened and closed again.' }, ctx())

    expect(later.ticketSummary).toBe('Reconcile worktree state when a branch is deleted upstream')
    // And it is still there for a reader, which is the whole point (FR-149).
    expect(service.get(KEY).ticketSummary).not.toBeNull()
  })

  it('refreshes the snapshot while the ticket is still there', () => {
    service.record({ ticketKey: KEY, line: 'Done.' }, ctx())
    summaries.set(KEY, 'Reconcile worktree state (renamed)')

    expect(service.record({ ticketKey: KEY, line: 'Done again.' }, ctx()).ticketSummary).toBe(
      'Reconcile worktree state (renamed)',
    )
  })

  it('leaves it null when the mirror never held the ticket', () => {
    const entry = service.record({ ticketKey: OTHER, line: 'Closed as a duplicate.' }, ctx())
    expect(entry.ticketSummary).toBeNull()
  })
})

describe('revising', () => {
  it('replaces both fields and can clear the notes', () => {
    const first = service.record(
      { ticketKey: KEY, line: 'Done.', notes: 'Too much detail.' },
      ctx(),
    )

    const revised = service.revise(
      { ticketKey: KEY, revision: first.revision, line: 'Done, properly.', notes: null },
      ctx(),
    )

    expect(revised.line).toBe('Done, properly.')
    // The only path in the product that removes text from this table.
    expect(revised.notes).toBeNull()
  })

  it('rejects a stale revision and hands back the entry that won', () => {
    const first = service.record({ ticketKey: KEY, line: 'Done.' }, ctx())
    // An agent records while the operator is mid-edit.
    service.record({ ticketKey: KEY, line: 'Reopened.' }, ctx())

    const error = failure(() =>
      service.revise({ ticketKey: KEY, revision: first.revision, line: 'Done, tidied.' }, ctx()),
    )

    expect(error.code).toBe('conflict')
    // Carried, so the operator sees what the other writer said rather than only
    // that they lost — the same contract `notes.update` has.
    expect((error.details.current as { line: string }).line).toBe('Reopened.')
  })

  it('refuses a revision that changes nothing', () => {
    const first = service.record({ ticketKey: KEY, line: 'Done.' }, ctx())
    expect(
      failure(() => service.revise({ ticketKey: KEY, revision: first.revision }, ctx())).code,
    ).toBe('invalid')
  })
})

describe('reading and removing', () => {
  it('answers not_found rather than an empty entry', () => {
    expect(failure(() => service.get(KEY)).code).toBe('not_found')
  })

  it('lists most recently written first', () => {
    service.record({ ticketKey: KEY, line: 'First.' }, ctx('2026-08-20T10:00:00.000Z'))
    service.record({ ticketKey: OTHER, line: 'Second.' }, ctx('2026-08-20T11:00:00.000Z'))

    expect(service.list().map((e) => e.ticketKey)).toEqual([OTHER, KEY])
  })

  it('narrows on a term matching the key, the line or the notes', () => {
    service.record({ ticketKey: KEY, line: 'Rate limiting.', notes: 'Per connection.' }, ctx())
    service.record({ ticketKey: OTHER, line: 'Settings key.' }, ctx())

    expect(service.list({ q: 'MERC-1201' }).map((e) => e.ticketKey)).toEqual([OTHER])
    expect(service.list({ q: 'rate' }).map((e) => e.ticketKey)).toEqual([KEY])
    // The notes are searched too: the operator's question is "what did we do
    // about X", and X is as likely to be a word from the detail as a key.
    expect(service.list({ q: 'per connection' }).map((e) => e.ticketKey)).toEqual([KEY])
  })

  it('carries the issue key, derived rather than stored', () => {
    expect(service.record({ ticketKey: KEY, line: 'Done.' }, ctx()).issueKey).toBe('MERC-1184')
  })

  it('removes an entry only with the revision that was read', () => {
    const first = service.record({ ticketKey: KEY, line: 'Done.' }, ctx())
    service.record({ ticketKey: KEY, line: 'Reopened.' }, ctx())

    expect(failure(() => service.remove({ ticketKey: KEY, revision: first.revision })).code).toBe(
      'conflict',
    )
    expect(service.remove({ ticketKey: KEY, revision: 2 })).toEqual({ ticketKey: KEY })
    expect(service.list()).toHaveLength(0)
  })
})
