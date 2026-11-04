import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { AuthorKind, Timestamp, Todo } from '../../domain/types.js'

/**
 * The to-do list (009).
 *
 * No prune here, on purpose: a ticked-off to-do stays until the operator
 * deletes it. Writes after creation are conditional on the revision, the same
 * optimistic concurrency notes and the ticket history use, so an agent ticking
 * an item off while the operator edits it is a visible conflict rather than a
 * lost edit.
 */

export interface TodoFilter {
  /** Only to-dos linked to this ticket. */
  ticketKey?: string | undefined
  /** `open` (default), `done`, or `all`. */
  state?: 'open' | 'done' | 'all' | undefined
  limit?: number | undefined
}

export interface CreateTodoInput {
  id: string
  text: string
  ticketKey: NaturalKey | null
  authorKind: AuthorKind
  authorId: string | null
  at: Timestamp
}

export interface TodoPatch {
  text?: string | undefined
  /** `null` unlinks. Absent leaves the link alone. */
  ticketKey?: NaturalKey | null | undefined
  /** `null` reopens. Absent leaves it alone. */
  doneAt?: Timestamp | null | undefined
}

export type TodoWriteResult =
  | { ok: true; todo: Todo }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; current: Todo }

export interface TodosRepository {
  get(id: string): Todo | null
  /** Open items first, then oldest first — a list is worked top to bottom. */
  list(filter?: TodoFilter): Todo[]
  create(input: CreateTodoInput): Todo
  update(id: string, expectedRevision: number, patch: TodoPatch, at: Timestamp): TodoWriteResult
  remove(id: string, expectedRevision: number): TodoWriteResult
}

export function todosRepository(db: Database): TodosRepository {
  const selectById = db.prepare('SELECT * FROM todos WHERE id = ?')

  const read = (id: string): Todo | null => {
    const row = selectById.get(id) as Record<string, unknown> | undefined
    return row === undefined ? null : toTodo(row)
  }

  const insert = db.prepare(`
    INSERT INTO todos (id, text, ticket_key, done_at, author_kind, author_id, revision, created_at, updated_at)
    VALUES (@id, @text, @ticketKey, NULL, @authorKind, @authorId, 1, @at, @at)
  `)

  const updateTx = db.transaction(
    (id: string, expectedRevision: number, patch: TodoPatch, at: Timestamp): TodoWriteResult => {
      const sets: string[] = []
      const params: unknown[] = []

      if (patch.text !== undefined) {
        sets.push('text = ?')
        params.push(patch.text)
      }
      if (patch.ticketKey !== undefined) {
        sets.push('ticket_key = ?')
        params.push(patch.ticketKey)
      }
      if (patch.doneAt !== undefined) {
        sets.push('done_at = ?')
        params.push(patch.doneAt)
      }

      sets.push('revision = revision + 1', 'updated_at = ?')
      params.push(at, id, expectedRevision)

      const changed =
        db
          .prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
          .run(...(params as never[])).changes > 0

      const row = read(id)
      if (changed) return { ok: true, todo: row as Todo }
      return row === null
        ? { ok: false, reason: 'not_found' }
        : { ok: false, reason: 'conflict', current: row }
    },
  )

  const removeTx = db.transaction((id: string, expectedRevision: number): TodoWriteResult => {
    const before = read(id)
    if (before === null) return { ok: false, reason: 'not_found' }

    const changed =
      db.prepare('DELETE FROM todos WHERE id = ? AND revision = ?').run(id, expectedRevision)
        .changes > 0

    return changed ? { ok: true, todo: before } : { ok: false, reason: 'conflict', current: before }
  })

  return {
    get: read,

    list(filter = {}) {
      const where: string[] = []
      const params: unknown[] = []

      if (filter.ticketKey !== undefined) {
        where.push('ticket_key = ?')
        params.push(filter.ticketKey)
      }

      const state = filter.state ?? 'open'
      if (state === 'open') where.push('done_at IS NULL')
      if (state === 'done') where.push('done_at IS NOT NULL')

      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      const limit = filter.limit ?? 500

      // Open before done, then creation order, with the id breaking ties so two
      // items created in the same millisecond keep a fixed order.
      const rows = db
        .prepare(
          `SELECT * FROM todos ${clause}
           ORDER BY (done_at IS NOT NULL), created_at, id
           LIMIT ?`,
        )
        .all(...(params as never[]), limit) as Record<string, unknown>[]

      return rows.map(toTodo)
    },

    create(input) {
      insert.run(input)
      return read(input.id) as Todo
    },

    update: (id, expectedRevision, patch, at) => updateTx(id, expectedRevision, patch, at),
    remove: (id, expectedRevision) => removeTx(id, expectedRevision),
  }
}

function toTodo(row: Record<string, unknown>): Todo {
  return {
    id: String(row['id']),
    text: String(row['text']),
    ticketKey: (row['ticket_key'] as NaturalKey | null) ?? null,
    doneAt: (row['done_at'] as string | null) ?? null,
    authorKind: row['author_kind'] as AuthorKind,
    authorId: (row['author_id'] as string | null) ?? null,
    revision: Number(row['revision']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  }
}
