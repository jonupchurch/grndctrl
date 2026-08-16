import type { CoreServices } from '../runtime/services.js'
import { Registry } from './index.js'
import { configOperations } from './ops/config.js'
import { driftOperations } from './ops/drift.js'
import { linksOperations } from './ops/links.js'
import { notesOperations } from './ops/notes.js'
import { outboxOperations } from './ops/outbox.js'
import { sessionsOperations } from './ops/sessions.js'
import { syncOperations } from './ops/sync.js'
import { workOperations } from './ops/work.js'

/**
 * The real registry and the real adapter set.
 *
 * Operations are registered here, in one place, so the answer to "what can this
 * product do?" is a file you can read rather than a search across the codebase.
 * The conformance test runs against these, so an adapter that forgets an entry
 * fails the build rather than quietly offering less on one surface than another
 * (constitution XII).
 */
export function buildRegistry(services: CoreServices): Registry {
  const registry = new Registry()

  for (const op of [
    ...workOperations(services),
    ...driftOperations(services),
    ...linksOperations(services),
    ...notesOperations(services.notes),
    ...sessionsOperations(services.sessions),
    ...outboxOperations(services.outbox),
    ...syncOperations(services),
    ...configOperations(services),
  ]) {
    registry.register(op)
  }

  return registry
}

/**
 * Adapters are checked live, not from a list here.
 *
 * An earlier version of this file exported a hand-maintained `ALL_ADAPTERS`,
 * which was empty and therefore made the conformance gate pass vacuously. The
 * check that means something starts the real adapter and asks it what it
 * exposes: `test/adapters/http.test.ts` for the loopback API and
 * `packages/mcp/test/conformance.test.ts` for MCP. A declared list would agree
 * with the wiring until the day it did not, which is precisely the drift XII
 * exists to catch.
 */
