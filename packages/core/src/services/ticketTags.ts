import { issueKeyOfTicketKey, subjectKindOf, type NaturalKey } from '../domain/keys.js'
import type { TicketTag, TicketTagDefinition } from '../domain/types.js'
import { invalid } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { TicketTagsRepository } from '../store/authored/ticketTags.js'

/**
 * Ticket tags (010): at most one per ticket, chosen from the definitions in
 * settings. The operator sets them from the ticket row; agents can too.
 *
 * An assignment whose tag has since been deleted from settings is left in the
 * table and **left out of every read** — the tag no longer exists, so a ticket
 * carrying it would be showing something the operator removed.
 */

export interface TicketTagView extends TicketTag {
  issueKey: string
  label: string
  color: string
}

export interface TicketTagsServiceDeps {
  tags: TicketTagsRepository
  definitions(): TicketTagDefinition[]
  assertKnownSite?(key: NaturalKey): void
}

export interface TicketTagsService {
  /** The tags that exist, and every ticket carrying one of them. */
  list(): { definitions: TicketTagDefinition[]; tags: TicketTagView[] }
  /** `tagId: null` clears the ticket's tag. Returns the tag now on it, or null. */
  set(input: { ticketKey: NaturalKey; tagId: string | null }, ctx: Ctx): TicketTagView | null
}

export function ticketTagsService(deps: TicketTagsServiceDeps): TicketTagsService {
  const view = (tag: TicketTag, defs: TicketTagDefinition[]): TicketTagView | null => {
    const def = defs.find((d) => d.id === tag.tagId)
    if (def === undefined) return null
    return {
      ...tag,
      issueKey: issueKeyOfTicketKey(tag.ticketKey) ?? tag.ticketKey,
      label: def.label,
      color: def.color,
    }
  }

  return {
    list() {
      const definitions = deps.definitions()
      const tags = deps.tags.list().flatMap((t) => {
        const v = view(t, definitions)
        return v === null ? [] : [v]
      })
      return { definitions, tags }
    },

    set(input, ctx) {
      if (subjectKindOf(input.ticketKey) !== 'ticket') {
        throw invalid(
          `Only a ticket can be tagged; '${input.ticketKey}' is not a ticket key. A ticket key is jira:<site>/<ISSUE-KEY>.`,
        )
      }
      deps.assertKnownSite?.(input.ticketKey)

      if (input.tagId === null) {
        deps.tags.clear(input.ticketKey)
        return null
      }

      const definitions = deps.definitions()
      if (!definitions.some((d) => d.id === input.tagId)) {
        throw invalid(
          `There is no tag '${input.tagId}'. The tags are: ${definitions.map((d) => `${d.id} (${d.label})`).join(', ') || 'none'}.`,
        )
      }

      const stored = deps.tags.set({
        ticketKey: input.ticketKey,
        tagId: input.tagId,
        authorKind: ctx.authorKind,
        authorId: ctx.authorId ?? null,
        at: ctx.now().toISOString(),
      })
      return view(stored, definitions)
    },
  }
}
