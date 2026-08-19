import { describe, expect, it } from 'vitest'
import { ticketKey } from '../../src/domain/keys.js'
import { noteFieldsOf, resolveScenarioTime, resolveScenarioTimes } from '../../src/fixtures/scenario.js'

/**
 * The offset grammar (T051 — FR-118).
 *
 * Small enough to read and load-bearing enough to test: two programs resolve
 * scenario files with this, and a disagreement between them shows up as a board
 * that renders differently in the desktop shell and the text CLI over the same
 * fixture — which reads as a rendering bug and is not one.
 */

const NOW = new Date('2026-08-19T12:00:00.000Z')

describe('resolving one expression', () => {
  it('reads bare `now` as the load instant', () => {
    expect(resolveScenarioTime('now', NOW)).toBe('2026-08-19T12:00:00.000Z')
  })

  it.each([
    ['now-30s', '2026-08-19T11:59:30.000Z'],
    ['now-15m', '2026-08-19T11:45:00.000Z'],
    ['now-3h', '2026-08-19T09:00:00.000Z'],
    ['now-5d', '2026-08-14T12:00:00.000Z'],
    ['now-2w', '2026-08-05T12:00:00.000Z'],
    ['now+15m', '2026-08-19T12:15:00.000Z'],
    ['now-1.5h', '2026-08-19T10:30:00.000Z'],
  ])('resolves %s', (expression, expected) => {
    expect(resolveScenarioTime(expression, NOW)).toBe(expected)
  })

  /**
   * The anchoring, asserted rather than assumed.
   *
   * Every scenario is full of prose — ticket summaries, note bodies, reported
   * statuses — and this walks all of it. A pattern that matched anywhere in a
   * string would rewrite "the fix is in now-ish" into a timestamp, and the
   * fixture would carry a sentence nobody wrote.
   */
  it.each(['nowhere', 'right now', 'now-3', 'now-3y', 'NOW-3d', 'now -3d', '2026-08-14T12:00:00Z'])(
    'leaves %s alone',
    (text) => {
      expect(resolveScenarioTime(text, NOW)).toBeNull()
    },
  )
})

describe('resolving a whole scenario', () => {
  it('rewrites values at every depth and leaves keys and non-strings untouched', () => {
    const resolved = resolveScenarioTimes(
      {
        now: 'now',
        input: {
          tickets: [{ summary: 'Fix it now, please', fetchedAt: 'now-2m', storyPoints: 5 }],
          nothing: null,
          flag: false,
        },
      },
      NOW,
    )

    expect(resolved).toEqual({
      now: '2026-08-19T12:00:00.000Z',
      input: {
        tickets: [
          {
            summary: 'Fix it now, please',
            fetchedAt: '2026-08-19T11:58:00.000Z',
            storyPoints: 5,
          },
        ],
        nothing: null,
        flag: false,
      },
    })
  })

  /**
   * A key that happens to be an offset expression is still a key.
   *
   * `noteCounts` is keyed by natural key and `statusOverrides` by status name,
   * so a scenario's object keys are data the operator's providers chose. None of
   * them will ever be `now-3d`, and the reason to pin it anyway is that the walk
   * is generic: it would be one `Object.fromEntries` away from rewriting them.
   */
  it('never rewrites an object key', () => {
    expect(resolveScenarioTimes({ 'now-3d': 'now-3d' }, NOW)).toEqual({
      'now-3d': '2026-08-16T12:00:00.000Z',
    })
  })

  it('does not mutate what it was given', () => {
    const scenario = { now: 'now' }
    resolveScenarioTimes(scenario, NOW)
    expect(scenario.now).toBe('now')
  })
})

const A1 = ticketKey('site', 'A-1')
const A2 = ticketKey('site', 'A-2')

describe('the fields notes produce', () => {
  it('counts every note and opens a question only for the question type', () => {
    expect(
      noteFieldsOf([
        { subjectKey: A1, type: 'decision', body: 'one' },
        { subjectKey: A1, type: 'gotcha', body: 'two' },
        { subjectKey: A2, type: 'question-for-human', body: 'three' },
      ]),
    ).toEqual({
      noteCounts: { [A1]: 2, [A2]: 1 },
      openQuestionSubjects: [A2],
    })
  })

  it('reports no counts at all rather than zeroes for subjects with no notes', () => {
    // `noteCounts[key] ?? 0` is what the join does, so an explicit zero and an
    // absent key mean the same thing to it. They do not mean the same thing to
    // a reader diffing two fixtures, and the repository this mirrors returns
    // only the subjects it has rows for.
    expect(noteFieldsOf([])).toEqual({ noteCounts: {}, openQuestionSubjects: [] })
  })
})
