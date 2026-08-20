import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { AuthorKind, TicketHistoryEntry, Timestamp } from '../../domain/types.js'

/**
 * The ticket history — one row per ticket, kept for as long as the operator
 * keeps the database (008/FR-146, FR-150).
 *
 * ## There is no prune in this file and there must never be one
 *
 * `updates.ts` prunes to fifty per session and `prompts.ts` to two hundred
 * globally, both inside the same statement that writes. Copying either one here
 * would be a one-line change that passes every test in the product and destroys
 * the feature eighteen months later, silently, on the rows nobody has looked at
 * recently — which is the definition of the rows this table exists to hold.
 *
 * So: no `DELETE` runs here except the one the operator asks for by name.
 * `test/store/history-retention.test.ts` asserts that by writing far past any
 * bound the other two use and reading the first row back.
 *
 * ## Upsert, because the primary key *is* the ticket
 *
 * "One line per ticket" is enforced by the schema rather than by care: a second
 * entry for a ticket is not a duplicate row, it is a constraint failure. `record`
 * therefore never inserts blind — it is `INSERT ... ON CONFLICT DO UPDATE`, in
 * one statement, so two agents finishing work on the same ticket at the same
 * moment produce one row and not one exception.
 *
 * ## What the caller decides and what this decides
 *
 * The notes-merge rule is the service's (append, do not duplicate, do not exceed
 * the cap), so it arrives here as a callback and runs **inside** the write
 * transaction. That is not ceremony: read-then-write from the service would let
 * a second record land between the read and the update, and the merge would then
 * append to notes it had never seen. The policy stays where it can be read; the
 * atomicity stays where it can be guaranteed.
 *
 * `ticketSummary` is `COALESCE`d rather than assigned. `null` from the caller
 * means "the mirror could not answer", which must leave the last summary seen
 * in place — a closed ticket has left the mirror, and that is exactly when the
 * snapshot is the only label the entry has (FR-149).
 */

export interface HistoryFilter {
  /**
   * A substring, matched against the ticket key, the line and the notes.
   *
   * The operator's question is "what did we do about X", and X is as likely to
   * be a word from the notes as an issue key. Case-insensitive for ASCII, which
   * is what SQLite's `LIKE` gives without a collation of our own.
   */
  q?: string | undefined
  limit?: number | undefined
}

export interface RecordHistoryInput {
  ticketKey: NaturalKey
  line: string
  /**
   * Given the notes as stored, return the notes to store.
   *
   * Runs inside the write. Throwing from it rolls the write back, which is how
   * the size cap refuses without leaving a half-applied entry.
   */
  mergeNotes(existing: string | null): string | null
  /** `null` means the mirror could not answer; the stored snapshot is kept. */
  ticketSummary: string | null
  authorKind: AuthorKind
  authorId: string | null
  at: Timestamp
}

export interface HistoryPatch {
  line?: string | undefined
  /** `null` clears the notes. Absent leaves them alone. */
  notes?: string | null | undefined
}

export type HistoryWriteResult =
  | { ok: true; entry: TicketHistoryEntry }
  | { ok: false; reason: 'not_found' }
  /** Carries the row that won, so the operator sees both rather than only a refusal. */
  | { ok: false; reason: 'conflict'; current: TicketHistoryEntry }

export interface HistoryRepository {
  get(ticketKey: NaturalKey | string): TicketHistoryEntry | null
  /** Most recently written first. */
  list(filter?: HistoryFilter): TicketHistoryEntry[]
  /** Insert or update, in one statement. */
  record(input: RecordHistoryInput): TicketHistoryEntry
  /** The operator's wholesale rewrite. Conditional on the revision (FR-155). */
  revise(
    ticketKey: NaturalKey | string,
    expectedRevision: number,
    patch: HistoryPatch,
    at: Timestamp,
  ): HistoryWriteResult
  /** Conditional on the revision too: deleting an entry edited a second ago loses it. */
  remove(ticketKey: NaturalKey | string, expectedRevision: number): HistoryWriteResult
}

