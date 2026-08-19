/**
 * Scenario timestamps, expressed relative to the moment they are loaded
 * (FR-118).
 *
 * A checked-in scenario is a photograph of a board, and the board's meaning
 * depends on *when* it was taken. Severity is derived partly from staleness —
 * ≥1× a lane's threshold is a warning, ≥2× serious, ≥3× critical — so a fixture
 * carrying absolute dates does not hold still. `every-severity.json` was written
 * on 2026-08-14 with four items at four severities; a fortnight later every one
 * of them had aged past 3× and the scenario named for having all four produced
 * one. That is not a hypothetical: it is why three `greyscale.spec.ts` tests
 * were failing on `main` before this landed, and why they had been failing for
 * long enough that the failure had become part of the scenery.
 *
 * So a scenario says `now-5d`, not `2026-08-14T12:00:00Z`, and this resolves it.
 *
 * ## Why this ships
 *
 * It is dev-only code in a published package, which wants a reason. Two
 * different programs read scenario files — `packages/desktop/scripts/seed.mjs`,
 * which writes one into a real pair of databases, and `grndctrl-cli board`,
 * which renders one as text — and they have to resolve the offsets *identically*
 * or the same fixture means two different boards. `@grndctrl/core` is the only
 * thing both of them already import. A second copy of these twelve lines is
 * precisely the drift this exists to remove, so it is one copy behind a subpath
 * export the product itself never touches.
 *
 * ## The grammar
 *
 *   now          the load instant
 *   now-5d       five days before it
 *   now+15m      fifteen minutes after it
 *   now-1.5h     fractions are allowed; s, m, h, d, w are the units
 *
 * Anchored, so only a string that is *entirely* an offset expression is
 * rewritten. A ticket summary containing the word "now" is left alone; a
 * `reportedStatus` of exactly `"now"` would not be, which is a trade accepted
 * on the grounds that no scenario has ever wanted one.
 */

import type { NaturalKey } from '../domain/keys.js'
import type { NoteType } from '../domain/types.js'

const MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const OFFSET = /^now(?:([+-])(\d+(?:\.\d+)?)([smhdw]))?$/

/**
 * One expression, or `null` if the string is not one.
 *
 * `null` rather than a thrown error or the input echoed back, so the caller has
 * to decide — `resolveScenarioTimes` leaves non-expressions untouched, and a
 * caller wanting strictness can tell the two apart.
 */
export function resolveScenarioTime(expression: string, now: Date): string | null {
  const match = OFFSET.exec(expression)
  if (match === null) return null

  const [, sign, amount, unit] = match
  if (sign === undefined || amount === undefined || unit === undefined) {
    return now.toISOString()
  }

  const ms = (MS[unit] ?? 0) * Number(amount) * (sign === '-' ? -1 : 1)
  return new Date(now.getTime() + ms).toISOString()
}

/**
 * Every offset expression anywhere in a scenario, resolved against one instant.
 *
 * Deliberately structural rather than driven by a list of timestamp field names.
 * The scenario format grows — 007 adds ticket descriptions, agent transcripts
 * and a second lane's worth of rows — and a resolver holding a list of which
 * keys are dates is a resolver that silently stops resolving the new ones. What
 * it walks is *values*; keys are never touched, and neither is anything that is
 * not a string.
 */
export function resolveScenarioTimes<T>(value: T, now: Date): T {
  return walk(value, now) as T
}

/**
 * A note a scenario asks to exist before the board is looked at.
 *
 * There is no `resolved` here on purpose: a note is created unresolved and
 * settled by `notes.update`, so a resolved one is two calls rather than a field,
 * and no scenario has needed the second yet. If one does, this is where it goes
 * — not a `resolved` key that only one of the two readers honours.
 */
export interface ScenarioNote {
  subjectKey: NaturalKey
  type: NoteType
  body: string
}

/**
 * The two correlation inputs that notes produce, derived rather than declared.
 *
 * A scenario used to state `noteCounts` and `openQuestionSubjects` directly, and
 * only one of its two readers could act on them: the seed script writes to a
 * real authored store, where both numbers come from the notes that are actually
 * in it, so the declared ones were simply ignored. The canonical scenario said
 * MERC-1184 carried two notes and the seeded board showed none — a disagreement
 * between the two readers that nothing could catch, because each was internally
 * consistent.
 *
 * So the scenario states the notes, and this derives the rest. The rules are
 * `notesRepository.countsBySubject` and `openQuestionSubjects` restated over
 * plain data; if those ever diverge, `scenario-readers.test.ts` is where it
 * shows up.
 */
export function noteFieldsOf(notes: readonly ScenarioNote[]): {
  noteCounts: Record<string, number>
  openQuestionSubjects: string[]
} {
  const noteCounts: Record<string, number> = {}
  const questions = new Set<string>()

  for (const note of notes) {
    noteCounts[note.subjectKey] = (noteCounts[note.subjectKey] ?? 0) + 1
    if (note.type === 'question-for-human') questions.add(note.subjectKey)
  }

  return { noteCounts, openQuestionSubjects: [...questions] }
}

function walk(value: unknown, now: Date): unknown {
  if (typeof value === 'string') return resolveScenarioTime(value, now) ?? value
  if (Array.isArray(value)) return value.map((item) => walk(item, now))

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = walk(item, now)
    return out
  }

  return value
}
