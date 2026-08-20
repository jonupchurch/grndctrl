import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../../src/registry/index.js'
import { promptsOperations } from '../../src/registry/ops/prompts.js'
import type { Ctx, Surface } from '../../src/registry/types.js'
import { promptsService } from '../../src/services/prompts.js'
import { promptsRepository, RETENTION } from '../../src/store/authored/prompts.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 007/T137 — the two exposures, and which of them is the privilege question.
 *
 * `prompts.delete` is `ui-only` because curating the operator's own history is
 * not an agent's business (FR-140): an agent that could delete a prompt could
 * remove the record of what it was told to do. That is asserted here by
 * **dispatching it as an agent on MCP and requiring a refusal**, rather than by
 * reading the literal in the operations file — the literal is what a later edit
 * changes, and a test that reads it agrees with the edit.
 *
 * `prompts.record` and `prompts.list` are `all`, and the same reasoning as the
 * active ticket applies: the panel exists to be filled over MCP, so an exposure
 * that kept agents out would leave a feature that works perfectly in the
 * renderer and does nothing for the operator.
 */

const SURFACES: Surface[] = ['ipc', 'http', 'mcp']
const SESSION = 'session:claude-code/run-1'

function ctxOn(surface: Surface, at = '2026-08-20T10:00:00.000Z'): Ctx {
  const agent = surface !== 'ipc'
  return {
    authorKind: agent ? 'agent' : 'user',
    authorId: agent ? 'claude-code' : null,
    surface,
    now: () => new Date(at),
  }
}

