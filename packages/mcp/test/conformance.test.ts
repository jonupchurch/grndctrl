import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checkConformance } from '@grndctrl/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mcpAdapterDescriptor } from '../src/server.js'
import { exposedOperations, TOOLS } from '../src/tools/index.js'
import { harness, type Harness } from './harness.js'

/**
 * Constitution XII, as a build-failing gate.
 *
 * The failure it exists to prevent is asymmetry that nobody notices: a
 * capability wired into the UI and forgotten on MCP, so an agent acts on a
 * world it cannot fully see — or, worse, wired into MCP and not the UI, so the
 * operator cannot see what an agent can do.
 *
 * This test is only meaningful because the registry now has operations in it.
 * It passed vacuously through M1 and M2 with both sides empty, which is exactly
 * the shape of a green test that guards nothing.
 */

let h: Harness

beforeAll(async () => {
  h = await harness()
})

afterAll(async () => {
  await h.dispose()
})

describe('the MCP surface against the registry', () => {
  it('exposes every operation the registry says it should, and nothing more', () => {
    expect(checkConformance(h.registry, [mcpAdapterDescriptor()])).toEqual([])
  })

  it('is checking something — both sides are non-empty', () => {
    expect(h.registry.names().length).toBeGreaterThan(20)
    expect(TOOLS.length).toBeGreaterThan(20)
  })

  it('covers every all-exposure operation with exactly one tool', () => {
    const required = h.registry.namesFor('mcp')
    const covered = exposedOperations()

    expect([...covered].sort()).toEqual([...required].sort())
    // One tool per operation. Two tools onto one operation would make the
    // agent's tool list a place where behaviour gets decided.
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('gives every tool a distinct name', () => {
    const names = TOOLS.map((t) => t.tool)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('what the agent surface must not have', () => {
  it('has no tool for minting a confirmation', () => {
    // XVI: an action reaches the outbox only through an operator gesture. If an
    // agent could mint its own token it could authorise its own writes.
    expect(exposedOperations()).not.toContain('outbox.mintConfirmation')
    expect(TOOLS.map((t) => t.tool)).not.toContain('grndctrl_mint_confirmation')
  })

  it('has no tool for enqueuing an action, by any name', () => {
    // T118, stated as a name check as well as an operation check, because the
    // obvious way to reintroduce this is a helpfully-named new tool.
    expect(exposedOperations()).not.toContain('outbox.enqueue')

    for (const tool of TOOLS) {
      expect(tool.tool).not.toMatch(/enqueue|dispatch_action|create_action|request_action/i)
    }
  })

  it('has no tool for cancelling an action or minting a confirmation', () => {
    // Withdrawing consent and granting it are both the operator's. An agent that
    // could cancel an action could withdraw a decision it was asked to carry
    // out, and one that could mint a confirmation could authorise itself.
    //
    // `drift.dismiss` and `drift.undismiss` were the other two names here, on
    // the same reasoning: setting a finding aside was the operator's, and an
    // agent that could dismiss drift could hide the evidence of its own mistake.
    // They are gone with the operations. `outbox.mintConfirmation` takes their
    // place rather than the list simply getting shorter, because it is the
    // strongest remaining case of the same rule.
    for (const operation of ['outbox.cancel', 'outbox.mintConfirmation']) {
      expect(exposedOperations()).not.toContain(operation)
    }
  })

  it('has no tool for changing the operator’s configuration', () => {
    for (const operation of [
      'projects.upsert',
      'projects.remove',
      'settings.update',
      'settings.get',
      'connections.list',
    ]) {
      expect(exposedOperations()).not.toContain(operation)
    }
  })

  it('leaves the outbox tools an agent genuinely needs', () => {
    // The point is not that the outbox is closed to agents — it is that the
    // half they need is open and the half that requires consent is not.
    for (const operation of [
      'outbox.pending',
      'outbox.list',
      'outbox.claim',
      'outbox.complete',
      'outbox.fail',
    ]) {
      expect(exposedOperations()).toContain(operation)
    }
  })
})

describe('the tools themselves', () => {
  it('dispatches an operation and nothing else — no tool has a handler', () => {
    // A binding is data: a name, a description, a schema, an operation. If a
    // tool ever grows a body, this package has stopped being an adapter.
    for (const tool of TOOLS) {
      expect(Object.keys(tool).sort()).toEqual([
        'description',
        'inputSchema',
        'mutates',
        'operation',
        'tool',
      ])
    }
  })

  it('marks every read-only tool as such, matching the registry', () => {
    for (const tool of TOOLS) {
      const op = h.registry.get(tool.operation)
      expect(op, `${tool.operation} is not registered`).toBeDefined()
      expect(tool.mutates, `${tool.tool} disagrees with ${tool.operation} about mutating`).toBe(
        op?.mutates,
      )
    }
  })

  it('writes descriptions for a model to read, not for a changelog', () => {
    for (const tool of TOOLS) {
      // Long enough to say when to reach for it, which is what a model needs
      // and what a one-line restatement of the name does not give it.
      expect(tool.description.length, `${tool.tool} needs a real description`).toBeGreaterThan(60)
    }
  })
})

describe('what this process is allowed to import', () => {
  it('never imports the core package proper', () => {
    // The MCP server is delivered by npx and talks HTTP. Importing
    // `@grndctrl/core` would drag `better-sqlite3` into it — a native binding
    // it has no business needing, and one more thing to fail on a user's
    // machine (research R8).
    const src = join(import.meta.dirname, '..', 'src')
    const offenders: string[] = []

    for (const file of walk(src)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/from\s+'(@grndctrl\/core[^']*)'/g)) {
        const specifier = match[1] ?? ''
        // Only the narrow subpaths, which pull in path maths and nothing else.
        if (specifier !== '@grndctrl/core/handshake') offenders.push(`${file}: ${specifier}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it('never imports a database, a keychain, or a child process', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const offenders: string[] = []

    for (const file of walk(src)) {
      // Import specifiers only, not the whole file — a comment explaining *why*
      // better-sqlite3 is absent should not read as importing it.
      for (const match of readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? ''
        if (/better-sqlite3|node:child_process|@napi-rs\/keyring|node:fs/.test(specifier)) {
          offenders.push(`${file}: ${specifier}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : []
  })
}
