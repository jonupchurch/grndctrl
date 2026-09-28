import { z } from 'zod'
import type { CoreServices } from '../../runtime/services.js'
import { resolveLink } from '../../services/links.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'
import { naturalKeySchema } from './schemas.js'

/**
 * Resolving a row to the page it opens.
 *
 * "Everything is a launcher" (FR-075), and every one of those URLs originates in
 * provider data — which is hostile input, and exactly where a `javascript:` or
 * `file:` URL would arrive from. Resolution happens here and only here, so the
 * scheme check happens once, in code with no UI around it (FR-077).
 *
 * The output is a plain URL rather than an envelope. It is derived from provider
 * data, but it is not *information about* the provider's state: a link is right
 * or it is broken, and "this link is four minutes old" would be noise.
 *
 * **`target` lost four of its seven members** with the code host and the local
 * checkout. They are enumerated in the schema rather than left open, so a caller
 * asking for `branch` gets a validation error naming the targets that do exist.
 * Falling back to the ticket would answer that caller, wrongly, in a way it
 * could not detect. `pull-request` came back with the ticket lane's PR column,
 * as a ticket's linked pull request read through Jira; see `services/links.ts`.
 */
export function linksOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'links.resolve',
      description:
        'Resolve a subject to the https URL it opens: a ticket, one of a ticket’s linked pull requests, a project board, or a project’s documentation link. Refuses any other scheme.',
      input: z.object({
        subjectKey: naturalKeySchema,
        target: z.enum(['default', 'ticket', 'documentation', 'pull-request']).optional(),
        /**
         * Which linked pull request, by position in the ticket's list, for
         * `pull-request`. A position rather than a URL so the caller still names
         * no destination — the URL comes from the mirror, as every other one does.
         */
        pullRequest: z.number().int().min(0).max(99).optional(),
      }),
      output: z.object({
        url: z.string().url(),
        /**
         * True when the exact page did not exist and something broader was
         * opened. **Permanently `false`**: the only case that set it was a
         * branch with no page falling back to its repository. Kept because the
         * distinction it draws is real and a caller reading it is told the
         * truth, and documented as always-false here so that is written down
         * rather than left to be discovered.
         */
        fellBack: z.boolean(),
      }),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (input) =>
        // Defaulted here rather than in the schema: a Zod `.default()` makes the
        // inferred input type optional in a way that fights the operation's own
        // type parameters, and the coalesce reads the same.
        resolveLink(
          input.subjectKey,
          input.target ?? 'default',
          {
            tickets: services.mirror.listTickets(),
            projects: services.projects.list(),
            connections: services.mirror.listConnections(),
          },
          input.pullRequest ?? 0,
        ),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
