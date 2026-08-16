import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { Note, NoteType, Timestamp } from '../../domain/types.js'

/**
 * Reading and writing notes — the user's own words, and the reason `authored.db`
 * exists at all.
 *
 * Two properties this file is responsible for, and both are load-bearing:
 *
 * 1. **The subject is a natural key, and nothing here resolves it.** There is no
 *    join to a mirrored row, and there could not be — the mirror is a different
 *    database file (XIII). A note on `jira:acme/MERC-1184` survives the mirror
 *    being deleted, and re-attaches on its own when the ticket comes back.
 * 2. **A revision mismatch loses the write.** The update is a single conditional
 *    statement, so two writers racing produce one winner and one `conflict` —
 *    rather than one writer silently overwriting the other, which is the
 *    concrete way authored data gets destroyed (FR-055).
 *
 * Orphan detection is deliberately *not* here. Deciding whether a subject still
 * exists means reading the mirror, and a store that touched both files would be
 * the exact coupling XIII forbids. The service does it, given a predicate.
 */

export interface NoteFilter {
  subjectKeys?: readonly NaturalKey[]
  types?: readonly NoteType[]
  /** Unresolved only — what Attention wants, since a settled question is not a nudge. */
  unresolvedOnly?: boolean
}

export interface NotePatch {
  body?: string
  type?: NoteType
  /** Tri-state on purpose: absent leaves it alone, `true` resolves, `false` reopens. */
  resolved?: boolean
}

export type NoteWriteResult =
  | { ok: true; note: Note }
  | { ok: false; reason: 'not_found' }
  /** Carries the current row so the caller can show both sides rather than just refusing. */
  | { ok: false; reason: 'conflict'; current: Note }

export interface NotesRepository {
  get(id: string): Note | null
  list(filter?: NoteFilter): Note[]
  /** Per-subject totals for the row badges — one call for a whole lane (FR-052). */
  countsBySubject(subjectKeys?: readonly NaturalKey[]): Record<string, number>
  /** Subjects carrying an unresolved question. Drives Attention and ball-in-court (FR-053). */
  openQuestionSubjects(): NaturalKey[]
  insert(note: Note): Note
  update(id: string, expectedRevision: number, patch: NotePatch, at: Timestamp): NoteWriteResult
  remove(id: string, expectedRevision: number): NoteWriteResult
}

