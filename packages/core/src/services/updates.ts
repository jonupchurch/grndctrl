import { randomUUID } from 'node:crypto'
import type { NaturalKey } from '../domain/keys.js'
import type { AgentUpdate } from '../domain/types.js'
import { notFound } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { UpdateFilter, UpdatesRepository } from '../store/authored/updates.js'

/**
 * What an agent said, while it was working (FR-132).
 *
 * The service exists for one reason: **two of the four fields on an update are
 * not the agent's to supply.**
 *
 * - `agentId` comes from the session the update is posted against, not from the
 *   payload. An agent that could name its own author could post as another one,
 *   and the panel's whole value is that it says who said what.
 * - `ticketKey` is the active ticket **at this moment**, captured here and
 *   stored. Letting an agent supply it would let an update be attributed to work
 *   it was not doing; resolving it at read time instead would silently
 *   re-attribute the entire history every time the operator moved focus.
 *
 * Posting against a session that does not exist is refused rather than accepted
 * with a null author. An update whose agent cannot be named is not something the
 * panel can render, and "start a session first" is a thing an agent can act on.
 */

export interface UpdatesServiceDeps {
  updates: UpdatesRepository
  /** The session's agent, or null when the key is unknown. Injected, not joined. */
  agentOf(sessionKey: NaturalKey): string | null
  /** The active ticket right now, captured at post time. */
  activeTicket(): NaturalKey | null
  /** Overridable so tests get stable ids without stubbing global crypto. */
  newId?(): string
}

export interface PostUpdateInput {
  sessionKey: NaturalKey
  text: string
}

export interface UpdatesService {
  list(filter?: UpdateFilter): AgentUpdate[]
  post(input: PostUpdateInput, ctx: Ctx): AgentUpdate
}

export function updatesService(deps: UpdatesServiceDeps): UpdatesService {
  const { updates, agentOf, activeTicket } = deps
  const newId = deps.newId ?? (() => `update:${randomUUID()}`)

  return {
    list(filter?: UpdateFilter): AgentUpdate[] {
      return updates.list(filter)
    },

    post({ sessionKey, text }, ctx): AgentUpdate {
      const agentId = agentOf(sessionKey)
      if (agentId === null) {
        throw notFound(
          `No session '${sessionKey}'. Start a session before posting an update against it.`,
        )
      }

      return updates.append({
        id: newId(),
        sessionKey,
        agentId,
        // Captured now. See the note above on why this is not a join.
        ticketKey: activeTicket(),
        text,
        postedAt: ctx.now().toISOString(),
      })
    },
  }
}
