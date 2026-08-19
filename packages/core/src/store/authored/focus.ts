import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { ActiveTicket, AuthorKind } from '../../domain/types.js'

/**
 * The active ticket — one authored pointer, stored as at most one row.
 *
 * Small enough that the only things worth stating are the two it does *not* do.
 *
 * It does not resolve the key. There is no join here and there could not be one:
 * the ticket lives in `mirror.db` (XIII), and FR-131 requires the pointer to be
 * settable at a ticket the mirror has never held. Whether the mirror knows it is
 * a question for whoever composes the panel, and the answer is allowed to be no.
 *
 * It does not decide who set it. `setBy` arrives already stamped from the
 * caller's `Ctx`; a repository that read an author from anywhere would be a
 * second place for an agent to claim it was the operator.
 */

export interface FocusRepository {
  get(): ActiveTicket | null
  /** Upsert. Setting focus twice is one row, not a history — the panel shows what is current. */
  set(active: ActiveTicket): ActiveTicket
  /** True when there was something to clear, so a caller can distinguish it from a no-op. */
  clear(): boolean
}

export function focusRepository(db: Database): FocusRepository {
  const selectRow = db.prepare('SELECT * FROM active_ticket WHERE id = 1')

  const upsert = db.prepare(`
    INSERT INTO active_ticket (id, ticket_key, set_by, set_by_id, set_at)
    VALUES (1, @ticketKey, @setBy, @setById, @setAt)
    ON CONFLICT(id) DO UPDATE SET
      ticket_key = excluded.ticket_key,
      set_by     = excluded.set_by,
      set_by_id  = excluded.set_by_id,
      set_at     = excluded.set_at
  `)

  const deleteRow = db.prepare('DELETE FROM active_ticket WHERE id = 1')

  return {
    get(): ActiveTicket | null {
      const row = selectRow.get() as Record<string, unknown> | undefined
      return row === undefined ? null : toActiveTicket(row)
    },

    set(active: ActiveTicket): ActiveTicket {
      upsert.run({
        ticketKey: active.ticketKey,
        setBy: active.setBy,
        setById: active.setById,
        setAt: active.setAt,
      })
      return active
    },

    clear(): boolean {
      return deleteRow.run().changes > 0
    },
  }
}

function toActiveTicket(row: Record<string, unknown>): ActiveTicket {
  return {
    ticketKey: row['ticket_key'] as NaturalKey,
    setBy: row['set_by'] as AuthorKind,
    setById: (row['set_by_id'] as string | null) ?? null,
    setAt: row['set_at'] as string,
  }
}