let dir: string
let close: () => void
let registry: Registry
let counter: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-prompt-ops-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()
  counter = 0

  registry = new Registry()
  const service = promptsService({
    prompts: promptsRepository(opened.db),
    newId: () => `prompt:${String(++counter).padStart(4, '0')}`,
  })
  for (const op of promptsOperations(service)) registry.register(op)
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('prompt operations', () => {
  it('lets an agent record and read, and lets only the interface delete', () => {
    for (const surface of SURFACES) {
      expect(registry.namesFor(surface), `wrong set on ${surface}`).toEqual(
        surface === 'ipc'
          ? ['prompts.delete', 'prompts.get', 'prompts.list', 'prompts.record']
          : ['prompts.list', 'prompts.record'],
      )
    }
  })

  it('records over MCP and lists it back', async () => {
    const recorded = (await registry.dispatch(
      'prompts.record',
      { text: 'Rewrite the reconcile path so it tolerates a missing worktree.', sessionKey: SESSION },
      ctxOn('mcp'),
    )) as { id: string; agentId: string; sessionKey: string | null }

    expect(recorded.agentId).toBe('claude-code')
    expect(recorded.sessionKey).toBe(SESSION)

    const listed = (await registry.dispatch('prompts.list', {}, ctxOn('ipc'))) as { id: string }[]
    expect(listed.map((p) => p.id)).toEqual([recorded.id])
  })

  it('refuses to delete on an agent surface', async () => {
    const recorded = (await registry.dispatch(
      'prompts.record',
      { text: 'A prompt with a token in it.' },
      ctxOn('mcp'),
    )) as { id: string }

    // Not merely absent from the tool list — refused at the registry, which is
    // the check an adapter bug cannot route around.
    await expect(
      registry.dispatch('prompts.delete', { id: recorded.id }, ctxOn('mcp')),
    ).rejects.toThrow()
    await expect(
      registry.dispatch('prompts.delete', { id: recorded.id }, ctxOn('http')),
    ).rejects.toThrow()

    expect(await registry.dispatch('prompts.delete', { id: recorded.id }, ctxOn('ipc'))).toEqual({
      deleted: true,
    })
  })

  it('ignores an author claimed in the payload', async () => {
    // The same one-line attack `focus.set` closes: an agent names itself as
    // somebody else and the panel repeats the claim. Closed twice — the input
    // schema does not declare `agentId`, and Zod strips what it does not
    // declare, so the field is gone before the handler reads `Ctx`. The
    // stripping is the load-bearing half and it is invisible in the handler.
    const recorded = (await registry.dispatch(
      'prompts.record',
      { text: 'Ship it.', agentId: 'someone-else' },
      ctxOn('mcp'),
    )) as { agentId: string }

    expect(recorded.agentId).toBe('claude-code')
  })

  it('records the operator as the author when the window is the caller', async () => {
    // `authorId` is null for the user, and `agent_id` is NOT NULL. The service
    // falls back to the author *kind*, which is the one place the two-column
    // provenance `active_ticket` keeps is collapsed into one.
    const recorded = (await registry.dispatch(
      'prompts.record',
      { text: 'Mine, not an agent’s.' },
      ctxOn('ipc'),
    )) as { agentId: string }

    expect(recorded.agentId).toBe('user')
  })

  it('stores and returns a long prompt whole', async () => {
    /*
     * FR-138 at the operation boundary.
     *
     * The failure this guards is a truncation nobody sees until the paste, so
     * the assertion is on the exact length rather than on a prefix — a
     * `.slice(0, 4000)` added anywhere below here would still start with the
     * same words.
     */
    const long = `Rewrite the reconcile path. ${'Consider the case where '.repeat(500)}End.`
    expect(long.length).toBeGreaterThan(10_000)

    const recorded = (await registry.dispatch(
      'prompts.record',
      { text: long },
      ctxOn('mcp'),
    )) as { id: string; text: string }
    expect(recorded.text).toBe(long)

    const read = (await registry.dispatch(
      'prompts.get',
      { id: recorded.id },
      ctxOn('ipc'),
    )) as { text: string }
    expect(read.text.length).toBe(long.length)
    expect(read.text).toBe(long)
  })

  it('refuses an absurd prompt rather than shortening it', async () => {
    // The ceiling refuses; it never trims. A truncating bound would be the one
    // failure mode FR-138 rules out, and it would look like a success here.
    await expect(
      registry.dispatch('prompts.record', { text: 'x'.repeat(100_001) }, ctxOn('mcp')),
    ).rejects.toThrow()
  })

  it('refuses a session key that is not a session', async () => {
    await expect(
      registry.dispatch(
        'prompts.record',
        { text: 'Anything.', sessionKey: 'jira:acme.atlassian.net/MERC-1' },
        ctxOn('mcp'),
      ),
    ).rejects.toThrow(/must be a session key/)
  })

  it('says so rather than answering an empty string for a prompt that is gone', async () => {
    // The copy path reads by id. An empty clipboard and a successful copy are
    // indistinguishable at the paste, so this must throw rather than return
    // something falsy that main would cheerfully write.
    await expect(registry.dispatch('prompts.get', { id: 'prompt:nope' }, ctxOn('ipc'))).rejects.toThrow(
      /No prompt/,
    )
  })

  it('prunes to the retention bound on write, not on a schedule', async () => {
    /*
     * FR-137. The prune runs inside the insert, in the same transaction, for the
     * reason the update retention does: a scheduled prune is a thing that can
     * fail to run, and the way anyone finds out is a database nobody can open.
     *
     * **This is asserted through `prompts.get`, and the first version of it was
     * asserted through `prompts.list` and was vacuous.** `list` takes a limit,
     * the schema caps that limit at exactly the retention bound, and a list of
     * "the newest 200" looks identical whether the 201st was deleted or is
     * merely off the end of the page. Deleting the prune left all three
     * assertions green. A read that cannot see past the bound cannot be used to
     * test the bound — so this reads the oldest row **by id**, where a limit has
     * no say.
     */
    const first = (await registry.dispatch(
      'prompts.record',
      { text: 'prompt number 0' },
      ctxOn('mcp', '2026-08-20T00:00:00.000Z'),
    )) as { id: string }

    for (let n = 1; n <= RETENTION; n++) {
      await registry.dispatch(
        'prompts.record',
        { text: `prompt number ${n}` },
        // Distinct timestamps, so newest-first is a real order rather than a
        // tie broken by id.
        ctxOn('mcp', new Date(Date.UTC(2026, 7, 20, 0, 0, n)).toISOString()),
      )
    }

    await expect(registry.dispatch('prompts.get', { id: first.id }, ctxOn('ipc'))).rejects.toThrow(
      /No prompt/,
    )

    // And the one immediately after it survived, so the prune took the oldest
    // rather than an arbitrary row.
    const newest = (await registry.dispatch('prompts.list', { limit: 200 }, ctxOn('ipc'))) as {
      text: string
    }[]
    expect(newest).toHaveLength(RETENTION)
    expect(newest[0]?.text).toBe(`prompt number ${RETENTION}`)
    expect(newest[RETENTION - 1]?.text).toBe('prompt number 1')
  })
})
