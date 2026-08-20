import { randomUUID } from 'node:crypto'
import type { NaturalKey, SubjectKind } from '../domain/keys.js'
import { subjectKindOf } from '../domain/keys.js'
import type { Note, NoteType } from '../domain/types.js'
import { conflict, invalid, notFound } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { NotesRepository, NoteWriteResult } from '../store/authored/notes.js'

/**
 * Notes — the one thing in this product that is nobody's copy of anything.
 *
 * Everything else on the board can be thrown away and re-fetched. A note cannot;
 * there is no server-side original (XI, XIII). That asymmetry decides every rule
 * in this file:
 *
 * - A write that loses its revision race is **rejected**, and the current row
 *   comes back with the rejection so the writer can show both versions. Merging
 *   or last-write-wins would destroy the losing text silently, which is the
 *   failure this is here to prevent (FR-055).
 * - A note whose subject has vanished from the mirror is **kept** and flagged
 *   `orphaned`. Deleting it would be the product throwing away the user's words
 *   because a cache went stale (FR-056).
 * - `authorKind` comes from the adapter's `Ctx`, never from the payload. An
 *   agent calling over MCP cannot post as the user.
 */

/**
 * Whether the mirror currently knows this note's subject.
 *
 * Three states, not two, for the same reason freshness has four: before the
 * first sync the mirror is empty, and a two-state answer would report **every**
 * note as orphaned on first launch — the most alarming possible screen, and
 * completely wrong. `unknown` says "the mirror cannot answer yet".
 */
export type SubjectPresence = 'present' | 'absent' | 'unknown'

/** A note plus the one fact the store cannot know, because the mirror is a different file. */
export interface NoteView extends Note {
  subjectPresence: SubjectPresence
  /** Strictly `absent`. An unknown subject is never reported as orphaned. */
  orphaned: boolean
}

/**
 * Notes attach to work, not to everything.
 *
 * `check` and bare `repository` keys are excluded: a note on a single CI run is
 * attached to something that is replaced on the next push, and a repository-wide
 * note has no row on the board to surface a count on. Sessions are included
 * because a `question-for-human` on a session is what puts it in "needs you".
 */
const NOTEABLE: readonly SubjectKind[] = ['ticket', 'pull-request', 'branch', 'workspace', 'session']

/** Long enough for a real handover note; short enough that nothing is pasting a log file in. */
const MAX_BODY = 8000

export interface NotesServiceDeps {
  notes: NotesRepository
  /**
   * Whether the mirror currently knows this subject. Injected rather than read
   * here, because resolving it means touching `mirror.db` and a service that
   * held both handles would be the coupling XIII exists to forbid.
   */
  subjectPresence(key: NaturalKey): SubjectPresence
  /**
   * Refuses a ticket key naming a Jira site no connection knows (`sites.ts`).
   *
   * Separate from `subjectPresence` because the two answer different questions
   * and only one of them is a reason to refuse a write: presence says whether
   * the mirror *has* this ticket, which is allowed to be "not yet"; this says
   * whether the key could ever name anything at all.
   *
   * Optional so a caller that has not wired it keeps the old behaviour rather
   * than crashing — the composition root supplies the real one.
   */
  assertKnownSite?(key: NaturalKey): void
  /** Overridable so tests get stable ids without stubbing global crypto. */
  newId?(): string
}

export interface CreateNoteInput {
  subjectKey: NaturalKey
  type: NoteType
  body: string
}

export interface UpdateNoteInput {
  id: string
  revision: number
  // `| undefined` spelled out because `exactOptionalPropertyTypes` is on and
  // these arrive from a Zod-parsed payload, where an absent key really is
  // `undefined` rather than missing.
  body?: string | undefined
  type?: NoteType | undefined
  /**
   * Resolving a question is how a session leaves "needs you".
   *
   * **Deviation from contracts/operations.md**, which lists only `body?` and
   * `type?`. Without this there is no way to settle a question except deleting
   * the note, which throws away the answer along with the question — and the
   * session state machine in data-model.md explicitly requires a
   * "question resolved" transition.
   */
  resolved?: boolean | undefined
}

export interface NotesService {
  list(subjectKey: NaturalKey): NoteView[]
  counts(subjectKeys: readonly NaturalKey[]): Record<string, number>
  /** Unresolved questions, newest concern first — the Attention nudges (FR-053). */
  questions(): NoteView[]
  openQuestionSubjects(): NaturalKey[]
  create(input: CreateNoteInput, ctx: Ctx): NoteView
  update(input: UpdateNoteInput, ctx: Ctx): NoteView
  remove(input: { id: string; revision: number }, ctx: Ctx): { id: string }
}

export function notesService(deps: NotesServiceDeps): NotesService {
  const { notes, subjectPresence } = deps
  const newId = deps.newId ?? (() => `note:${randomUUID()}`)

  const view = (note: Note): NoteView => {
    const presence = subjectPresence(note.subjectKey)
    return { ...note, subjectPresence: presence, orphaned: presence === 'absent' }
  }

  /**
   * Turn a lost race into the error taxonomy, carrying the current row.
   *
   * The row travels with the error deliberately: "someone else changed this"
   * without showing what they changed is an error message that forces the user
   * to reload and lose their draft to find out.
   */
  const unwrap = (result: NoteWriteResult): Note => {
    if (result.ok) return result.note
    if (result.reason === 'not_found') throw notFound('That note no longer exists.')
    throw conflict(
      'This note was changed by someone else while you were editing it.',
      view(result.current),
    )
  }

  return {
    list: (subjectKey) => notes.list({ subjectKeys: [subjectKey] }).map(view),

    counts: (subjectKeys) => notes.countsBySubject(subjectKeys),

    questions: () =>
      notes.list({ types: ['question-for-human'], unresolvedOnly: true }).map(view),

    openQuestionSubjects: () => notes.openQuestionSubjects(),

    create(input, ctx) {
      const kind = subjectKindOf(input.subjectKey)
      if (kind === null || !NOTEABLE.includes(kind)) {
        throw invalid(`Notes cannot be attached to '${input.subjectKey}'.`)
      }

      // Before the write, not after. A note on an unresolvable site was
      // previously accepted, stored, and returned with `orphaned: true` — which
      // reads as normal to an agent, so nothing surfaced the mistake.
      deps.assertKnownSite?.(input.subjectKey)

      const body = input.body.trim()
      if (body === '') throw invalid('A note needs a body.')
      if (body.length > MAX_BODY) throw invalid(`A note may be at most ${MAX_BODY} characters.`)

      const at = ctx.now().toISOString()

      return view(
        notes.insert({
          id: newId(),
          subjectKey: input.subjectKey,
          type: input.type,
          body,
          // From the transport. The payload is not consulted, and there is no
          // field on the input to consult even if someone wanted to.
          authorKind: ctx.authorKind,
          authorId: ctx.authorId,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          resolvedAt: null,
        }),
      )
    },

    update(input, ctx) {
      if (input.body !== undefined) {
        const body = input.body.trim()
        if (body === '') throw invalid('A note needs a body.')
        if (body.length > MAX_BODY) throw invalid(`A note may be at most ${MAX_BODY} characters.`)
      }

      const patch = {
        ...(input.body === undefined ? {} : { body: input.body.trim() }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
      }

      // Anyone may edit anyone's note, including a user editing an agent's.
      // A shared board where the operator cannot correct an agent's note would
      // just push them to delete it instead, which loses more.
      return view(unwrap(notes.update(input.id, input.revision, patch, ctx.now().toISOString())))
    },

    remove(input) {
      unwrap(notes.remove(input.id, input.revision))
      return { id: input.id }
    },
  }
}
