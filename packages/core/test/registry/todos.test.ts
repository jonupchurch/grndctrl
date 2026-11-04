import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../../src/registry/index.js'
import { OperationError } from '../../src/registry/errors.js'
import { todosOperations } from '../../src/registry/ops/todos.js'
import type { Ctx, Surface } from '../../src/registry/types.js'
import { todosService } from '../../src/services/todos.js'
import { todosRepository } from '../../src/store/authored/todos.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 009 — the to-do list, through the registry.
 *
 * Dispatched rather than called, so the schemas, the exposures and the service
 * rules are all under test together. The exposure check dispatches as an agent
 * and requires a refusal, rather than reading the literal back.
 */

const SURFACES: Surface[] = ['ipc', 'http', 'mcp']
const KEY = 'jira:acme.atlassian.net/MERC-1184'
const OTHER = 'jira:acme.atlassian.net/MERC-1201'

interface WireTodo {
  id: string
  text: string
  ticketKey: string | null
  issueKey: string | null
  doneAt: string | null
  authorKind: 'user' | 'agent'
  authorId: string | null
  revision: number
}

let clock = 0
function ctxOn(surface: Surface): Ctx {
  const agent = surface !== 'ipc'
  // Each call a millisecond later, so creation order is deterministic.
  const at = new Date(Date.UTC(2026, 10, 4, 10, 0, 0, clock++))
  return {
    authorKind: agent ? 'agent' : 'user',
    authorId: agent ? 'claude-code' : null,
    surface,
    now: () => at,
  }
}

let dir: string
let close: () => void
let registry: Registry

const run = async <T>(op: string, input: unknown, surface: Surface = 'ipc'): Promise<T> =>
  (await registry.dispatch(op, input, ctxOn(surface))) as T

async function refusal(
  op: string,
  input: unknown,
  surface: Surface = 'ipc',
): Promise<OperationError> {
  try {
    await run(op, input, surface)
  } catch (e) {
    if (e instanceof OperationError) return e
    throw e
  }
  throw new Error(`expected '${op}' to be refused`)
}

beforeEach(() => {
  clock = 0
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-todos-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()

  registry = new Registry()
  const service = todosService({ todos: todosRepository(opened.db) })
  for (const op of todosOperations(service)) registry.register(op)
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('to-do operations', () => {
  it('lets agents create, list and update, and only the interface delete', () => {
    for (const surface of SURFACES) {
      expect(registry.namesFor(surface).sort()).toEqual(
        surface === 'ipc'
          ? ['todos.create', 'todos.delete', 'todos.list', 'todos.update']
          : ['todos.create', 'todos.list', 'todos.update'],
      )
    }
  })

  it('refuses a delete from an agent', async () => {
    const todo = await run<WireTodo>('todos.create', { text: 'Write the migration.' }, 'mcp')
    const e = await refusal('todos.delete', { id: todo.id, revision: todo.revision }, 'mcp')
    expect(e.message).toMatch(/not available on the mcp surface/)
  })

  it('creates a free-standing to-do and a linked one, stamping the author from the transport', async () => {
    const free = await run<WireTodo>('todos.create', { text: '  Free-standing.  ' })
    expect(free).toMatchObject({
      text: 'Free-standing.',
      ticketKey: null,
      issueKey: null,
      doneAt: null,
      authorKind: 'user',
      authorId: null,
      revision: 1,
    })

    const linked = await run<WireTodo>('todos.create', { text: 'Linked.', ticketKey: KEY }, 'mcp')
    expect(linked).toMatchObject({
      ticketKey: KEY,
      issueKey: 'MERC-1184',
      authorKind: 'agent',
      authorId: 'claude-code',
    })
  })

  it('refuses a line break, an empty text, and a link to something that is not a ticket', async () => {
    expect((await refusal('todos.create', { text: 'One.\nTwo.' })).message).toMatch(/one line/)
    expect((await refusal('todos.create', { text: '   ' })).message).toMatch(/needs some text/)
    expect(
      (await refusal('todos.create', { text: 'x', ticketKey: 'session:claude/a' })).message,
    ).toMatch(/links to a ticket only/)
  })

  it('ticks off and reopens, and lists open items before done ones', async () => {
    const first = await run<WireTodo>('todos.create', { text: 'First.' })
    await run<WireTodo>('todos.create', { text: 'Second.' })

    const done = await run<WireTodo>(
      'todos.update',
      { id: first.id, revision: 1, done: true },
      'mcp',
    )
    expect(done.doneAt).not.toBeNull()
    expect(done.revision).toBe(2)

    expect((await run<WireTodo[]>('todos.list', {})).map((t) => t.text)).toEqual(['Second.'])
    expect((await run<WireTodo[]>('todos.list', { state: 'done' })).map((t) => t.text)).toEqual([
      'First.',
    ])
    expect((await run<WireTodo[]>('todos.list', { state: 'all' })).map((t) => t.text)).toEqual([
      'Second.',
      'First.',
    ])

    const reopened = await run<WireTodo>('todos.update', { id: first.id, revision: 2, done: false })
    expect(reopened.doneAt).toBeNull()
  })

  it('links, relinks and unlinks, and narrows the list by ticket', async () => {
    const todo = await run<WireTodo>('todos.create', { text: 'Move me.' })
    await run<WireTodo>('todos.create', { text: 'Stay put.', ticketKey: OTHER })

    const linked = await run<WireTodo>('todos.update', { id: todo.id, revision: 1, ticketKey: KEY })
    expect(linked.issueKey).toBe('MERC-1184')
    expect((await run<WireTodo[]>('todos.list', { ticketKey: KEY })).map((t) => t.text)).toEqual([
      'Move me.',
    ])

    const unlinked = await run<WireTodo>('todos.update', {
      id: todo.id,
      revision: 2,
      ticketKey: null,
    })
    expect(unlinked.ticketKey).toBeNull()
    expect(await run<WireTodo[]>('todos.list', { ticketKey: KEY })).toEqual([])
  })

  it('refuses a stale revision with the current item, rather than overwriting it', async () => {
    const todo = await run<WireTodo>('todos.create', { text: 'Original.' })
    await run<WireTodo>('todos.update', { id: todo.id, revision: 1, done: true }, 'mcp')

    const e = await refusal('todos.update', { id: todo.id, revision: 1, text: 'Edited.' })
    expect(e.code).toBe('conflict')
    expect((e.details.current as WireTodo).revision).toBe(2)

    const [current] = await run<WireTodo[]>('todos.list', { state: 'all' })
    expect(current?.text).toBe('Original.')
  })

  it('deletes from the interface with the revision read, and answers not_found afterwards', async () => {
    const todo = await run<WireTodo>('todos.create', { text: 'Gone soon.' })
    expect(await run('todos.delete', { id: todo.id, revision: 1 })).toEqual({ id: todo.id })
    expect((await refusal('todos.update', { id: todo.id, revision: 1, done: true })).code).toBe(
      'not_found',
    )
  })

  it('refuses an update with nothing to change', async () => {
    const todo = await run<WireTodo>('todos.create', { text: 'Untouched.' })
    expect((await refusal('todos.update', { id: todo.id, revision: 1 })).message).toMatch(
      /needs something to change/,
    )
  })
})
