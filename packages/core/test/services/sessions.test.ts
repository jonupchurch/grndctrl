import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionKey, type NaturalKey } from '../../src/domain/keys.js'
import { isOperationError } from '../../src/registry/errors.js'
import type { Ctx } from '../../src/registry/types.js'
import { sessionsService, type SessionsService } from '../../src/services/sessions.js'
import { sessionsRepository } from '../../src/store/authored/sessions.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * The session state machine, and the two ways it is easy to get wrong.
 *
 * `silent` is derived from the clock at read time, never stored (FR-046). And a
 * heartbeat is not activity: an agent stuck in a retry loop beats perfectly, so
 * counting a beat as work would render the exact failure the operator needs to
 * see as its opposite.
 */

const AGENT = 'claude-code'
const SESSION = 'abc123'
const KEY = sessionKey(AGENT, SESSION)

const T0 = Date.parse('2026-08-14T10:00:00.000Z')
const at = (secondsFromStart: number): string => new Date(T0 + secondsFromStart * 1000).toISOString()

let dir: string
let db: Database
let service: SessionsService
let questions: NaturalKey[]

function ctx(secondsFromStart: number): Ctx {
  return {
    authorKind: 'agent',
    authorId: AGENT,
    surface: 'mcp',
    now: () => new Date(T0 + secondsFromStart * 1000),
  }
}

