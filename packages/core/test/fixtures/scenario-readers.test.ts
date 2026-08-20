import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionKey, ticketKey } from '../../src/domain/keys.js'
import { noteFieldsOf, type ScenarioNote } from '../../src/fixtures/scenario.js'
import { tempServices, type TempServices } from '../helpers/services.js'

/**
 * The two scenario readers, held against each other.
 *
 * A scenario file is loaded by two different programs. `seed.mjs` writes it into
 * a real pair of databases and lets the application derive everything from them;
 * `grndctrl-cli board` builds a `CorrelationInput` in memory. Anything a
 * scenario states that only one of them can act on is a fixture that means two
 * different boards — and that is not hypothetical: `noteCounts` was stated
 * directly, the canonical scenario said MERC-1184 carried two notes, and the
 * seeded board showed none. Each reader was internally consistent, so nothing
 * failed.
 *
 * The notes are stated once now and both fields derived. This is the test that
 * the derivation matches what the authored store actually does — the one place
 * the duplication could still hide.
 */

const SCENARIOS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
)

const ctx = {
  authorKind: 'user' as const,
  authorId: null,
  surface: 'ipc' as const,
  now: () => new Date('2026-08-19T12:00:00.000Z'),
}

const notesOf = (name: string): ScenarioNote[] =>
  (JSON.parse(readFileSync(join(SCENARIOS, `${name}.json`), 'utf8')) as { notes?: ScenarioNote[] })
    .notes ?? []

let harness: TempServices

beforeEach(() => {
  harness = tempServices()
})

afterEach(() => {
  harness.dispose()
})

/**
 * Write the notes, then compare.
 *
 * **The subject list comes from the notes, never from what `noteFieldsOf`
 * returned.** The first version of this asked the store only about the subjects
 * the derivation had already produced, which made it blind in the one direction
 * that matters: a derivation that silently dropped a subject was never asked
 * about it, so `{}` matched `{}` and the probe that broke it on purpose passed.
 * A control that reads only what it expects is not a control.
 */
function compare(notes: readonly ScenarioNote[]): void {
  for (const note of notes) {
    harness.services.notes.create(
      { subjectKey: note.subjectKey, type: note.type, body: note.body },
      ctx,
    )
  }

  const subjects = [...new Set(notes.map((n) => n.subjectKey))]
  const derived = noteFieldsOf(notes)

  expect(derived.noteCounts).toEqual(harness.services.notes.counts(subjects))
  expect([...derived.openQuestionSubjects].sort()).toEqual(
    [...harness.services.notes.openQuestionSubjects()].sort(),
  )
}

/**
 * A set covering both rules, so this file is not at the mercy of whatever the
 * checked-in scenarios happen to contain today. Neither of them currently has a
 * subject carrying two notes *and* a question, and a scenario is free to stop
 * having any notes at all — at which point the cases below would all be
 * comparing empty objects and reporting agreement.
 */
const COV1 = ticketKey('example.atlassian.net', 'COV-1')
const COV2 = ticketKey('example.atlassian.net', 'COV-2')
const AGENT = sessionKey('claude-code', '01HZ')

const COVERING: ScenarioNote[] = [
  { subjectKey: COV1, type: 'decision', body: 'first' },
  { subjectKey: COV1, type: 'gotcha', body: 'second' },
  { subjectKey: COV1, type: 'question-for-human', body: 'third' },
  { subjectKey: COV2, type: 'todo', body: 'fourth' },
  { subjectKey: AGENT, type: 'question-for-human', body: 'fifth' },
]

describe('the derived note fields', () => {
  it('match the authored store over every note type and subject kind', () => {
    compare(COVERING)

    // Named explicitly as well, because the comparison above would also be
    // satisfied by two identically wrong answers.
    expect(noteFieldsOf(COVERING)).toEqual({
      noteCounts: { [COV1]: 3, [COV2]: 1, [AGENT]: 1 },
      openQuestionSubjects: [COV1, AGENT],
    })
  })
})

/**
 * Read from the directory, not written out here.
 *
 * This was the literal `['canonical-board', 'every-severity']`, and 007 added a
 * third scenario that it would silently not have covered — which is the same
 * shape of staleness the rest of this file exists to catch, one level up. A
 * scenario nobody checks is a scenario that throws halfway through `seed.mjs`
 * and fails every spec reading it with a message about note subjects.
 */
const ALL_SCENARIOS = readdirSync(SCENARIOS)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

describe('the scenario directory', () => {
  it('has scenarios in it, so the cases below are over something', () => {
    // Without this the `describe.each` below would run zero times and report a
    // clean pass over nothing at all.
    expect(ALL_SCENARIOS.length).toBeGreaterThanOrEqual(2)
    expect(ALL_SCENARIOS).toContain('canonical-board')
  })
})

describe.each(ALL_SCENARIOS)('%s', (name) => {
  it('states notes at all, so the comparisons below are over something', () => {
    expect(notesOf(name).length).toBeGreaterThan(0)
  })

  it('derives the same counts and open questions the authored store does', () => {
    compare(notesOf(name))
  })

  /**
   * Every note in a scenario has to be attachable, or the seed script throws
   * halfway through and every spec reading that scenario fails at launch with a
   * message about note subjects rather than about whatever it was testing.
   */
  it('names only subjects a note can be attached to', () => {
    for (const note of notesOf(name)) {
      expect(() =>
        harness.services.notes.create(
          { subjectKey: note.subjectKey, type: note.type, body: note.body },
          ctx,
        ),
      ).not.toThrow()
    }
  })
})
