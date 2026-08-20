import type { CoreServices } from '../runtime/services.js'
import { Registry } from './index.js'
import { configOperations } from './ops/config.js'
import { focusOperations } from './ops/focus.js'
import { historyOperations } from './ops/history.js'
import { linksOperations } from './ops/links.js'
import { notesOperations } from './ops/notes.js'
import { outboxOperations } from './ops/outbox.js'
import { promptsOperations } from './ops/prompts.js'
import { sessionsOperations } from './ops/sessions.js'
import { syncOperations } from './ops/sync.js'
import { updatesOperations } from './ops/updates.js'
import { workOperations } from './ops/work.js'

/**
 * The real registry and the real adapter set.
 *
 * Operations are registered here, in one place, so the answer to "what can this
 * product do?" is a file you can read rather than a search across the codebase.
 * The conformance test runs against these, so an adapter that forgets an entry
 * fails the build rather than quietly offering less on one surface than another
 * (constitution XII).
 *
 * **Three operations left this list and thirty-four did not.** `drift.list`,
 * `drift.dismiss` and `drift.undismiss` are gone because nothing produces a
 * finding: every one of the nine rules compared a ticket against a pull request,
 * a branch or a checkout.
 *
 * The **eight outbox operations stay, with no producer**. Nothing in the
 * interface can reach them any more — the only route ran through a drift
 * finding's confirmation dialog. They are the agent-facing half of a durable
 * store holding actions the operator confirmed, and they are the whole
 * implementation of gate XVI. Removing a second subsystem inside the change that
 * already carries the only data-losing migration compounds risk for no gain, so
 * this is recorded as a gap rather than tidied away.
 */
export function buildRegistry(services: CoreServices): Registry {
  const registry = new Registry()

  for (const op of [
    ...workOperations(services),
    ...linksOperations(services),
    ...notesOperations(services.notes),
    ...focusOperations(services.focus),
    ...updatesOperations(services.updates),
    ...promptsOperations(services.prompts),
    ...historyOperations(services.history),
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