function build(): void {
  service = sessionsService({
    sessions: sessionsRepository(db),
    openQuestionSubjects: () => questions,
    missMultiplier: () => 3,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-sessions-'))
  db = openAuthored({ dir }).db
  questions = []
  build()
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function start(seconds = 0, intervalSec = 60): ReturnType<SessionsService['start']> {
  return service.start(
    { agentId: AGENT, sessionId: SESSION, heartbeatIntervalSec: intervalSec },
    ctx(seconds),
  )
}

describe('running to silent and back', () => {
  it('goes silent after three missed beats and recovers on the next one', () => {
    start()

    expect(service.get(KEY, new Date(T0 + 60_000))?.state).toBe('running')
    // 3 x 60s is the window. At exactly the boundary it is still running --
    // "more than three missed" rather than "three".
    expect(service.get(KEY, new Date(T0 + 180_000))?.state).toBe('running')
    expect(service.get(KEY, new Date(T0 + 181_000))?.state).toBe('silent')

    // One beat brings it straight back. No transition was ever written, so
    // there is no stale flag to clear.
    service.heartbeat({ agentId: AGENT, sessionId: SESSION }, ctx(600))
    expect(service.get(KEY, new Date(T0 + 601_000))?.state).toBe('running')
  })

  it('re-evaluates after a restart instead of trusting what was stored', () => {
    start()
    service.heartbeat({ agentId: AGENT, sessionId: SESSION }, ctx(30))

    // The process dies here. Nothing writes `silent` -- nothing could.
    db.close()
    db = openAuthored({ dir }).db
    build()

    // Hours later the app opens again and works it out from the clock.
    expect(service.get(KEY, new Date(T0 + 4 * 3600_000))?.state).toBe('silent')

    // The proof that it was never stored: there is no column holding it.
    const columns = (db.prepare('PRAGMA table_info(agent_sessions)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(columns).not.toContain('state')
  })

  it('never stores a session state, only the clocks it is derived from', () => {
    start()
    const row = db.prepare('SELECT * FROM agent_sessions WHERE key = ?').get(KEY) as Record<
      string,
      unknown
    >
    expect(Object.values(row)).not.toContain('running')
    expect(Object.values(row)).not.toContain('silent')
  })
})

describe('a heartbeat is not activity', () => {
  it('leaves the activity clock alone, so a stuck agent stops looking busy', () => {
    start()
    service.activity({ agentId: AGENT, sessionId: SESSION, reportedStatus: 'Writing tests' }, ctx(10))

    // Now the agent wedges: it keeps beating for an hour and does nothing.
    for (const t of [70, 130, 190, 250, 310]) {
      service.heartbeat({ agentId: AGENT, sessionId: SESSION }, ctx(t))
    }

    const view = service.get(KEY, new Date(T0 + 320_000))
    // Alive by the heartbeat...
    expect(view?.state).toBe('running')
    // ...and visibly idle for five minutes, which is the fact worth surfacing.
    expect(view?.idleSec).toBe(310)
    expect(view?.lastRealActivityAt).toBe(at(10))
  })

  it('advances both clocks when work actually happens', () => {
    start()
    service.heartbeat({ agentId: AGENT, sessionId: SESSION }, ctx(60))
    const after = service.activity({ agentId: AGENT, sessionId: SESSION }, ctx(120))

    expect(after.lastHeartbeatAt).toBe(at(120))
    expect(after.lastRealActivityAt).toBe(at(120))
  })

  it('reports no activity as null, not as zero', () => {
    const started = start()
    // A session that has done nothing must not render as "active just now".
    expect(started.lastRealActivityAt).toBeNull()
    expect(started.idleSec).toBeNull()
  })
})

describe('starting twice', () => {
  it('resumes the same row and keeps the original start time', () => {
    start(0)
    service.activity({ agentId: AGENT, sessionId: SESSION }, ctx(30))

    // The agent crashes and reconnects, reporting the same session id.
    const resumed = start(600)

    expect(resumed.startedAt).toBe(at(0))
    expect(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get()).toEqual({ c: 1 })
    // The work it had already done is still on the record.
    expect(resumed.lastRealActivityAt).toBe(at(30))
  })

  it('reopens a session that had been ended', () => {
    start()
    service.end({ agentId: AGENT, sessionId: SESSION, outcome: 'done' }, ctx(100))
    expect(service.get(KEY, new Date(T0 + 110_000))?.state).toBe('done')

    const resumed = start(200)
    expect(resumed.endedAt).toBeNull()
    expect(resumed.state).toBe('running')
  })
})

describe('timestamps from an agent', () => {
  it('clamps a clock running fast back to receipt time', () => {
    start()

    // An agent whose clock is an hour ahead would otherwise keep a dead session
    // "running" until real time caught up (FR-045).
    const beat = service.heartbeat(
      { agentId: AGENT, sessionId: SESSION, at: at(3600) },
      ctx(60),
    )

    expect(beat.lastHeartbeatAt).toBe(at(60))
    expect(service.get(KEY, new Date(T0 + 400_000))?.state).toBe('silent')
  })

  it('refuses to move a clock backwards', () => {
    start()
    service.heartbeat({ agentId: AGENT, sessionId: SESSION }, ctx(120))

    // A beat delivered late, stamped when it was generated. Accepting it would
    // drag a live session backwards into silence.
    const late = service.heartbeat({ agentId: AGENT, sessionId: SESSION, at: at(10) }, ctx(130))
    expect(late.lastHeartbeatAt).toBe(at(120))
  })

  it('falls back to receipt time when the timestamp is unparseable', () => {
    start()
    const beat = service.heartbeat(
      { agentId: AGENT, sessionId: SESSION, at: 'not a date' },
      ctx(60),
    )
    expect(beat.lastHeartbeatAt).toBe(at(60))
  })
})

describe('needs-you', () => {
  it('comes from an unresolved question, and outranks a healthy heartbeat', () => {
    start()
    service.activity({ agentId: AGENT, sessionId: SESSION }, ctx(10))
    expect(service.get(KEY, new Date(T0 + 20_000))?.state).toBe('running')

    questions = [KEY]
    expect(service.get(KEY, new Date(T0 + 20_000))?.state).toBe('needs-you')

    // Answered: back to whatever the clock says.
    questions = []
    expect(service.get(KEY, new Date(T0 + 20_000))?.state).toBe('running')
  })

  it('does not resurrect an ended session', () => {
    start()
    service.end({ agentId: AGENT, sessionId: SESSION, outcome: 'done' }, ctx(60))
    questions = [KEY]

    expect(service.get(KEY, new Date(T0 + 70_000))?.state).toBe('done')
  })
})

describe('refusals', () => {
  it('will not heartbeat a session that was never started', () => {
    try {
      service.heartbeat({ agentId: AGENT, sessionId: 'never-opened' }, ctx(0))
      throw new Error('expected a refusal')
    } catch (e) {
      // An implicit start here would invent a plausible row for an agent that
      // has lost its own state, hiding the fault instead of showing it.
      expect(isOperationError(e) && e.code).toBe('not_found')
    }
    expect(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get()).toEqual({ c: 0 })
  })

  it('rejects a heartbeat interval too short to be meaningful', () => {
    try {
      service.start({ agentId: AGENT, sessionId: 'x', heartbeatIntervalSec: 1 }, ctx(0))
      throw new Error('expected a refusal')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('invalid')
    }
  })
})
