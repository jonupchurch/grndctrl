import type { Database } from 'better-sqlite3'
import type { NaturalKey } from '../../domain/keys.js'
import type {
  ActionHistoryEntry,
  ActionKind,
  ActionState,
  OutboxAction,
  Timestamp,
} from '../../domain/types.js'

/**
 * The action outbox: durable, append-only, and never written to by accident.
 *
 * This is the one place in the product where a change to the outside world
 * begins, so the storage rules are stricter than anywhere else:
 *
 * - **`confirmed_at` is NOT NULL at insert.** An unconfirmed action cannot be
 *   represented, so "we forgot to ask the user" is a constraint violation
 *   rather than a code review finding (FR-059, XVI).
 * - **Every transition is a conditional update.** `WHERE state = 'pending'`
 *   means a second claimant changes zero rows and is told so, rather than two
 *   agents both believing they own the same action (FR-062).
 * - **`history` is appended by SQL, never rewritten.** `json_insert(history,
 *   '$[#]', ...)` adds one element inside the same statement that makes the
 *   change, so there is no read-modify-write window and no code path that can
 *   replace the log with a shorter one.
 *
 * Ground Control still never performs the write itself. The row is a request an
 * agent picks up and executes with its own credentials.
 */

export interface OutboxFilter {
  states?: readonly ActionState[]
  subjectKey?: NaturalKey
}

export interface OutboxRepository {
  insert(action: OutboxAction): OutboxAction
  get(id: string): OutboxAction | null
  list(filter?: OutboxFilter): OutboxAction[]

  /**
   * `pending` → `claimed`, atomically. Returns null when it was already taken —
   * which is a normal race between two polling agents, not an error condition.
   */
  claim(
    id: string,
    claimedBy: string,
    at: Timestamp,
    expiresAt: Timestamp,
    entry: ActionHistoryEntry,
  ): OutboxAction | null

  /** Any other conditional transition. Returns null when the row was not in `from`. */
  transition(
    id: string,
    from: readonly ActionState[],
    to: ActionState,
    patch: TransitionPatch,
    entry: ActionHistoryEntry,
  ): OutboxAction | null

  /** Sweep claims whose lease ran out back to `pending`. Returns the ids revived. */
  expireClaims(now: Timestamp): string[]
}

export interface TransitionPatch {
  result?: string | null
  failureReason?: string | null
  completedAt?: Timestamp | null
  clearClaim?: boolean
}

export function outboxRepository(db: Database): OutboxRepository {
  const read = (id: string): OutboxAction | null => {
    const row = db.prepare('SELECT * FROM outbox_actions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? null : toAction(row)
  }

  const inList = (states: readonly string[]): string => states.map(() => '?').join(', ')

  return {
    insert(action) {
      db.prepare(
        `INSERT INTO outbox_actions
           (id, subject_key, kind, payload, motivating_finding_id, state,
            confirmed_at, confirmed_via, history)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        action.id,
        action.subjectKey,
        action.kind,
        JSON.stringify(action.payload),
        action.motivatingFindingId,
        action.state,
        // Both NOT NULL in the schema. Passing null here fails at the database,
        // which is the intended last line of defence.
        action.confirmedAt,
        action.confirmedVia,
        JSON.stringify(action.history),
      )
      return read(action.id) as OutboxAction
    },

    get: read,

    list(filter = {}) {
      const where: string[] = []
      const params: unknown[] = []

      if (filter.states !== undefined) {
        if (filter.states.length === 0) return []
        where.push(`state IN (${inList(filter.states)})`)
        params.push(...filter.states)
      }
      if (filter.subjectKey !== undefined) {
        where.push('subject_key = ?')
        params.push(filter.subjectKey)
      }

      const clause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`
      // Oldest confirmation first: an agent claiming work should take the thing
      // the user has been waiting on longest.
      const rows = db
        .prepare(`SELECT * FROM outbox_actions ${clause} ORDER BY confirmed_at, id`)
        .all(...(params as never[])) as Record<string, unknown>[]

      return rows.map(toAction)
    },

    claim(id, claimedBy, at, expiresAt, entry) {
      const changed = db
        .prepare(
          `UPDATE outbox_actions
              SET state = 'claimed', claimed_by = ?, claimed_at = ?, claim_expires_at = ?,
                  history = json_insert(history, '$[#]', json(?))
            WHERE id = ? AND state = 'pending'`,
        )
        .run(claimedBy, at, expiresAt, JSON.stringify(entry), id).changes

      return changed === 0 ? null : read(id)
    },

    transition(id, from, to, patch, entry) {
      const sets = [`state = ?`, `history = json_insert(history, '$[#]', json(?))`]
      const params: unknown[] = [to, JSON.stringify(entry)]

      if (patch.result !== undefined) {
        sets.push('result = ?')
        params.push(patch.result)
      }
      if (patch.failureReason !== undefined) {
        sets.push('failure_reason = ?')
        params.push(patch.failureReason)
      }
      if (patch.completedAt !== undefined) {
        sets.push('completed_at = ?')
        params.push(patch.completedAt)
      }
      if (patch.clearClaim === true) {
        sets.push('claimed_by = NULL', 'claimed_at = NULL', 'claim_expires_at = NULL')
      }

      params.push(id, ...from)

      const changed = db
        .prepare(
          `UPDATE outbox_actions SET ${sets.join(', ')}
            WHERE id = ? AND state IN (${inList(from)})`,
        )
        .run(...(params as never[])).changes

      return changed === 0 ? null : read(id)
    },

    expireClaims(now) {
      return db.transaction(() => {
        const due = db
          .prepare(
            `SELECT id FROM outbox_actions
              WHERE state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
          )
          .all(now) as { id: string }[]

        if (due.length === 0) return []

        // The history entry names the agent that held the lease, read from the
        // row itself. An expiry that did not record who dropped it would make a
        // repeatedly-failing agent invisible (FR-063).
        db.prepare(
          `UPDATE outbox_actions
              SET state = 'pending', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL,
                  history = json_insert(history, '$[#]', json_object(
                    'at', ?, 'from', 'claimed', 'to', 'pending',
                    'actor', COALESCE(claimed_by, 'unknown'),
                    'detail', 'claim expired'))
            WHERE state = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
        ).run(now, now)

        return due.map((r) => r.id)
      })()
    },
  }
}

function toAction(row: Record<string, unknown>): OutboxAction {
  const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

  return {
    id: String(row['id']),
    subjectKey: row['subject_key'] as NaturalKey,
    kind: row['kind'] as ActionKind,
    payload: safeJson<Record<string, unknown>>(row['payload'], {}),
    motivatingFindingId: nullable(row['motivating_finding_id']),
    state: row['state'] as ActionState,
    confirmedAt: String(row['confirmed_at']),
    confirmedVia: String(row['confirmed_via']),
    claimedBy: nullable(row['claimed_by']),
    claimedAt: nullable(row['claimed_at']),
    claimExpiresAt: nullable(row['claim_expires_at']),
    result: nullable(row['result']),
    failureReason: nullable(row['failure_reason']),
    completedAt: nullable(row['completed_at']),
    history: safeJson<ActionHistoryEntry[]>(row['history'], []),
  }
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
