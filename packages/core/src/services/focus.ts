import { subjectKindOf, type NaturalKey } from '../domain/keys.js'
import type { ActiveTicket } from '../domain/types.js'
import { invalid } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { FocusRepository } from '../store/authored/focus.js'

/**
 * The active ticket — what the operator, or an agent, is on right now.
 *
 * Three rules, and each of them is a decision rather than an implementation
 * detail:
 *
 * 1. **`setBy` comes from `Ctx` and is never taken as input.** This operation is
 *    reachable from MCP by design — the operator's brief was "populated by MCP"
 *    — so the caller is frequently not the operator. An agent that could send
 *    `setBy: 'user'` would be writing a false provenance into the operator's own
 *    store, and the panel renders that field.
 *
 * 2. **The key's *shape* is validated; its *existence* is not.** A ticket key
 *    the mirror has never held is legal (FR-131). An agent may reasonably set
 *    focus before the sync that would fetch the ticket, and refusing would make
 *    the order of two unrelated operations matter. What is refused is a key that
 *    is not a ticket key at all — focus on a session or a repository is a
 *    caller's bug, and one that would render as an empty panel rather than an
 *    error.
 *
 * 3. **Setting focus touches nothing outside this file's table.** It does not
 *    transition the ticket, comment on it, or reach Jira, so gate XVI is not
 *    engaged and no confirmation token is minted. Worth stating because "an
 *    agent may set this" and "an agent may act on your behalf" are exactly the
 *    distinction XVI exists to police, and this is the first operation that is
 *    the former without being the latter.
 */

export interface FocusServiceDeps {
  focus: FocusRepository
  /**
   * Refuses a ticket key naming a Jira site no connection knows (`sites.ts`).
   *
   * Rule 2 below says the key's *existence* is not checked, and that stands: a
   * ticket the mirror has never held is legal and is the case FR-131 is written
   * for. A **site** nothing is configured to talk to is neither shape nor
   * existence — it is a key that can never resolve, and pointing the board at
   * one produces a panel that will say "not on your board" forever.
   */
  assertKnownSite?(key: NaturalKey): void
}

export interface FocusService {
  get(): ActiveTicket | null
  set(input: { ticketKey: NaturalKey }, ctx: Ctx): ActiveTicket
  clear(): { cleared: boolean }
}

export function focusService(deps: FocusServiceDeps): FocusService {
  const { focus } = deps

  return {
    get(): ActiveTicket | null {
      return focus.get()
    },

    set({ ticketKey }, ctx): ActiveTicket {
      if (subjectKindOf(ticketKey) !== 'ticket') {
        // Named, not merely rejected. The caller here is often a model reading
        // the error back, and "invalid key" would leave it guessing between a
        // typo and a category mistake.
        throw invalid(
          `The active ticket must be a ticket key (jira:<site>/<KEY>); received '${ticketKey}'.`,
        )
      }

      deps.assertKnownSite?.(ticketKey)

      return focus.set({
        ticketKey,
        setBy: ctx.authorKind,
        setById: ctx.authorId,
        setAt: ctx.now().toISOString(),
      })
    },

    clear(): { cleared: boolean } {
      // Deleting nothing is not an error. Two agents finishing the same ticket
      // both clear, and the second must not fail — but the caller is told which
      // it was, because "there was nothing set" is worth reporting to a human.
      return { cleared: focus.clear() }
    },
  }
}
