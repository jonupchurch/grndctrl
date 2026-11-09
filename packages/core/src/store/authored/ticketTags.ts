import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { AuthorKind, TicketTag, Timestamp } from '../../domain/types.js'

/**
 * Which tag each ticket carries (010). One row per tagged ticket; clearing a
 * tag deletes the row, so "no tag" has one spelling.
 */

export interface TicketTagsRepository {
  list(): TicketTag[]
  get(ticketKey: string): TicketTag | null
  set(input: {
    ticketKey: NaturalKey
    tagId: string
    authorKind: AuthorKind
    authorId: string | null
    at: Timestamp
  }): TicketTag
  clear(ticketKey: string): boolean
}

export function ticketTagsRepository(db: Database): TicketTagsRepository {
  const selectOne = db.prepare('SELECT * FROM ticket_tags WHERE ticket_key = ?')

  const get = (ticketKey: string): TicketTag | null => {
    const row = selectOne.get(ticketKey) as Record<string, unknown> | undefined
    return row === undefined ? null : toTag(row)
  }

  return {
    list() {
      const rows = db.prepare('SELECT * FROM ticket_tags ORDER BY ticket_key').all() as Record<
        string,
        unknown
      >[]
      return rows.map(toTag)
    },

    get,

    set(input) {
      db.prepare(
        `INSERT INTO ticket_tags (ticket_key, tag_id, author_kind, author_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ticket_key) DO UPDATE SET
           tag_id = excluded.tag_id, author_kind = excluded.author_kind,
           author_id = excluded.author_id, updated_at = excluded.updated_at`,
      ).run(input.ticketKey, input.tagId, input.authorKind, input.authorId, input.at)
      return get(input.ticketKey) as TicketTag
    },

    clear: (ticketKey) =>
      db.prepare('DELETE FROM ticket_tags WHERE ticket_key = ?').run(ticketKey).changes > 0,
  }
}

function toTag(row: Record<string, unknown>): TicketTag {
  return {
    ticketKey: row['ticket_key'] as NaturalKey,
    tagId: row['tag_id'] as string,
    authorKind: row['author_kind'] as AuthorKind,
    authorId: (row['author_id'] as string | null) ?? null,
    updatedAt: row['updated_at'] as Timestamp,
  }
}
