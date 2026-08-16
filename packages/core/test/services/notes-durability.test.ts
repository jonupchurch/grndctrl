import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NaturalKey } from '../../src/domain/keys.js'
import { ALL_TYPES, ctxFor, fixture, seedSession, SUBJECTS, type Fixture } from './notes-fixture.js'

/**
 * SC-007, at the service layer: every note type, on every subject type, survives
 * the mirror being deleted and rebuilt — and comes back attached, with no repair
 * step.
 *
 * `mirror-rebuild.test.ts` proves the same thing at the SQL layer. This proves
 * the layer above it does not undo the guarantee: nothing in the service
 * resolves a note through a mirrored row, and nothing deletes a note whose
 * subject went missing.
 */

let f: Fixture

beforeEach(() => {
  f = fixture()
  f.seedMirror()
  seedSession(f.authored)
})

afterEach(() => {
  f.close()
})

const SUBJECT_KEYS: readonly NaturalKey[] = Object.values(SUBJECTS)

function writeEverything(): void {
  for (const subjectKey of SUBJECT_KEYS) {
    for (const type of ALL_TYPES) {
      f.service.create({ subjectKey, type, body: `${type} on ${subjectKey}` }, ctxFor('user'))
    }
  }
}

describe('notes across a mirror rebuild', () => {
  it('keeps every type on every subject, byte-identical', () => {
    writeEverything()

    const before = SUBJECT_KEYS.flatMap((k) => f.service.list(k))
    expect(before).toHaveLength(SUBJECT_KEYS.length * ALL_TYPES.length)

    f.dropMirror()

    const after = SUBJECT_KEYS.flatMap((k) => f.service.list(k))

    // Compared on the authored fields only. `subjectPresence` is *expected* to
    // change — that is the mirror being empty, reported honestly.
    const authoredFields = (n: (typeof before)[number]) => ({
      id: n.id,
      subjectKey: n.subjectKey,
      type: n.type,
      body: n.body,
      authorKind: n.authorKind,
      revision: n.revision,
      createdAt: n.createdAt,
    })

    expect(after.map(authoredFields)).toEqual(before.map(authoredFields))
  })

  it('re-attaches with no repair step when the subject comes back', () => {
    writeEverything()
    f.dropMirror()

    // A resync produces the same natural keys, because that is what natural
    // means. There is no re-linking pass, and there is nowhere one could run.
    f.seedMirror()

    for (const key of SUBJECT_KEYS) {
      const notes = f.service.list(key)
      expect(notes).toHaveLength(ALL_TYPES.length)
      expect(notes.every((n) => n.orphaned)).toBe(false)
    }
  })

  it('survives closing and reopening the database', () => {
    writeEverything()
    f.reopen()

    expect(f.service.list(SUBJECTS.ticket)).toHaveLength(ALL_TYPES.length)
  })
})

describe('a subject that has gone', () => {
  it('reports the note as orphaned and does not delete it', () => {
    f.service.create(
      { subjectKey: SUBJECTS.ticket, type: 'decision', body: 'Keep the legacy queue until Q4.' },
      ctxFor('user'),
    )

    // The ticket is deleted but the mirror still knows what a ticket is — it has
    // synced. So its absence is a real answer, not a gap in knowledge.
    f.mirror.prepare('DELETE FROM tickets').run()

    const [note] = f.service.list(SUBJECTS.ticket)
    expect(note?.orphaned).toBe(true)
    expect(note?.subjectPresence).toBe('absent')
    expect(note?.body).toBe('Keep the legacy queue until Q4.')
  })

  it('says unknown rather than orphaned before the first sync', () => {
    // The failure this guards against: on first launch the mirror is empty, and
    // a two-state answer would mark every note in the product as orphaned.
    f.dropMirror()

    f.service.create(
      { subjectKey: SUBJECTS.ticket, type: 'todo', body: 'Backfill the worktree test.' },
      ctxFor('user'),
    )

    const [note] = f.service.list(SUBJECTS.ticket)
    expect(note?.subjectPresence).toBe('unknown')
    expect(note?.orphaned).toBe(false)
  })

  it('answers per resource kind, not globally', () => {
    // Branches have synced; tickets have not. One unsynced lane must not make
    // the other lane's answers useless.
    f.dropMirror()
    f.mirror
      .prepare(
        `INSERT INTO connections (id, kind, site_or_host, account_label, credential_ref)
         VALUES ('c-gh', 'github', 'github.com', 'work', 'grndctrl/c-gh')`,
      )
      .run()
    f.mirror
      .prepare(
        `INSERT INTO freshness (connection_id, resource_kind, last_success_at)
         VALUES ('c-gh', 'branches', '2026-08-14T09:00:00.000Z')`,
      )
      .run()

    f.service.create({ subjectKey: SUBJECTS.ticket, type: 'todo', body: 'a' }, ctxFor('user'))
    f.service.create({ subjectKey: SUBJECTS.branch, type: 'todo', body: 'b' }, ctxFor('user'))

    expect(f.service.list(SUBJECTS.ticket)[0]?.subjectPresence).toBe('unknown')
    expect(f.service.list(SUBJECTS.branch)[0]?.subjectPresence).toBe('absent')
  })
})

describe('authorship', () => {
  it('comes from the calling adapter, never from the payload', () => {
    // The payload has no author field to begin with — this asserts the shape
    // holds, so that adding one later fails here rather than in production.
    const asAgent = f.service.create(
      {
        subjectKey: SUBJECTS.ticket,
        type: 'question-for-human',
        body: 'Should the export include archived rows?',
      },
      ctxFor('agent'),
    )

    expect(asAgent.authorKind).toBe('agent')
    expect(asAgent.authorId).toBe('claude-code')

    const asUser = f.service.create(
      { subjectKey: SUBJECTS.ticket, type: 'decision', body: 'Yes, include them.' },
      ctxFor('user'),
    )

    expect(asUser.authorKind).toBe('user')
    expect(asUser.authorId).toBeNull()
  })
})

describe('what a note may attach to', () => {
  it('refuses a key that is not a subject key at all', () => {
    expect(() =>
      f.service.create(
        { subjectKey: 'MERC-1184' as NaturalKey, type: 'todo', body: 'x' },
        ctxFor('user'),
      ),
    ).toThrow(/cannot be attached/)
  })

  it('refuses a CI run, which is replaced on the next push', () => {
    expect(() =>
      f.service.create(
        { subjectKey: 'check:acme/mercury@abc1234/build' as NaturalKey, type: 'todo', body: 'x' },
        ctxFor('user'),
      ),
    ).toThrow(/cannot be attached/)
  })
})
