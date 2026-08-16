import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../src/server.js'
import { PENDING_URI } from '../src/resources.js'
import { TOOLS } from '../src/tools/index.js'
import { emptyDir, harness, type Harness } from './harness.js'

/**
 * The milestone's exit criterion, as a test: an agent works the board over MCP,
 * with no UI in existence.
 *
 * Driven through a real MCP client over a linked transport pair, so the path
 * under test is the whole one — client → protocol → tool → loopback HTTP →
 * registry → service → SQLite, and back. The MCP inspector does the same thing
 * with a human at the top.
 */

let h: Harness
let client: Client
let stop: () => void

beforeAll(async () => {
  h = await harness()

  const built = createServer({ dir: h.dir, agentId: 'claude-code' })
  stop = built.stop

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-agent', version: '0.0.0' })

  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)])
})

afterAll(async () => {
  stop()
  await client.close()
  await h.dispose()
})

describe('what an agent sees when it connects', () => {
  it('lists every tool, with a description it can act on', async () => {
    const { tools } = await client.listTools()

    expect(tools).toHaveLength(TOOLS.length)
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['grndctrl_get_board']))
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(60)
    }
  })

  it('offers the pending-actions resource', async () => {
    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toContain(PENDING_URI)
  })
})

describe('working the board', () => {
  it('reads a board that carries its own freshness', async () => {
    const result = await client.callTool({ name: 'grndctrl_get_board', arguments: {} })
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
    const board = JSON.parse(text) as { data: { total: number }; freshness: Record<string, unknown> }

    expect(result.isError).toBeFalsy()
    expect(board.data.total).toBe(0)
    expect(Object.keys(board.freshness).length).toBeGreaterThan(0)
  })

  it('runs a session through its whole life', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? ''
      return { isError: result.isError === true, text }
    }

    const ref = { agentId: 'claude-code', sessionId: 'exit-criterion' }

    const started = await call('grndctrl_start_session', {
      ...ref,
      heartbeatIntervalSec: 60,
      reportedStatus: 'Working the board through MCP',
    })
    expect(started.isError).toBe(false)

    // A heartbeat says alive. It must not advance the activity clock, and the
    // agent surface is where that distinction actually gets used.
    await call('grndctrl_heartbeat', ref)
    const afterBeat = JSON.parse((await call('grndctrl_list_sessions', {})).text) as {
      lastRealActivityAt: string | null
      state: string
    }[]
    expect(afterBeat[0]?.lastRealActivityAt).toBeNull()
    expect(afterBeat[0]?.state).toBe('running')

    await call('grndctrl_report_activity', { ...ref, reportedStatus: 'Wrote a note' })
    const afterWork = JSON.parse((await call('grndctrl_list_sessions', {})).text) as {
      lastRealActivityAt: string | null
    }[]
    expect(afterWork[0]?.lastRealActivityAt).not.toBeNull()

    const ended = await call('grndctrl_end_session', { ...ref, outcome: 'done' })
    expect(JSON.parse(ended.text).state).toBe('done')
  })

  it('writes a note as the agent, whatever the payload claims', async () => {
    const result = await client.callTool({
      name: 'grndctrl_add_note',
      arguments: {
        subjectKey: 'jira:acme.atlassian.net/MERC-1184',
        type: 'question-for-human',
        body: 'Should the export include archived rows?',
      },
    })

    const note = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as {
      authorKind: string
      authorId: string
      revision: number
    }

    expect(note.authorKind).toBe('agent')
    expect(note.authorId).toBe('claude-code')
    expect(note.revision).toBe(1)
  })

  it('rejects an edit against a stale revision, and says so readably', async () => {
    const first = await client.callTool({
      name: 'grndctrl_add_note',
      arguments: {
        subjectKey: 'jira:acme.atlassian.net/MERC-1200',
        type: 'todo',
        body: 'Original.',
      },
    })
    const note = JSON.parse((first.content as { text: string }[])[0]?.text ?? '{}') as { id: string }

    await client.callTool({
      name: 'grndctrl_update_note',
      arguments: { id: note.id, revision: 1, body: 'Second writer.' },
    })

    const stale = await client.callTool({
      name: 'grndctrl_update_note',
      arguments: { id: note.id, revision: 1, body: 'Would overwrite.' },
    })

    // The agent must be able to read what went wrong and act on it, rather than
    // seeing the tool itself appear broken.
    expect(stale.isError).toBe(true)
    expect((stale.content as { text: string }[])[0]?.text).toMatch(/^conflict: /)
  })
})

describe('when the app is not running', () => {
  it('answers every tool cleanly and does not launch it', async () => {
    const empty = emptyDir()
    const built = createServer({ dir: empty.dir })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const lonely = new Client({ name: 'test-agent', version: '0.0.0' })
    await Promise.all([built.server.connect(serverTransport), lonely.connect(clientTransport)])

    try {
      // Listing tools works with no app at all — an agent's client starts this
      // process at launch, long before Ground Control is open.
      expect((await lonely.listTools()).tools.length).toBe(TOOLS.length)

      const result = await lonely.callTool({ name: 'grndctrl_get_board', arguments: {} })
      expect(result.isError).toBe(true)
      expect((result.content as { text: string }[])[0]?.text).toMatch(
        /not running.*does not launch it/s,
      )
    } finally {
      built.stop()
      await lonely.close()
      empty.dispose()
    }
  })
})
