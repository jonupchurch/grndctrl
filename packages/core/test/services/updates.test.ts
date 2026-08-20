import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionKey, ticketKey, type NaturalKey } from '../../src/domain/keys.js'
import { isOperationError } from '../../src/registry/errors.js'
import type { Ctx } from '../../src/registry/types.js'
import { updatesService, type UpdatesService } from '../../src/services/updates.js'
import { RETENTION_PER_SESSION, updatesRepository } from '../../src/store/authored/updates.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * Agent updates (FR-132, FR-133).
 *
 * Over a real `authored.db`, because the two properties worth asserting are
 * properties of the write: the prune happens inside the insert, and the history
 * survives its session. A fake would agree with whatever this file claimed about
 * both.
 */

const SESSION = sessionKey('claude-code', 'abc123')
const OTHER_SESSION = sessionKey('other-agent', 'xyz')
const TICKET = ticketKey('acme.atlassian.net', 'MERC-1184')
const LATER_TICKET = ticketKey('acme.atlassian.net', 'MERC-1190')

let dir: string
let close: () => void
let service: UpdatesService
/** Mutable so a test can move the focus between posts, as the operator does. */
let active: NaturalKey | null

function ctxAt(at: string): Ctx {
  return {
    authorKind: 'agent',
    authorId: 'claude-code',
    surface: 'mcp',
    now: () => new Date(at),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-updates-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()
  active = null

  let n = 0
  service = updatesService({
    updates: updatesRepository(opened.db),
    // Two sessions exist; everything else is unknown.
    agentOf: (key) =>
      key === SESSION ? 'claude-code' : key === OTHER_SESSION ? 'other-agent' : null,
    activeTicket: () => active,
    // Sequential rather than random, so "newest first" can be asserted against
    // rows posted in the same second without depending on uuid ordering.
    newId: () => `update:${String(++n).padStart(4, '0')}`,
  })
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('posting an update', () => {
  it('takes the author from the session, not from the caller', () => {
    // The panel's entire value is that it says who said what. An agent that
    // could name its own author could post as another one.
    const posted = service.post({ sessionKey: SESSION, text: 'Found the cause.' }, ctxAt('2026-08-19T10:00:00.000Z'))

    expect(posted.agentId).toBe('claude-code')
    expect(posted.sessionKey).toBe(SESSION)
    expect(posted.postedAt).toBe('2026-08-19T10:00:00.000Z')
  })

  it('captures the ticket that was active at the time, and does not re-attribute it later', () => {
    /*
     * The reason `ticketKey` is a column and not a join.
     *
     * An update said what it said about the ticket that was active when it was
     * posted. Resolving it at read time would rewrite the whole history every
     * time the operator moved focus -- so a note about a bug in MERC-1184 would
     * silently become a note about MERC-1190, and nothing on the screen would
     * indicate that it had moved.
     */
    active = TICKET
    const first = service.post({ sessionKey: SESSION, text: 'On the reconcile bug.' }, ctxAt('2026-08-19T10:00:00.000Z'))
    expect(first.ticketKey).toBe(TICKET)

    active = LATER_TICKET
    const second = service.post({ sessionKey: SESSION, text: 'Moved on.' }, ctxAt('2026-08-19T11:00:00.000Z'))
    expect(second.ticketKey).toBe(LATER_TICKET)

    // The first one still says what it said.
    const history = service.list({ sessionKey: SESSION })
    expect(history.map((u) => u.ticketKey)).toEqual([LATER_TICKET, TICKET])
  })

  it('records no ticket when nothing is active', () => {
    // Not an error, and not a guess. An agent may be working before anyone has
    // said what on.
    const posted = service.post({ sessionKey: SESSION, text: 'Looking around.' }, ctxAt('2026-08-19T10:00:00.000Z'))
    expect(posted.ticketKey).toBeNull()
  })

  it('refuses a session it does not know, rather than posting anonymously', () => {
    // An update whose agent cannot be named is not something the panel can
    // render, and "start a session first" is something an agent can act on.
    let caught: unknown
    try {
      service.post({ sessionKey: sessionKey('ghost', 'nope'), text: 'Hello?' }, ctxAt('2026-08-19T10:00:00.000Z'))
    } catch (e) {
      caught = e
    }

    expect(isOperationError(caught)).toBe(true)
    expect((caught as Error).message).toMatch(/start a session/i)
    expect(service.list()).toEqual([])
  })
})

describe('reading them back', () => {
  const post = (text: string, at: string, key = SESSION): void => {
    service.post({ sessionKey: key, text }, ctxAt(at))
  }

  it('is newest first', () => {
    post('one', '2026-08-19T10:00:00.000Z')
    post('two', '2026-08-19T10:01:00.000Z')
    post('three', '2026-08-19T10:02:00.000Z')

    expect(service.list().map((u) => u.text)).toEqual(['three', 'two', 'one'])
  })

  it('orders two posted in the same instant stably', () => {
    // Two updates a second apart is normal; two in the same second is what a
    // busy agent does. Without the id tiebreak the order is whatever SQLite
    // returns, and the prune could keep a different set than the panel shows.
    post('first', '2026-08-19T10:00:00.000Z')
    post('second', '2026-08-19T10:00:00.000Z')

    expect(service.list().map((u) => u.text)).toEqual(['second', 'first'])
  })

  it('filters by session and by the ticket that was active', () => {
    active = TICKET
    post('mine', '2026-08-19T10:00:00.000Z')
    post('theirs', '2026-08-19T10:01:00.000Z', OTHER_SESSION)
    active = null
    post('untargeted', '2026-08-19T10:02:00.000Z')

    expect(service.list({ sessionKey: SESSION }).map((u) => u.text)).toEqual(['untargeted', 'mine'])
    expect(service.list({ ticketKey: TICKET }).map((u) => u.text)).toEqual(['theirs', 'mine'])
  })
})

describe('retention', () => {
  it('prunes on write, per session, keeping the newest', () => {
    /*
     * FR-133, and the reason it is here rather than on a timer: a scheduled
     * prune is a thing that can fail to run, and the way anyone finds out is a
     * database nobody can open a year later.
     *
     * Posted past the limit in one session while a second session sits at one
     * row, so this also asserts the prune is scoped -- a `DELETE` missing its
     * `WHERE session_key` would empty the other one and every count here would
     * still look plausible.
     */
    service.post({ sessionKey: OTHER_SESSION, text: 'untouched' }, ctxAt('2026-08-19T09:00:00.000Z'))

    for (let i = 0; i < RETENTION_PER_SESSION + 10; i++) {
      service.post(
        { sessionKey: SESSION, text: `update ${i}` },
        // A minute apart, so "newest" is unambiguous.
        ctxAt(new Date(Date.parse('2026-08-19T10:00:00.000Z') + i * 60_000).toISOString()),
      )
    }

    const kept = service.list({ sessionKey: SESSION, limit: 200 })
    expect(kept).toHaveLength(RETENTION_PER_SESSION)
    // The newest survive and the oldest go. A prune that deleted from the wrong
    // end would keep exactly the same number of rows.
    expect(kept[0]?.text).toBe(`update ${RETENTION_PER_SESSION + 9}`)
    expect(kept.at(-1)?.text).toBe(`update ${10}`)

    expect(service.list({ sessionKey: OTHER_SESSION }).map((u) => u.text)).toEqual(['untouched'])
  })
})
