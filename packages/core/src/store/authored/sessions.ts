import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type { AgentSession, Timestamp } from '../../domain/types.js'

/**
 * Agent sessions, stored by natural key.
 *
 * The key is `session:<agentId>/<sessionId>`, which the agent supplies, so a
 * restarted agent reporting the same session is the *same row* — see
 * `upsertStart`. That is what makes a start idempotent rather than a way to
 * accumulate ghost sessions (FR-044).
 *
 * What is deliberately absent: any column holding `running` or `silent`. State
 * is derived at read time from the heartbeat clock (FR-046). Storing it would
 * mean a process that died between beats leaves `running` on disk forever, and
 * every restart would inherit a lie it has no way to detect.
 */

export interface SessionsRepository {
  get(key: NaturalKey): AgentSession | null
  has(key: NaturalKey): boolean
  /** Every session, ended ones included — the panel shows recent history too. */
  list(): AgentSession[]
  /** Insert, or resume an existing key without losing its original `startedAt`. */
  upsertStart(session: AgentSession): AgentSession
  /** Returns the updated row, or null when the key is unknown. */
  patch(key: NaturalKey, patch: SessionPatch): AgentSession | null
}

export interface SessionPatch {
  lastHeartbeatAt?: Timestamp
  /** Advanced only by a real activity report, never by a heartbeat. */
  lastRealActivityAt?: Timestamp
  reportedStatus?: string | null
  workItemKey?: NaturalKey | null
  projectId?: string | null
  endedAt?: Timestamp | null
  outcome?: 'done' | 'failed' | null
}

export function sessionsRepository(db: Database): SessionsRepository {
  const read = (key: NaturalKey): AgentSession | null => {
    const row = db.prepare('SELECT * FROM agent_sessions WHERE key = ?').get(key) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? null : toSession(row)
  }

  /**
   * A start for a key that already exists is a resumption.
   *
   * `started_at` is left alone on conflict on purpose: an agent that crashes and
   * reconnects three times has been working on this since the first start, and
   * resetting the clock each time would make a long-running session look
   * perpetually new — hiding exactly the stall the board exists to show.
   *
   * `ended_at` and `outcome` are cleared, because reporting a start after an end
   * is a genuine resumption of finished work rather than a duplicate.
   */
  const upsert = db.prepare(
    `INSERT INTO agent_sessions
       (key, agent_id, session_id, project_id, work_item_key, reported_status,
        started_at, last_heartbeat_at, last_real_activity_at, ended_at, outcome, heartbeat_interval_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       project_id             = excluded.project_id,
       work_item_key          = excluded.work_item_key,
       reported_status        = excluded.reported_status,
       last_heartbeat_at      = excluded.last_heartbeat_at,
       ended_at               = NULL,
       outcome                = NULL,
       heartbeat_interval_sec = excluded.heartbeat_interval_sec`,
  )

  return {
    get: read,

    has: (key) =>
      db.prepare('SELECT 1 FROM agent_sessions WHERE key = ? LIMIT 1').get(key) !== undefined,

    list() {
      const rows = db
        .prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC, key')
        .all() as Record<string, unknown>[]
      return rows.map(toSession)
    },

    upsertStart(session) {
      upsert.run(
        session.key,
        session.agentId,
        session.sessionId,
        session.projectId,
        session.workItemKey,
        session.reportedStatus,
        session.startedAt,
        session.lastHeartbeatAt,
        session.lastRealActivityAt,
        session.endedAt,
        session.outcome,
        session.heartbeatIntervalSec,
      )
      // Read back rather than returning the argument: on a resumption the stored
      // `startedAt` is the original, not the one just passed in.
      return read(session.key) as AgentSession
    },

    patch(key, patch) {
      const sets: string[] = []
      const params: unknown[] = []

      const column: Record<keyof SessionPatch, string> = {
        lastHeartbeatAt: 'last_heartbeat_at',
        lastRealActivityAt: 'last_real_activity_at',
        reportedStatus: 'reported_status',
        workItemKey: 'work_item_key',
        projectId: 'project_id',
        endedAt: 'ended_at',
        outcome: 'outcome',
      }

      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue
        sets.push(`${column[field as keyof SessionPatch]} = ?`)
        params.push(value)
      }

      if (sets.length === 0) return read(key)

      params.push(key)
      const changed =
        db.prepare(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE key = ?`).run(...(params as never[]))
          .changes > 0

      return changed ? read(key) : null
    },
  }
}

function toSession(row: Record<string, unknown>): AgentSession {
  const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

  return {
    key: row['key'] as NaturalKey,
    agentId: String(row['agent_id']),
    sessionId: String(row['session_id']),
    projectId: nullable(row['project_id']),
    workItemKey: nullable(row['work_item_key']) as NaturalKey | null,
    reportedStatus: nullable(row['reported_status']),
    startedAt: String(row['started_at']),
    lastHeartbeatAt: String(row['last_heartbeat_at']),
    lastRealActivityAt: nullable(row['last_real_activity_at']),
    endedAt: nullable(row['ended_at']),
    outcome: nullable(row['outcome']) as 'done' | 'failed' | null,
    heartbeatIntervalSec: Number(row['heartbeat_interval_sec']),
  }
}
