import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ticketKey } from '../../src/domain/keys.js'
import { Registry } from '../../src/registry/index.js'
import { focusOperations } from '../../src/registry/ops/focus.js'
import type { Ctx, Surface } from '../../src/registry/types.js'
import { focusService } from '../../src/services/focus.js'
import { focusRepository } from '../../src/store/authored/focus.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 007/T116 — the exposure that must not be `ui-only`.
 *
 * The operator's brief for the active ticket was "populated by MCP". The cheap
 * version of this feature parks the key on `settings`, and `settings.update` is
 * `ui-only`, so the cheap version is unreachable from the surface the feature
 * exists for. That failure is invisible in the renderer, which would work
 * perfectly.
 *
 * So this file does not assert that a literal in `ops/focus.ts` reads `'all'`.
 * It dispatches through the registry **as an agent on the MCP surface** and
 * asserts the write lands — which is the property, and which fails if anyone
 * narrows the exposure later for a reason that sounds good.
 */

const TICKET = ticketKey('acme.atlassian.net', 'MERC-1184')
const SURFACES: Surface[] = ['ipc', 'http', 'mcp']

function ctxOn(surface: Surface): Ctx {
  const agent = surface !== 'ipc'
  return {
    authorKind: agent ? 'agent' : 'user',
    authorId: agent ? 'claude-code' : null,
    surface,
    now: () => new Date('2026-08-19T10:00:00.000Z'),
  }
}

let dir: string
let close: () => void
let registry: Registry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-focus-ops-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()

  registry = new Registry()
  for (const op of focusOperations(focusService({ focus: focusRepository(opened.db) }))) {
    registry.register(op)
  }
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('focus operations', () => {
  it('are on every surface, including the two an agent can reach', () => {
    for (const surface of SURFACES) {
      expect(registry.namesFor(surface), `missing from ${surface}`).toEqual([
        'focus.clear',
        'focus.get',
        'focus.set',
      ])
    }
  })

  it('lets an agent set the active ticket over MCP', async () => {
    const set = await registry.dispatch('focus.set', { ticketKey: TICKET }, ctxOn('mcp'))

    expect(set).toMatchObject({ ticketKey: TICKET, setBy: 'agent', setById: 'claude-code' })
    expect(await registry.dispatch('focus.get', {}, ctxOn('ipc'))).toMatchObject({
      ticketKey: TICKET,
    })
  })

  it('ignores a provenance claimed in the payload', async () => {
    /*
     * The attack this closes is one line long: an agent sends `setBy: 'user'`
     * and the panel then tells the operator they set this themselves.
     *
     * It is closed twice over, and only one of the two is visible in the
     * handler. The input schema does not declare `setBy`, and a Zod object
     * **strips** what it does not declare — so the field is gone before the
     * handler runs. The handler reads `ctx` and could not see it anyway.
     *
     * Worth a test rather than a comment because the stripping is the load-
     * bearing half and it is invisible: a schema loosened to `.passthrough()`
     * for some unrelated convenience would reopen it silently.
     */
    const set = (await registry.dispatch(
      'focus.set',
      { ticketKey: TICKET, setBy: 'user', setById: null },
      ctxOn('mcp'),
    )) as { setBy: string; setById: string | null }

    expect(set.setBy).toBe('agent')
    expect(set.setById).toBe('claude-code')
  })

  it('answers null rather than failing when nothing is active', async () => {
    // The output schema is nullable, so this also proves the registry's output
    // validation accepts the empty answer. An operation whose schema forgot the
    // `.nullable()` would throw here on the most common state there is.
    expect(await registry.dispatch('focus.get', {}, ctxOn('mcp'))).toBeNull()
    expect(await registry.dispatch('focus.clear', {}, ctxOn('mcp'))).toEqual({ cleared: false })
  })

  it('refuses a key that is not a ticket', async () => {
    await expect(
      registry.dispatch('focus.set', { ticketKey: 'session:claude-code/abc' }, ctxOn('mcp')),
    ).rejects.toThrow(/must be a ticket key/)
  })
})
