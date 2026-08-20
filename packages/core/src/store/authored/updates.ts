import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { AgentUpdate } from '../../domain/types.js'

/**
 * Agent updates — append-only, and pruned by the same statement that appends.
 *
 * **There is no update and no delete here, and their absence is the design.** An
 * agent that said something wrong says something else; the operator reads a
 * history rather than a mutable status. That is the whole reason this is a table
 * and not `AgentSession.reportedStatus` (R5), and a `patch` method would give it
 * back without anybody deciding to.
 *
 * **Retention runs inside `append`** (FR-133). A scheduled prune is a thing that
 * can fail to run, and the way anyone finds out is a database nobody can open a
 * year later. Doing it in the same transaction as the insert costs one statement
 * and cannot be skipped, forgotten, or crash before it starts.
 *
 * Nothing here joins to `agent_sessions`. `sessionKey` is a natural key and
 * `agentId` is denormalised, so an update outlives the session row it came from
 * — which a history has to.
 */

/**
 * How many updates a session keeps.
 *
 * Chosen to be far more than a person will read and far less than a running
 * agent can produce in a day. An agent posting every thirty seconds fills this
 * in half an hour, which is the right shape: the panel is about what is
 * happening, and the tail of a long session is not it.
 */
export const RETENTION_PER_SESSION = 50

export interface UpdateFilter {
  sessionKey?: NaturalKey | undefined
  /** The ticket that was active when the update was posted, not a live join. */
  ticketKey?: NaturalKey | undefined
  limit?: number | undefined
}

export interface UpdatesRepository {
  /** Insert and prune, in one transaction. Returns the row as written. */
  append(update: AgentUpdate): AgentUpdate
  /** Newest first, always. Nothing reads these oldest-first. */
  list(filter?: UpdateFilter): AgentUpdate[]
}

export function updatesRepository(db: Database): UpdatesRepository {
  const insert = db.prepare(`
    INSERT INTO agent_updates (id, session_key, agent_id, ticket_key, text, posted_at)
    VALUES (@id, @sessionKey, @agentId, @ticketKey, @text, @postedAt)
  `)

  /*
   * The prune, and why it is written as a subquery rather than a count.
   *
   * `DELETE ... WHERE id NOT IN (newest N)` is correct whatever the table
   * already holds: a session that somehow accumulated a thousand rows is back
   * to fifty after one post, and a session with three is untouched. The
   * alternative — count, compare, delete the difference — is three statements
   * that can disagree with each other under a concurrent write.
   *
   * `posted_at DESC, id DESC` so two updates posted in the same second have a
   * stable order. Without the tiebreak the prune could keep a different fifty
   * than the panel shows.
   */
  const prune = db.prepare(`
    DELETE FROM agent_updates
    WHERE session_key = ?
      AND id NOT IN (
        SELECT id FROM agent_updates
        WHERE session_key = ?
        ORDER BY posted_at DESC, id DESC
        LIMIT ?
      )
  `)

  const write = db.transaction((update: AgentUpdate) => {
    insert.run({
      id: update.id,
      sessionKey: update.sessionKey,
      agentId: update.agentId,
      ticketKey: update.ticketKey,
      text: update.text,
      postedAt: update.postedAt,
    })
    prune.run(update.sessionKey, update.sessionKey, RETENTION_PER_SESSION)
  })

  return {
    append(update: AgentUpdate): AgentUpdate {
      write(update)
      return update
    },

    list(filter: UpdateFilter = {}): AgentUpdate[] {
      const where: string[] = []
      const params: unknown[] = []

      if (filter.sessionKey !== undefined) {
        where.push('session_key = ?')
        params.push(filter.sessionKey)
      }
      if (filter.ticketKey !== undefined) {
        where.push('ticket_key = ?')
        params.push(filter.ticketKey)
      }

      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      // The limit is always present. An unbounded read of an append-only table
      // is the kind of query that is fine until the day it is not, and every
      // caller here wants a page rather than everything.
      const limit = filter.limit ?? 200

      const rows = db
        .prepare(
          `SELECT * FROM agent_updates ${clause} ORDER BY posted_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, limit) as Record<string, unknown>[]

      return rows.map(toUpdate)
    },
  }
}

function toUpdate(row: Record<string, unknown>): AgentUpdate {
  return {
    id: String(row['id']),
    sessionKey: row['session_key'] as NaturalKey,
    agentId: String(row['agent_id']),
    ticketKey: (row['ticket_key'] as NaturalKey | null) ?? null,
    text: String(row['text']),
    postedAt: String(row['posted_at']),
  }
}
