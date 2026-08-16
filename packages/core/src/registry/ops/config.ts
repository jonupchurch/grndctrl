import { z } from 'zod'
import type { CoreServices } from '../../runtime/services.js'
import { appStatus } from '../../services/app.js'
import { settingsSchema } from '../../services/settings.js'
import { invalid } from '../errors.js'
import type { Operation } from '../types.js'
import { defineOperation } from '../types.js'

/**
 * Connections, projects and settings.
 *
 * `connections.list` is the one to read carefully. A connection row holds a
 * *reference* to where its secret lives — `grndctrl/<connectionId>` — and never
 * the secret. The output schema below has no field a token could occupy, and
 * the handler maps field by field rather than spreading the row, so a column
 * added later cannot ride out to an agent by accident (XI, SC-011).
 *
 * **No operation accepts a token, including the ones that manage connections.**
 * Adding or re-authorizing a credential goes over its own IPC channel in the
 * shell (`grndctrl:credential`), never through the registry — because the
 * registry is served on three surfaces, and `ui-only` is a property that an
 * adapter bug or a careless later edit could get wrong. A secret that is not in
 * the registry cannot be exposed by getting the exposure wrong.
 *
 * `connections.test` and `connections.remove` are operations, because neither
 * carries a secret: one names a connection and reads, the other names a
 * connection and deletes.
 *
 * **Everything here except `projects.list` is `ui-only`, and the argument is the
 * same for all of it: configuration is the operator's.** An agent that could
 * rewrite a project binding could point the board at a repository the operator
 * does not work on; one that could change poll intervals could make the board
 * quietly stale. Neither is a write to a provider, so neither is caught by XVI —
 * the exposure is what stops them. `connections.list` is `ui-only` for a
 * narrower reason: it carries the operator's account identity, and an agent has
 * no use for it since `sync.status` already names every connection.
 *
 * `projects.list` stays open because an agent genuinely needs to know which
 * projects exist to make sense of a ticket key.
 */

/**
 * Mirrors `AppStatus` in `services/app.ts`.
 *
 * Written out rather than derived, because the output schema is the contract
 * three adapters are checked against and a schema inferred from the type would
 * agree with whatever the type happened to be.
 */
const appStatusSchema = z.object({
  version: z.string(),
  platform: z.string(),
  osRelease: z.string(),
  nodeVersion: z.string(),
  dbVersions: z.object({ mirror: z.number().int(), authored: z.number().int() }),
  runtimeAbi: z.object({
    modules: z.string(),
    electron: z.string().nullable(),
    isElectron: z.boolean(),
  }),
})

const connectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['jira', 'github']),
  siteOrHost: z.string(),
  accountLabel: z.string(),
  viewerIdentity: z
    .object({ accountId: z.string(), displayName: z.string().nullable() })
    .nullable(),
  /** Whether a credential is present. Never the credential, and never a prefix of it. */
  hasCredential: z.boolean(),
})

const projectSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  colorIndex: z.number().int().nullable(),
  jiraConnectionId: z.string().nullable(),
  jiraProjectKey: z.string().nullable(),
  githubConnectionId: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  documentationUrl: z.string().nullable(),
  ticketKeyPattern: z.string(),
  checkoutPaths: z.array(z.string()),
  statusOverrides: z.record(z.enum(['blocked', 'terminal', 'in-progress', 'backlog'])),
})

/**
 * The input is the same shape as the output, with nothing defaulted.
 *
 * Zod defaults would make the inferred input type diverge from `Project`, and
 * more to the point: a project with an implicit empty `checkoutPaths` is a
 * project that silently watches no repositories. Better that the caller says so.
 */
const projectInput = projectSchema

