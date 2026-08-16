import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppNotRunning } from '../src/client.js'
import { TOOLS } from '../src/tools/index.js'
import { emptyDir, harness, type Harness } from './harness.js'

/**
 * Constitution XIV, from the agent's side.
 *
 * An agent holds a response for the length of a task. A board handed over
 * without its age is a board it will act on twenty minutes later believing it is
 * current — which is worse than no board, because it is confidently wrong.
 *
 * So every read carries an envelope, and the four freshness states stay four.
 * `never` is the one that matters most here: an empty board that has never
 * synced and an empty board that is genuinely empty look identical, and only
 * the freshness distinguishes "there is no work" from "we have not looked".
 */

let h: Harness

beforeAll(async () => {
  h = await harness()
})

afterAll(async () => {
  await h.dispose()
})

/** The reads that return provider-derived data, and therefore must be enveloped. */
const ENVELOPED = ['board.summary', 'work.list', 'drift.list']

async function callTool(tool: string, args: unknown = {}): Promise<unknown> {
  const binding = TOOLS.find((t) => t.tool === tool)
  if (binding === undefined) throw new Error(`no such tool: ${tool}`)
  return h.client.call(binding.operation, args)
}

describe('every provider-derived read', () => {
  it('comes back wrapped in an envelope', async () => {
    for (const operation of ENVELOPED) {
      const result = (await h.client.call(operation, {})) as Record<string, unknown>
      expect(Object.keys(result).sort(), `${operation} is not enveloped`).toEqual([
        'data',
        'freshness',
        'partial',
      ])
    }
  })

  it('reports "never synced" rather than an age of zero on a fresh install', async () => {
    const board = (await callTool('grndctrl_get_board')) as {
      data: { total: number }
      freshness: Record<string, { state: string; ageSec: number | null }>
    }

    expect(board.data.total).toBe(0)

    for (const [kind, view] of Object.entries(board.freshness)) {
      // The failure this prevents: `never` collapsed into `stale` invites an
      // age of 0, which renders as "just updated" — the exact inversion XIV
      // exists to stop.
      expect(view.state, `${kind} should be 'never' before any sync`).toBe('never')
      expect(view.ageSec, `${kind} has no age yet`).toBeNull()
    }
  })

  it('keeps never, stale, failed and fresh as four distinct answers', async () => {
    const at = (offsetSec: number) => new Date(Date.now() + offsetSec * 1000).toISOString()

    // Four connections, each in a different state, so the distinction is proved
    // rather than assumed from one of them.
    h.services.mirror.recordSuccess('c-fresh', 'tickets', at(0))
    h.services.mirror.recordSuccess('c-stale', 'pulls', at(-86_400))
    h.services.mirror.recordSuccess('c-failed', 'branches', at(-60))
    h.services.mirror.recordFailure('c-failed', 'branches', at(-10), 'auth', null)
    // c-never records nothing at all.

    const status = (await callTool('grndctrl_get_freshness')) as {
      connections: { connectionId: string; state: string; failureReason: string | null }[]
    }

    const byId = new Map(status.connections.map((c) => [c.connectionId, c]))

    expect(byId.get('c-fresh')?.state).toBe('fresh')
    expect(byId.get('c-stale')?.state).toBe('stale')
    // Failed, not stale — and it says *why*, because "the token expired" and
    // "polling is slow" call for completely different responses from the agent.
    expect(byId.get('c-failed')?.state).toBe('failed')
    expect(byId.get('c-failed')?.failureReason).toBe('auth')
    expect(byId.has('c-never')).toBe(false)
  })

  it('gives absolute timestamps, never relative strings', async () => {
    h.services.mirror.recordSuccess('c-jira', 'tickets', new Date().toISOString())

    const status = (await callTool('grndctrl_get_freshness')) as {
      connections: { lastSuccessAt: string | null }[]
    }

    for (const connection of status.connections) {
      if (connection.lastSuccessAt === null) continue
      // "3 minutes ago" is computed once and then quietly becomes wrong, in the
      // direction that makes stale data look fresh.
      expect(connection.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
      expect(Number.isNaN(Date.parse(connection.lastSuccessAt))).toBe(false)
    }
  })

  it('marks the envelope partial when a provider failed', async () => {
    h.services.mirror.recordSuccess('c-gh', 'pulls', new Date(Date.now() - 60_000).toISOString())
    h.services.mirror.recordFailure('c-gh', 'pulls', new Date().toISOString(), 'rateLimit', null)

    const board = (await callTool('grndctrl_get_board')) as { partial: boolean }
    // XV: the board still renders, and says it is incomplete. Hiding the lane
    // would read as "no work", which is the wrong answer.
    expect(board.partial).toBe(true)
  })
})

describe('reads that are not provider-derived', () => {
  it('are not enveloped, because there is no provider age to carry', async () => {
    // A note is the operator's own text. Attaching a freshness number to it
    // would be attaching a number that means nothing.
    const notes = await h.client.call('notes.questions', {})
    expect(Array.isArray(notes)).toBe(true)

    const sessions = await h.client.call('sessions.list', {})
    expect(Array.isArray(sessions)).toBe(true)
  })
})

describe('when the app is not running', () => {
  it('says so cleanly instead of throwing something an agent cannot read', async () => {
    const empty = emptyDir()
    try {
      expect(empty.client.state()).toEqual({
        running: false,
        reason: 'Ground Control is not running.',
      })

      await expect(empty.client.call('board.summary', {})).rejects.toBeInstanceOf(AppNotRunning)
    } finally {
      empty.dispose()
    }
  })

  it('does not launch the app', () => {
    // An MCP server that started a desktop application because an agent listed
    // its tools would be a genuinely surprising thing to have installed (T114).
    const empty = emptyDir()
    try {
      empty.client.state()
      expect(empty.client.state().running).toBe(false)
    } finally {
      empty.dispose()
    }
  })
})