export function notesRepository(db: Database): NotesRepository {
  const selectById = db.prepare('SELECT * FROM notes WHERE id = ?')

  const read = (id: string): Note | null => {
    const row = selectById.get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : toNote(row)
  }

  /**
   * A conditional write, and the reason it is one statement.
   *
   * Read-then-write would leave a window in which an agent's write lands between
   * the read and the update, and the update would then overwrite it while
   * believing the revision matched. `WHERE revision = ?` moves the check inside
   * the statement, so the loser changes zero rows and finds out.
   */
  const applyWrite = db.transaction(
    (sql: string, params: unknown[], id: string): { changed: boolean; row: Note | null } => {
      const changed = db.prepare(sql).run(...(params as never[])).changes > 0
      return { changed, row: read(id) }
    },
  )

  /**
   * A failed conditional write is either "gone" or "someone got there first",
   * and the caller needs to tell them apart — one is a stale link, the other is
   * a lost edit that must be shown rather than swallowed.
   */
  const explainFailure = (row: Note | null): NoteWriteResult =>
    row === null ? { ok: false, reason: 'not_found' } : { ok: false, reason: 'conflict', current: row }

  /**
   * Delete reads first, because after a successful delete there is nothing left
   * to read — and the caller still needs the row it removed, both to confirm
   * what went and to put it back if the user says undo.
   *
   * A delete carries a revision for the same reason an update does: deleting a
   * note edited a second ago destroys the edit, and the writer never finds out.
   */
  const removeTx = db.transaction((id: string, expectedRevision: number): NoteWriteResult => {
    const before = read(id)
    if (before === null) return { ok: false, reason: 'not_found' }

    const changed =
      db.prepare('DELETE FROM notes WHERE id = ? AND revision = ?').run(id, expectedRevision).changes > 0

    return changed ? { ok: true, note: before } : { ok: false, reason: 'conflict', current: before }
  })

  return {
    get: read,

    list(filter = {}) {
      const where: string[] = []
      const params: unknown[] = []

      if (filter.subjectKeys !== undefined) {
        // An empty list means "no subjects", not "every subject". `IN ()` is a
        // syntax error in SQLite, so it is short-circuited rather than built.
        if (filter.subjectKeys.length === 0) return []
        where.push(`subject_key IN (${filter.subjectKeys.map(() => '?').join(', ')})`)
        params.push(...filter.subjectKeys)
      }

      if (filter.types !== undefined) {
        if (filter.types.length === 0) return []
        where.push(`type IN (${filter.types.map(() => '?').join(', ')})`)
        params.push(...filter.types)
      }

      if (filter.unresolvedOnly === true) where.push('resolved_at IS NULL')

      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      // Ordered by creation then id: two notes written in the same millisecond
      // must still come back in a fixed order, or the board flickers (SC-004).
      const rows = db
        .prepare(`SELECT * FROM notes ${clause} ORDER BY created_at, id`)
        .all(...(params as never[])) as Record<string, unknown>[]

      return rows.map(toNote)
    },

    countsBySubject(subjectKeys) {
      if (subjectKeys !== undefined && subjectKeys.length === 0) return {}

      const clause =
        subjectKeys === undefined
          ? ''
          : `WHERE subject_key IN (${subjectKeys.map(() => '?').join(', ')})`

      const rows = db
        .prepare(`SELECT subject_key, COUNT(*) AS n FROM notes ${clause} GROUP BY subject_key`)
        .all(...((subjectKeys ?? []) as never[])) as { subject_key: string; n: number }[]

      const counts: Record<string, number> = {}
      for (const row of rows) counts[row.subject_key] = Number(row.n)
      return counts
    },

    openQuestionSubjects() {
      const rows = db
        .prepare(
          `SELECT DISTINCT subject_key FROM notes
            WHERE type = 'question-for-human' AND resolved_at IS NULL
            ORDER BY subject_key`,
        )
        .all() as { subject_key: string }[]

      return rows.map((r) => r.subject_key as NaturalKey)
    },

    insert(note) {
      db.prepare(
        `INSERT INTO notes
           (id, subject_key, type, body, author_kind, author_id, revision, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        note.id,
        note.subjectKey,
        note.type,
        note.body,
        note.authorKind,
        note.authorId,
        note.revision,
        note.createdAt,
        note.updatedAt,
        note.resolvedAt,
      )
      return note
    },

    update(id, expectedRevision, patch, at) {
      const sets: string[] = []
      const params: unknown[] = []

      if (patch.body !== undefined) {
        sets.push('body = ?')
        params.push(patch.body)
      }
      if (patch.type !== undefined) {
        sets.push('type = ?')
        params.push(patch.type)
      }
      if (patch.resolved !== undefined) {
        // Built as an explicit SET rather than a COALESCE, because reopening a
        // question means writing NULL and COALESCE cannot express that.
        sets.push('resolved_at = ?')
        params.push(patch.resolved ? at : null)
      }

      // The revision advances even on an empty patch. A no-op write is still a
      // write, and letting it succeed without advancing would hand the caller a
      // revision that another writer could then reuse.
      sets.push('revision = revision + 1', 'updated_at = ?')
      params.push(at, id, expectedRevision)

      const { changed, row } = applyWrite(
        `UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND revision = ?`,
        params,
        id,
      )

      if (!changed || row === null) return explainFailure(row)
      return { ok: true, note: row }
    },

    remove: (id, expectedRevision) => removeTx(id, expectedRevision),
  }
}

function toNote(row: Record<string, unknown>): Note {
  return {
    id: String(row['id']),
    subjectKey: row['subject_key'] as NaturalKey,
    type: row['type'] as NoteType,
    body: String(row['body']),
    authorKind: row['author_kind'] as Note['authorKind'],
    authorId: row['author_id'] === null || row['author_id'] === undefined ? null : String(row['author_id']),
    revision: Number(row['revision']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    resolvedAt:
      row['resolved_at'] === null || row['resolved_at'] === undefined ? null : String(row['resolved_at']),
  }
}
