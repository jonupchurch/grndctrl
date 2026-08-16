import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isOperationError, type OperationError } from '../../src/registry/errors.js'
import { ctxFor, fixture, seedBranch, SUBJECTS, type Fixture } from './notes-fixture.js'

/**
 * FR-055: a write against a stale revision is rejected, and the rejection
 * carries the current row.
 *
 * The situation is concrete and not hypothetical: the operator has a note open
 * in the modal while an agent writes to the same note over MCP. Last-write-wins
 * would destroy one of them silently, and there is no server-side copy to
 * recover from (XI). Losing the race must be *visible* to the loser, with the
 * other version in hand, or the product is quietly deleting the user's words.
 */

let f: Fixture

beforeEach(() => {
  f = fixture()
  f.seedMirror()
})

afterEach(() => {
  f.close()
})

function expectOperationError(fn: () => unknown): OperationError {
  try {
    fn()
  } catch (e) {
    if (isOperationError(e)) return e
    throw e
  }
  throw new Error('expected the write to be rejected, but it succeeded')
}

describe('a stale revision', () => {
  it('is rejected, and the rejection carries the current row', () => {
    const note = f.service.create(
      { subjectKey: SUBJECTS.ticket, type: 'decision', body: 'Original.' },
      ctxFor('user'),
    )

    // The agent gets there first.
    const won = f.service.update(
      { id: note.id, revision: note.revision, body: "The agent's version." },
      ctxFor('agent'),
    )
    expect(won.revision).toBe(2)

    // The user's modal still holds revision 1.
    const error = expectOperationError(() =>
      f.service.update({ id: note.id, revision: 1, body: "The user's version." }, ctxFor('user')),
    )

    expect(error.code).toBe('conflict')
    expect(error.details.current).toMatchObject({
      revision: 2,
      body: "The agent's version.",
    })

    // And the loser's text was not written anywhere.
    expect(f.service.list(SUBJECTS.ticket)[0]?.body).toBe("The agent's version.")
  })

  it('rejects the same revision being used twice', () => {
    const note = f.service.create(
      { subjectKey: SUBJECTS.ticket, type: 'todo', body: 'First.' },
      ctxFor('user'),
    )

    f.service.update({ id: note.id, revision: 1, body: 'Second.' }, ctxFor('user'))

    // A retry that replays the original request must not succeed. This is the
    // same guarantee as a single-use token, arrived at through the revision.
    expect(expectOperationError(() =>
      f.service.update({ id: note.id, revision: 1, body: 'Second again.' }, ctxFor('user')),
    ).code).toBe('conflict')
  })

  it('blocks a delete as well as an edit', () => {
    const note = f.service.create(
      { subjectKey: SUBJECTS.ticket, type: 'gotcha', body: 'The limiter warms lazily.' },
      ctxFor('user'),
    )

    f.service.update({ id: note.id, revision: 1, body: 'The limiter warms lazily. Cold on boot.' }, ctxFor('agent'))

    // Deleting on a stale revision destroys an edit the deleter never saw, so
    // it loses for the same reason an edit does.
    expect(expectOperationError(() => f.service.remove({ id: note.id, revision: 1 }, ctxFor('user'))).code).toBe(
      'conflict',
    )
    expect(f.service.list(SUBJECTS.ticket)).toHaveLength(1)

    // With the revision it actually has, it goes.
    f.service.remove({ id: note.id, revision: 2 }, ctxFor('user'))
    expect(f.service.list(SUBJECTS.ticket)).toHaveLength(0)
  })
})

describe('a note that is not there', () => {
  it('is not_found rather than conflict — the caller needs to tell them apart', () => {
    expect(
      expectOperationError(() =>
        f.service.update({ id: 'note:nope', revision: 1, body: 'x' }, ctxFor('user')),
      ).code,
    ).toBe('not_found')

    expect(
      expectOperationError(() => f.service.remove({ id: 'note:nope', revision: 1 }, ctxFor('user'))).code,
    ).toBe('not_found')
  })
})

describe('resolving a question', () => {
  it('settles it without deleting the exchange', () => {
    const question = f.service.create(
      {
        subjectKey: SUBJECTS.ticket,
        type: 'question-for-human',
        body: 'Should the export include archived rows?',
      },
      ctxFor('agent'),
    )

    expect(f.service.questions().map((n) => n.id)).toEqual([question.id])
    expect(f.service.openQuestionSubjects()).toEqual([SUBJECTS.ticket])

    const resolved = f.service.update({ id: question.id, revision: 1, resolved: true }, ctxFor('user'))

    expect(resolved.resolvedAt).not.toBeNull()
    // Off the Attention list, still on the ticket. The answer is worth keeping.
    expect(f.service.questions()).toEqual([])
    expect(f.service.openQuestionSubjects()).toEqual([])
    expect(f.service.list(SUBJECTS.ticket)).toHaveLength(1)

    // And it can be reopened, which is how a session returns to "needs you".
    f.service.update({ id: question.id, revision: 2, resolved: false }, ctxFor('agent'))
    expect(f.service.openQuestionSubjects()).toEqual([SUBJECTS.ticket])
  })
})

describe('a branch deleted and recreated with the same name', () => {
  it('re-attaches, because the key never depended on the row', () => {
    const note = f.service.create(
      { subjectKey: SUBJECTS.branch, type: 'gotcha', body: 'Rebase this before merging.' },
      ctxFor('user'),
    )

    f.mirror.prepare('DELETE FROM branch_refs').run()
    expect(f.service.list(SUBJECTS.branch)[0]?.orphaned).toBe(true)

    // Someone force-pushes the branch back. Same name, same remote, new row.
    seedBranch(f.mirror)

    const [back] = f.service.list(SUBJECTS.branch)
    expect(back?.id).toBe(note.id)
    expect(back?.orphaned).toBe(false)
    // Still editable at the revision it had. Orphaning is not a state change.
    expect(back?.revision).toBe(1)
  })
})

describe('counts and lists', () => {
  it('counts a whole lane in one call, and returns nothing for an empty request', () => {
    f.service.create({ subjectKey: SUBJECTS.ticket, type: 'todo', body: 'a' }, ctxFor('user'))
    f.service.create({ subjectKey: SUBJECTS.ticket, type: 'todo', body: 'b' }, ctxFor('user'))
    f.service.create({ subjectKey: SUBJECTS.pull, type: 'todo', body: 'c' }, ctxFor('user'))

    expect(f.service.counts([SUBJECTS.ticket, SUBJECTS.pull, SUBJECTS.branch])).toEqual({
      [SUBJECTS.ticket]: 2,
      [SUBJECTS.pull]: 1,
    })

    // An empty request means "no subjects", not "every subject". Getting this
    // backwards would build `IN ()`, which SQLite refuses to parse.
    expect(f.service.counts([])).toEqual({})
  })

  it('refuses an empty body rather than storing a blank note', () => {
    expect(
      expectOperationError(() =>
        f.service.create({ subjectKey: SUBJECTS.ticket, type: 'todo', body: '   ' }, ctxFor('user')),
      ).code,
    ).toBe('invalid')
  })
})
