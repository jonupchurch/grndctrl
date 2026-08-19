import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionKey, ticketKey, type NaturalKey } from '../../src/domain/keys.js'
import { isOperationError } from '../../src/registry/errors.js'
import type { Ctx } from '../../src/registry/types.js'
import { focusService, type FocusService } from '../../src/services/focus.js'
import { focusRepository } from '../../src/store/authored/focus.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * FR-127 and FR-131 — the active ticket.
 *
 * Over a real `authored.db` rather than a double, for the same reason the notes
 * tests are: the properties worth asserting here are properties of the row (one
 * of it, replaced rather than appended) and of the absence of a foreign key, and
 * a fake would agree with whatever this file claimed.
 */

const TICKET = ticketKey('acme.atlassian.net', 'MERC-1184')
const OTHER = ticketKey('acme.atlassian.net', 'MERC-1190')
/** A key of a ticket that is in no mirror anywhere. FR-131's case. */
const UNSYNCED = ticketKey('acme.atlassian.net', 'NOPE-9999')

function ctxFor(authorKind: 'user' | 'agent', at = '2026-08-19T10:00:00.000Z'): Ctx {
  return {
    authorKind,
    authorId: authorKind === 'agent' ? 'claude-code' : null,
    surface: authorKind === 'agent' ? 'mcp' : 'ipc',
    now: () => new Date(at),
  }
}

let dir: string
let close: () => void
let service: FocusService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-focus-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()
  service = focusService({ focus: focusRepository(opened.db) })
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the active ticket', () => {
  it('is null before anything sets one', () => {
    // Not an empty object, not a row of nulls. The panel branches on this, and
    // "nothing is active" has to be distinguishable without inspecting fields.
    expect(service.get()).toBeNull()
  })

  it('records who set it from the caller, not from the payload', () => {
    const byAgent = service.set({ ticketKey: TICKET }, ctxFor('agent'))

    expect(byAgent.setBy).toBe('agent')
    expect(byAgent.setById).toBe('claude-code')
    expect(byAgent.setAt).toBe('2026-08-19T10:00:00.000Z')

    const byOperator = service.set({ ticketKey: OTHER }, ctxFor('user'))
    expect(byOperator.setBy).toBe('user')
    // Not the agent id left over from the previous write. The whole row is
    // replaced, so a partial upsert would leave the operator's action
    // attributed to whichever agent went last -- and the panel renders this.
    expect(byOperator.setById).toBeNull()
  })

  it('replaces rather than accumulates', () => {
    service.set({ ticketKey: TICKET }, ctxFor('user'))
    service.set({ ticketKey: OTHER }, ctxFor('agent'))

    expect(service.get()?.ticketKey).toBe(OTHER)
    expect(service.get()?.setBy).toBe('agent')
  })

  it('accepts a ticket the mirror has never held', () => {
    // FR-131. An agent may reasonably set focus before the sync that would
    // fetch the ticket, and a ticket that is not the operator's is never in
    // this mirror at all. Refusing here would make the order of two unrelated
    // operations matter, and would make the state the panel is specified to
    // render unreachable.
    const set = service.set({ ticketKey: UNSYNCED }, ctxFor('agent'))
    expect(set.ticketKey).toBe(UNSYNCED)
    expect(service.get()?.ticketKey).toBe(UNSYNCED)
  })

  it('refuses a key that is not a ticket, and says which mistake it was', () => {
    const session = sessionKey('claude-code', 'abc123')

    let caught: unknown
    try {
      service.set({ ticketKey: session as NaturalKey }, ctxFor('agent'))
    } catch (e) {
      caught = e
    }

    expect(isOperationError(caught)).toBe(true)
    // The caller here is frequently a model reading the message back. "Invalid
    // key" leaves it choosing between a typo and a category mistake, and it
    // will retry the typo.
    expect((caught as Error).message).toMatch(/must be a ticket key/)
    expect((caught as Error).message).toContain(session)

    expect(service.get()).toBeNull()
  })

  it('clears, and says whether there was anything to clear', () => {
    expect(service.clear()).toEqual({ cleared: false })

    service.set({ ticketKey: TICKET }, ctxFor('user'))
    expect(service.clear()).toEqual({ cleared: true })
    expect(service.get()).toBeNull()

    // Two agents finishing the same ticket both call this. The second must not
    // fail -- but it is told, because "there was nothing set" is worth showing
    // a human and worth nothing to an exception.
    expect(service.clear()).toEqual({ cleared: false })
  })

  it('survives being reopened', () => {
    service.set({ ticketKey: TICKET }, ctxFor('agent'))
    close()

    const reopened = openAuthored({ dir })
    close = () => reopened.db.close()

    const after = focusService({ focus: focusRepository(reopened.db) }).get()
    expect(after?.ticketKey).toBe(TICKET)
    expect(after?.setBy).toBe('agent')
    expect(after?.setById).toBe('claude-code')
  })
})
