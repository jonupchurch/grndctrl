import { readFileSync } from 'node:fs'
import { existsSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isOperationError } from '../../src/registry/errors.js'
import { confirmationTokens } from '../../src/services/confirmation.js'
import { outboxService } from '../../src/services/outbox.js'
import { tempServices } from '../helpers/services.js'
import { at, ctx, confirmAndEnqueue, outboxFixture, SUBJECT } from './outbox-fixture.js'

/**
 * FR-060 and constitution XVI: nothing dispatches an action on its own.
 *
 * The rule is that an action reaches the outbox only through an operator
 * gesture. A rule stated in prose lasts until the first person who has not read
 * it adds an `await outbox.enqueue(...)` inside the sync, in good faith,
 * because it would obviously be helpful. So the rule is enforced two ways here,
 * and the first is the one that catches that person:
 *
 * 1. **Statically.** Walk the import graph from every module in sync and
 *    correlation. The confirmation minter must be unreachable — not "not
 *    called", *unreachable*, so the import itself fails the build. Drift was the
 *    third layer walked, and the one the scenario above was written about; it is
 *    gone, and the rule it was an instance of is not.
 * 2. **At runtime.** `mintConfirmation` is `ui-only`, so the registry refuses it
 *    on the MCP and HTTP surfaces. An agent cannot manufacture its own work.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')

/** The layers that run on a timer, on a sync, or on correlated data — never on a gesture. */
const AUTOMATIC_LAYERS = ['services/sync.ts', 'correlation']

/** What they must not be able to reach. */
const FORBIDDEN = ['services/confirmation.ts', 'services/outbox.ts']

function filesUnder(entry: string): string[] {
  const full = join(SRC, entry)
  if (!existsSync(full)) throw new Error(`${entry} does not exist — this test is out of date`)
  if (statSync(full).isFile()) return [full]

  return readdirSync(full, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? filesUnder(join(entry, d.name))
      : d.name.endsWith('.ts')
        ? [join(full, d.name)]
        : [],
  )
}

/**
 * Every module reachable from these roots by following relative imports.
 *
 * Package and `node:` imports are ignored: the concern is this codebase's own
 * layering, and `node:crypto` is not going to enqueue an action.
 */
function reachableFrom(roots: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)

    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      // TypeScript ESM writes `./x.js` for what is `./x.ts` on disk.
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')))
    }
  }

  return seen
}

describe('the automatic layers cannot reach the confirmation minter', () => {
  it('does not import it, directly or through anything else', () => {
    const roots = AUTOMATIC_LAYERS.flatMap(filesUnder)
    expect(roots.length).toBeGreaterThan(0)

    const reachable = [...reachableFrom(roots)].map((f) => relative(SRC, f).replace(/\\/g, '/'))

    for (const forbidden of FORBIDDEN) {
      expect(
        reachable,
        `${forbidden} is reachable from sync/correlation. An action must originate with the ` +
          `operator (FR-060, XVI) — if this layer genuinely needs to read the outbox, that is a ` +
          `design conversation, not a test to relax.`,
      ).not.toContain(forbidden)
    }
  })

  it('is checking something — the same walk finds a module that IS imported', () => {
    // A reachability test that can never fail proves nothing. This asserts the
    // walk resolves real edges, so a false pass above would be visible.
    const reachable = [...reachableFrom(filesUnder('correlation'))].map((f) =>
      relative(SRC, f).replace(/\\/g, '/'),
    )
    expect(reachable).toContain('domain/types.ts')
  })
})

describe('an agent cannot mint its own confirmation', () => {
  const t = tempServices()
  const registry = t.registry
  afterAll(() => t.dispose())

  it('is registered ui-only', () => {
    const op = registry.get('outbox.mintConfirmation')
    expect(op?.exposure).toBe('ui-only')
    expect(registry.namesFor('mcp')).not.toContain('outbox.mintConfirmation')
    expect(registry.namesFor('http')).not.toContain('outbox.mintConfirmation')
  })

  it('is refused on the MCP surface at dispatch', async () => {
    await expect(
      registry.dispatch(
        'outbox.mintConfirmation',
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload: { to: 'Done' } },
        ctx(0, 'claude-code', 'mcp'),
      ),
    ).rejects.toThrow(/not available on the mcp surface/)
  })

  it('leaves enqueue useless to an agent — there is no token to be had', () => {
    expect(registry.namesFor('mcp')).not.toContain('outbox.enqueue')
    expect(registry.namesFor('mcp')).not.toContain('outbox.cancel')
    // What an agent *can* do is the whole of its job: see the queue, take work,
    // report the outcome.
    expect(registry.namesFor('mcp')).toEqual(
      expect.arrayContaining(['outbox.pending', 'outbox.claim', 'outbox.complete', 'outbox.fail']),
    )
  })
})

