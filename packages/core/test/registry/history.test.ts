import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../../src/registry/index.js'
import { historyOperations } from '../../src/registry/ops/history.js'
import type { Ctx, Surface } from '../../src/registry/types.js'
import { historyService } from '../../src/services/history.js'
import { historyRepository } from '../../src/store/authored/history.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 008 — the two exposures, and which of them is the curation.
 *
 * `history.revise` and `history.delete` are `ui-only`. That is the *curated* in
 * "manually curated ticket history": an agent that could rewrite an entry could
 * restate what it did on the one record kept specifically to answer questions
 * about it later, and it could do so without leaving a trace, because a revise
 * replaces rather than appends.
 *
 * Asserted by **dispatching as an agent and requiring a refusal**, not by
 * reading the exposure literal out of the operations file. A test that reads the
 * literal agrees with whatever a later edit changes it to.
 */

const SURFACES: Surface[] = ['ipc', 'http', 'mcp']
const KEY = 'jira:acme.atlassian.net/MERC-1184'

function ctxOn(surface: Surface): Ctx {
  const agent = surface !== 'ipc'
  return {
    authorKind: agent ? 'agent' : 'user',
    authorId: agent ? 'claude-code' : null,
    surface,
    now: () => new Date('2026-08-20T10:00:00.000Z'),
  }
}

let dir: string
let close: () => void
let registry: Registry

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-history-ops-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()

  registry = new Registry()
  const service = historyService({ history: historyRepository(opened.db) })
  for (const op of historyOperations(service)) registry.register(op)
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ticket history operations', () => {
  it('lets an agent read and record, and lets only the interface curate', () => {
    for (const surface of SURFACES) {
      expect(registry.namesFor(surface), `wrong set on ${surface}`).toEqual(
        surface === 'ipc'
          ? ['history.delete', 'history.get', 'history.list', 'history.record', 'history.revise']
          : ['history.get', 'history.list', 'history.record'],
      )
    }
  })

  it('refuses a revise and a delete from an agent, over MCP', async () => {
    await registry.dispatch('history.record', { ticketKey: KEY, line: 'Done.' }, ctxOn('mcp'))

    await expect(
      registry.dispatch(
        'history.revise',
        { ticketKey: KEY, revision: 1, line: 'Not done.' },
        ctxOn('mcp'),
      ),
    ).rejects.toThrow(/not available on the mcp surface/)

    await expect(
      registry.dispatch('history.delete', { ticketKey: KEY, revision: 1 }, ctxOn('mcp')),
    ).rejects.toThrow(/not available on the mcp surface/)

    // And the entry is untouched, which is the property that matters rather
    // than the wording of the refusal.
    const listed = (await registry.dispatch('history.list', {}, ctxOn('mcp'))) as {
      line: string
    }[]
    expect(listed).toHaveLength(1)
    expect(listed[0]?.line).toBe('Done.')
  })

  it('stamps the author from the surface and ignores one in the payload', async () => {
    const written = (await registry.dispatch(
      // `authorKind` is not in the schema, so Zod strips it. This is the whole
      // mechanism by which payload-claimed provenance is impossible — pinned
      // here because a schema loosened later would silently re-enable it.
      'history.record',
      { ticketKey: KEY, line: 'Done.', authorKind: 'user', authorId: 'the operator' },
      ctxOn('mcp'),
    )) as { authorKind: string; authorId: string | null }

    expect(written.authorKind).toBe('agent')
    expect(written.authorId).toBe('claude-code')
  })

  it('refuses a line with a break in it at the boundary', async () => {
    await expect(
      registry.dispatch('history.record', { ticketKey: KEY, line: 'One.\nTwo.' }, ctxOn('mcp')),
    ).rejects.toThrow(/single line/)
  })

  it('returns the issue key, which is derived and not in the store', async () => {
    const written = (await registry.dispatch(
      'history.record',
      { ticketKey: KEY, line: 'Done.' },
      ctxOn('http'),
    )) as { issueKey: string | null }

    expect(written.issueKey).toBe('MERC-1184')
  })
})
