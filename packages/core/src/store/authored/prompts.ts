import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { Prompt } from '../../domain/types.js'

/**
 * Recorded prompts — appended, pruned by the same statement that appends, and
 * deletable one at a time.
 *
 * **The delete is the reason this table is different from `agent_updates`.** An
 * update is a thing that was said and stays said; a prompt is free text an agent
 * was handed, and it may contain a token somebody pasted into a chat window
 * (FR-140). The operator gets to remove one without removing the history around
 * it, so there is a `remove` here and there is deliberately still no `patch`:
 * editing a recorded prompt would make the panel's copy button reproduce
 * something that was never sent.
 *
 * **Nothing here truncates.** `text` goes in whole and comes out whole, and the
 * only bound in the feature is on how much of it a row *displays* (FR-138). A
 * limit at this layer would be the one truncation that cannot be undone.
 *
 * `session_key` and `project_id` are labels, not references. No join, no foreign
 * key, and a prompt outlives both — the same rule the rest of the authored store
 * follows.
 */

/**
 * How many prompts are kept, across everything.
 *
 * **Global rather than per session or per agent**, and that is the part worth
 * arguing. Updates are pruned per session because a session is the unit of "what
 * is happening now"; a prompt is kept because it might be sent again, and the
 * thing an operator reaches for is recent in wall-clock terms rather than recent
 * within some agent's run. One list, one bound, and the panel's newest-first
 * order is the same order the prune uses.
 *
 * The cost of that choice is real and worth stating: an agent recording a prompt
 * a minute will push the operator's older ones out inside a working day. That is
 * the correct failure for a panel titled "recent prompts" — the alternative,
 * per-agent quotas, keeps a flooded list flooded and adds a rule nobody can see.
 */
export const RETENTION = 200

export interface PromptFilter {
  sessionKey?: NaturalKey | undefined
  projectId?: string | undefined
  limit?: number | undefined
}

export interface PromptsRepository {
  /** Insert and prune, in one transaction. Returns the row as written. */
  record(prompt: Prompt): Prompt
  /** Newest first, always. */
  list(filter?: PromptFilter): Prompt[]
  /** The whole row, or null. What the clipboard path reads. */
  get(id: string): Prompt | null
  /** True when a row went. Deleting an id that is not there is not an error. */
  remove(id: string): boolean
}

export function promptsRepository(db: Database): PromptsRepository {
  const insert = db.prepare(`
    INSERT INTO prompts (id, text, agent_id, session_key, project_id, recorded_at)
    VALUES (@id, @text, @agentId, @sessionKey, @projectId, @recordedAt)
  `)

  /*
   * The prune, in the same shape `agent_updates` uses and for the same reason.
   *
   * `DELETE ... WHERE id NOT IN (newest N)` is correct whatever the table
   * already holds, where "count, compare, delete the difference" is three
   * statements that can disagree with each other. There is no `WHERE
   * session_key = ?` here and its absence is the whole of the policy above: one
   * list, one bound.
   *
   * `recorded_at DESC, id DESC` so two prompts recorded in the same second have
   * a stable order — otherwise the prune could keep a different two hundred than
   * the panel shows.
   */
  const prune = db.prepare(`
    DELETE FROM prompts
    WHERE id NOT IN (
      SELECT id FROM prompts ORDER BY recorded_at DESC, id DESC LIMIT ?
    )
  `)

  const write = db.transaction((prompt: Prompt) => {
    insert.run({
      id: prompt.id,
      text: prompt.text,
      agentId: prompt.agentId,
      sessionKey: prompt.sessionKey,
      projectId: prompt.projectId,
      recordedAt: prompt.recordedAt,
    })
    prune.run(RETENTION)
  })

  return {
    record(prompt: Prompt): Prompt {
      write(prompt)
      return prompt
    },

    list(filter: PromptFilter = {}): Prompt[] {
      const where: string[] = []
      const params: unknown[] = []

      if (filter.sessionKey !== undefined) {
        where.push('session_key = ?')
        params.push(filter.sessionKey)
      }
      if (filter.projectId !== undefined) {
        where.push('project_id = ?')
        params.push(filter.projectId)
      }

      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      const limit = filter.limit ?? 50

      const rows = db
        .prepare(`SELECT * FROM prompts ${clause} ORDER BY recorded_at DESC, id DESC LIMIT ?`)
        .all(...params, limit) as Record<string, unknown>[]

      return rows.map(toPrompt)
    },

    get(id: string): Prompt | null {
      const row = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined
      return row === undefined ? null : toPrompt(row)
    },

    remove(id: string): boolean {
      return db.prepare('DELETE FROM prompts WHERE id = ?').run(id).changes > 0
    },
  }
}

function toPrompt(row: Record<string, unknown>): Prompt {
  return {
    id: String(row['id']),
    text: String(row['text']),
    agentId: String(row['agent_id']),
    sessionKey: (row['session_key'] as NaturalKey | null) ?? null,
    projectId: (row['project_id'] as string | null) ?? null,
    recordedAt: String(row['recorded_at']),
  }
}