export function historyRepository(db: Database): HistoryRepository {
  const selectByKey = db.prepare('SELECT * FROM ticket_history WHERE ticket_key = ?')

  const read = (ticketKey: NaturalKey | string): TicketHistoryEntry | null => {
    const row = selectByKey.get(ticketKey) as Record<string, unknown> | undefined
    return row === undefined ? null : toEntry(row)
  }

  /*
   * One statement, and the `excluded.` prefix is what makes it one.
   *
   * `revision + 1` and `created_at` untouched on the update branch: an entry
   * recorded against ten times is still the same entry, created when the first
   * write happened. The merged notes are computed before the statement runs but
   * inside the same transaction, so nothing can land between the two.
   */
  const upsert = db.prepare(`
    INSERT INTO ticket_history
      (ticket_key, line, notes, ticket_summary, author_kind, author_id, revision, created_at, updated_at)
    VALUES (@ticketKey, @line, @notes, @ticketSummary, @authorKind, @authorId, 1, @at, @at)
    ON CONFLICT (ticket_key) DO UPDATE SET
      line           = excluded.line,
      notes          = excluded.notes,
      ticket_summary = COALESCE(excluded.ticket_summary, ticket_history.ticket_summary),
      author_kind    = excluded.author_kind,
      author_id      = excluded.author_id,
      revision       = ticket_history.revision + 1,
      updated_at     = excluded.updated_at
  `)

  const recordTx = db.transaction((input: RecordHistoryInput): TicketHistoryEntry => {
    const existing = read(input.ticketKey)

    upsert.run({
      ticketKey: input.ticketKey,
      line: input.line,
      notes: input.mergeNotes(existing?.notes ?? null),
      ticketSummary: input.ticketSummary,
      authorKind: input.authorKind,
      authorId: input.authorId,
      at: input.at,
    })

    // Read back rather than reconstruct. `revision` and `ticket_summary` are both
    // decided by the statement, and a caller handed a locally-assembled copy
    // would hold a revision that is one behind on every update.
    const written = read(input.ticketKey)
    if (written === null) {
      throw new Error(`The history entry for '${input.ticketKey}' vanished during its own write.`)
    }
    return written
  })

  const reviseTx = db.transaction(
    (
      ticketKey: NaturalKey | string,
      expectedRevision: number,
      patch: HistoryPatch,
      at: Timestamp,
    ): HistoryWriteResult => {
      const sets: string[] = []
      const params: unknown[] = []

      if (patch.line !== undefined) {
        sets.push('line = ?')
        params.push(patch.line)
      }
      if (patch.notes !== undefined) {
        sets.push('notes = ?')
        params.push(patch.notes)
      }

      sets.push('revision = revision + 1', 'updated_at = ?')
      params.push(at, ticketKey, expectedRevision)

      const changed =
        db
          .prepare(
            `UPDATE ticket_history SET ${sets.join(', ')} WHERE ticket_key = ? AND revision = ?`,
          )
          .run(...(params as never[])).changes > 0

      const row = read(ticketKey)
      if (changed) {
        // Non-null by construction: the statement just updated it.
        return { ok: true, entry: row as TicketHistoryEntry }
      }
      // Two different failures, and the caller shows two different things: a
      // stale link, or somebody else's write that would have been destroyed.
      return row === null
        ? { ok: false, reason: 'not_found' }
        : { ok: false, reason: 'conflict', current: row }
    },
  )

  const removeTx = db.transaction(
    (ticketKey: NaturalKey | string, expectedRevision: number): HistoryWriteResult => {
      const before = read(ticketKey)
      if (before === null) return { ok: false, reason: 'not_found' }

      const changed =
        db
          .prepare('DELETE FROM ticket_history WHERE ticket_key = ? AND revision = ?')
          .run(ticketKey, expectedRevision).changes > 0

      // The row that went is handed back, both to confirm what was removed and
      // because it is the only copy left if the operator says undo.
      return changed
        ? { ok: true, entry: before }
        : { ok: false, reason: 'conflict', current: before }
    },
  )

  return {
    get: read,

    list(filter = {}) {
      const where: string[] = []
      const params: unknown[] = []

      const term = filter.q?.trim() ?? ''
      if (term !== '') {
        // `%` and `_` are wildcards in LIKE, and an operator searching for a
        // literal underscore in a branch-shaped key would otherwise match
        // everything. Escaped rather than stripped: their search term is theirs.
        const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`)
        const pattern = `%${escaped}%`
        where.push(
          `(ticket_key LIKE ? ESCAPE '\\' OR line LIKE ? ESCAPE '\\'` +
            ` OR (notes IS NOT NULL AND notes LIKE ? ESCAPE '\\'))`,
        )
        params.push(pattern, pattern, pattern)
      }

      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      const limit = filter.limit ?? 200

      // `ticket_key` breaks the tie, so two entries written in the same second
      // come back in a fixed order rather than whatever the page happens to
      // produce — the same rule the note list follows (SC-004).
      const rows = db
        .prepare(
          `SELECT * FROM ticket_history ${clause} ORDER BY updated_at DESC, ticket_key LIMIT ?`,
        )
        .all(...(params as never[]), limit) as Record<string, unknown>[]

      return rows.map(toEntry)
    },

    record: (input) => recordTx(input),
    revise: (ticketKey, expectedRevision, patch, at) =>
      reviseTx(ticketKey, expectedRevision, patch, at),
    remove: (ticketKey, expectedRevision) => removeTx(ticketKey, expectedRevision),
  }
}

function toEntry(row: Record<string, unknown>): TicketHistoryEntry {
  return {
    ticketKey: String(row['ticket_key']) as NaturalKey,
    line: String(row['line']),
    notes: (row['notes'] as string | null) ?? null,
    ticketSummary: (row['ticket_summary'] as string | null) ?? null,
    authorKind: row['author_kind'] as AuthorKind,
    authorId: (row['author_id'] as string | null) ?? null,
    revision: Number(row['revision']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  }
}
