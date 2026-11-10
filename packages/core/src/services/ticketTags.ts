import { randomUUID } from 'node:crypto'
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
  /** Writes the whole list back to settings. Validated there. */
  saveDefinitions?(definitions: TicketTagDefinition[]): void
  assertKnownSite?(key: NaturalKey): void
  /** Overridable so tests get stable ids. */
  newId?(): string
}

/**
 * Colours handed to a tag created without one, in order, skipping any already
 * in use. Distinct from the three defaults.
 */
export const AGENT_TAG_PALETTE = [
  '#7c3aed',
  '#0284c7',
  '#db2777',
  '#ea580c',
  '#0d9488',
  '#4b5563',
] as const

export interface TicketTagsService {
  /** The tags that exist, and every ticket carrying one of them. */
  list(): { definitions: TicketTagDefinition[]; tags: TicketTagView[] }
  /** `tagId: null` clears the ticket's tag. Returns the tag now on it, or null. */
  set(input: { ticketKey: NaturalKey; tagId: string | null }, ctx: Ctx): TicketTagView | null
  /**
   * Create a tag (0.11.0), so an agent can add one the operator asked for. A
   * tag with the same name, ignoring case, is returned as it is rather than
   * duplicated. Renaming, recolouring and removing stay in Settings.
   */
  define(input: { label: string; color?: string | undefined }): {
    definition: TicketTagDefinition
    created: boolean
  }
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

  const newId = deps.newId ?? (() => `tag-${randomUUID().slice(0, 8)}`)

  return {
    define(input) {
      if (deps.saveDefinitions === undefined) throw invalid('Tags cannot be defined here.')
      const label = input.label.trim()
      if (label === '') throw invalid('A tag needs a name.')

      const definitions = deps.definitions()
      const existing = definitions.find((d) => d.label.toLowerCase() === label.toLowerCase())
      if (existing !== undefined) return { definition: existing, created: false }

      const used = new Set(definitions.map((d) => d.color.toLowerCase()))
      const color =
        input.color?.toLowerCase() ??
        AGENT_TAG_PALETTE.find((c) => !used.has(c)) ??
        AGENT_TAG_PALETTE[definitions.length % AGENT_TAG_PALETTE.length]!

      const definition = { id: newId(), label, color }
      // Settings validates the list — colour shape, length, the count limit —
      // and refuses with the reason, so nothing is checked twice here.
      deps.saveDefinitions([...definitions, definition])
      return { definition, created: true }
    },

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