describe('an action cannot exist unconfirmed', () => {
  it('refuses an enqueue with no valid token', () => {
    const f = outboxFixture()
    try {
      for (const token of ['', 'made-up', 'x'.repeat(43)]) {
        try {
          f.service.enqueue(
            {
              subjectKey: SUBJECT,
              kind: 'transition-ticket',
              payload: { to: 'Done' },
              confirmationToken: token,
            },
            ctx(0),
          )
          throw new Error(`expected '${token}' to be refused`)
        } catch (e) {
          expect(isOperationError(e) && e.code).toBe('invalid')
        }
      }
      expect(f.service.list({})).toHaveLength(0)
    } finally {
      f.close()
    }
  })

  it('refuses a token minted for a different action', () => {
    const f = outboxFixture()
    try {
      const { token } = f.service.mintConfirmation(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload: { to: 'Done' } },
        ctx(0),
      )

      // Same token, different payload. A confirmation the operator gave for one
      // change must not authorise another.
      try {
        f.service.enqueue(
          {
            subjectKey: SUBJECT,
            kind: 'transition-ticket',
            payload: { to: 'Closed' },
            confirmationToken: token,
          },
          ctx(1),
        )
        throw new Error('expected a refusal')
      } catch (e) {
        expect(isOperationError(e) && e.code).toBe('invalid')
      }

      // And the failed attempt burned it, so it cannot be retried correctly.
      try {
        f.service.enqueue(
          {
            subjectKey: SUBJECT,
            kind: 'transition-ticket',
            payload: { to: 'Done' },
            confirmationToken: token,
          },
          ctx(2),
        )
        throw new Error('expected a refusal')
      } catch (e) {
        expect(isOperationError(e) && e.code).toBe('invalid')
      }
    } finally {
      f.close()
    }
  })

  it('refuses a token that has already been spent', () => {
    const f = outboxFixture()
    try {
      const payload = { to: 'Done' }
      const { token } = f.service.mintConfirmation(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload },
        ctx(0),
      )

      f.service.enqueue(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload, confirmationToken: token },
        ctx(1),
      )

      // One confirmation is one action. Otherwise a retry loop turns a single
      // "yes" into a stream of provider writes.
      try {
        f.service.enqueue(
          { subjectKey: SUBJECT, kind: 'transition-ticket', payload, confirmationToken: token },
          ctx(2),
        )
        throw new Error('expected a refusal')
      } catch (e) {
        expect(isOperationError(e) && e.code).toBe('invalid')
      }

      expect(f.service.list({})).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  it('refuses a token that has gone stale', () => {
    const f = outboxFixture()
    try {
      const payload = { to: 'Done' }
      const { token, expiresAt } = f.service.mintConfirmation(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload },
        ctx(0),
      )
      // Two minutes from the gesture, on the caller's clock — not on wall time.
      expect(expiresAt).toBe(at(120))

      // Two minutes and a second later: the dialog has been open too long to
      // count as informed consent.
      try {
        f.service.enqueue(
          { subjectKey: SUBJECT, kind: 'transition-ticket', payload, confirmationToken: token },
          ctx(121),
        )
        throw new Error('expected a refusal')
      } catch (e) {
        expect(isOperationError(e) && e.code).toBe('invalid')
      }
    } finally {
      f.close()
    }
  })

  it('binds regardless of key order in the payload', () => {
    const f = outboxFixture()
    try {
      const { token } = f.service.mintConfirmation(
        {
          subjectKey: SUBJECT,
          kind: 'transition-ticket',
          payload: { to: 'Done', comment: 'shipped' },
        },
        ctx(0),
      )

      // The same object, serialised differently. Failing here would look random
      // to a user and would push someone to weaken the binding.
      const action = f.service.enqueue(
        {
          subjectKey: SUBJECT,
          kind: 'transition-ticket',
          payload: { comment: 'shipped', to: 'Done' },
          confirmationToken: token,
        },
        ctx(1),
      )

      expect(action.state).toBe('pending')
    } finally {
      f.close()
    }
  })
})

describe('what the confirmation record says', () => {
  it('stamps who confirmed it and through which surface, from the context', () => {
    const f = outboxFixture()
    try {
      const action = confirmAndEnqueue(f)

      expect(action.confirmedAt).toBe(new Date(Date.parse('2026-08-14T10:00:00.000Z')).toISOString())
      expect(action.confirmedVia).toBe('ipc')
      expect(action.history[0]).toMatchObject({
        from: null,
        to: 'pending',
        actor: 'operator',
        detail: 'confirmed by the operator',
      })
    } finally {
      f.close()
    }
  })

  it('never holds the token itself', () => {
    const f = outboxFixture()
    try {
      const payload = { to: 'Done' }
      const { token } = f.service.mintConfirmation(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload },
        ctx(0),
      )
      f.service.enqueue(
        { subjectKey: SUBJECT, kind: 'transition-ticket', payload, confirmationToken: token },
        ctx(1),
      )

      // A token written to disk would be a replayable authorisation at rest,
      // which is the shape of a credential (XI).
      const dump = JSON.stringify(
        f.db.prepare('SELECT * FROM outbox_actions').all() as Record<string, unknown>[],
      )
      expect(dump).not.toContain(token)
    } finally {
      f.close()
    }
  })
})

describe('the outbox service in isolation', () => {
  it('cannot be constructed in a way that skips confirmation', () => {
    // The dependency is required, not optional. There is no "no confirmations"
    // mode to fall into.
    const service = outboxService({
      outbox: {
        insert: (a) => a,
        get: () => null,
        list: () => [],
        claim: () => null,
        transition: () => null,
        expireClaims: () => [],
      },
      confirmations: confirmationTokens(),
    })

    expect(() =>
      service.enqueue(
        {
          subjectKey: SUBJECT,
          kind: 'transition-ticket',
          payload: {},
          confirmationToken: 'nope',
        },
        ctx(0),
      ),
    ).toThrow()
  })
})