export function configOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'connections.list',
      description: 'Configured Jira and GitHub connections. Never returns a credential.',
      input: z.object({}),
      output: z.array(connectionSchema),
      exposure: 'ui-only',
      mutates: false,
      providerDerived: false,
      handler: async () =>
        services.mirror.listConnections().map((c) => ({
          // Field by field, deliberately. A spread would carry `credentialRef`
          // today and whatever gets added tomorrow.
          id: c.id,
          kind: c.kind,
          siteOrHost: c.siteOrHost,
          accountLabel: c.accountLabel,
          viewerIdentity: c.viewerIdentity,
          hasCredential: services.hasCredential(c.id),
        })),
    }),

    defineOperation({
      name: 'connections.test',
      description:
        'Check a stored credential against the live provider. Reads only; writes nothing.',
      input: z.object({
        connectionId: z.string().min(1),
        /** `owner/name`, a browser URL, or a clone URL. Falls back to a bound project. */
        repo: z.string().min(1).optional(),
      }),
      output: z.object({
        ok: z.boolean(),
        viewerIdentity: z
          .object({
            accountId: z.string(),
            displayName: z.string(),
            email: z.string().nullable(),
          })
          .nullable(),
        // Each probe reported separately. A GitHub token can authenticate, read
        // a repository, and still lack the scope `compare` needs -- and the only
        // symptom is an ahead/behind column that is quietly empty (R3). Folding
        // these into one boolean would hide exactly the failure worth naming.
        checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
      }),
      exposure: 'ui-only',
      mutates: false,
      providerDerived: false,
      handler: async (input) =>
        services.connections.test({
          connectionId: input.connectionId,
          ...(input.repo === undefined ? {} : { repo: input.repo }),
        }),
    }),

    defineOperation({
      name: 'connections.remove',
      description: 'Remove a connection and delete its stored credential.',
      input: z.object({ connectionId: z.string().min(1) }),
      output: z.object({ removed: z.boolean() }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      // FR-007: removal deletes the credential, not just the row. A row deleted
      // without its secret leaves a credential in the OS keychain that nothing
      // references and no screen can reach.
      handler: async (input) => services.connections.remove(input.connectionId),
    }),

    defineOperation({
      name: 'projects.list',
      description: 'The operator’s projects — one Jira project plus one repository each.',
      input: z.object({}),
      output: z.array(projectSchema),
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async () => services.projects.list(),
    }),

    defineOperation({
      name: 'projects.upsert',
      description: 'Create or update a project binding.',
      input: projectInput,
      output: projectSchema,
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input) => {
        // The pattern is compiled here rather than at first use. An invalid
        // regular expression saved now would fail inside correlation later,
        // where the error has no obvious connection to what the user typed.
        try {
          const compiled = new RegExp(input.ticketKeyPattern)
          if (compiled.source.indexOf('(') === -1) {
            throw invalid('The ticket key pattern needs a capture group around the key.')
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            throw invalid(`That ticket key pattern is not a valid expression: ${e.message}`)
          }
          throw e
        }

        return services.projects.upsert(input)
      },
    }),

    defineOperation({
      name: 'projects.remove',
      description: 'Remove a project binding. Notes and sessions are not touched.',
      input: z.object({ id: z.string().min(1) }),
      output: z.object({ id: z.string(), removed: z.boolean() }),
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input) => ({
        id: input.id,
        // Notes attach to natural keys, not to projects, so nothing authored is
        // lost here — the rows simply stop being shown under a project filter.
        removed: services.projects.remove(input.id),
      }),
    }),

    defineOperation({
      name: 'app.status',
      description: 'Versions, platform, database schema versions, and the runtime ABI.',
      input: z.object({}),
      output: appStatusSchema,
      // `all`, unlike everything else in this module. It carries no
      // configuration an agent could change and no account identity — versions,
      // a platform string, two schema numbers and the ABI. An agent that has
      // just failed to reach the app, or is reporting a problem on the
      // operator's behalf, needs exactly this and nothing more.
      exposure: 'all',
      mutates: false,
      providerDerived: false,
      handler: async () =>
        appStatus(services.databases.mirror, services.databases.authored),
    }),

    defineOperation({
      name: 'settings.get',
      description: 'Appearance, poll intervals, lane thresholds and window state.',
      input: z.object({}),
      output: settingsSchema,
      exposure: 'ui-only',
      mutates: false,
      providerDerived: false,
      handler: async () => services.settings.get(),
    }),

    defineOperation({
      name: 'settings.update',
      description: 'Change one or more settings. Omitted keys are left alone.',
      input: settingsSchema.partial(),
      output: settingsSchema,
      exposure: 'ui-only',
      mutates: true,
      providerDerived: false,
      handler: async (input) => services.settings.update(input),
    }),
  ]

  return ops as unknown as Operation<never, never>[]
}
