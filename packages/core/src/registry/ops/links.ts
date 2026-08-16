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
 * or it is broken, and "this link is four minutes old" would be noise. What the
 * output does carry is `fellBack`, so the UI can say why a branch row opened the
 * repository instead of the branch (FR-076).
 */
export function linksOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'links.resolve',
      description:
        'Resolve a subject to the https URL it opens. Refuses any other scheme. Falls back to the repository for a branch the host has never seen.',
      input: z.object({
        subjectKey: naturalKeySchema,
        target: z
          .enum([
            'default',
            'ticket',
            'pull-request',
            'repository',
            'branch',
            'documentation',
            'check',
          ])
          .optional(),
      }),
      output: z.object({
        url: z.string().url(),
        /** True when the exact page did not exist and something broader was opened. */
        fellBack: z.boolean(),
      }),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async (input) =>
        // Defaulted here rather than in the schema: a Zod `.default()` makes the
        // inferred input type optional in a way that fights the operation's own
        // type parameters, and the coalesce reads the same.
        resolveLink(input.subjectKey, input.target ?? 'default', {
          tickets: services.mirror.listTickets(),
          pullRequests: services.mirror.listPullRequests(),
          branches: services.mirror.listBranches(),
          projects: services.projects.list(),
          checks: services.mirror.listChecks(),
          connections: services.mirror.listConnections(),
        }),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
