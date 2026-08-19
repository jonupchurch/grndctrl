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

/**
 * `kind` is a one-member enum, and it narrowed here rather than at M2.
 *
 * An operation's output is parsed against its own schema, so narrowing this
 * while the mirror could still return a `github` row would have made
 * `connections.list` throw on a value the application itself had written — the
 * board would read "Ground Control could not reach its own service" for every
 * operator upgrading with a GitHub connection configured. It waited for
 * migration 4, which deletes those rows and leaves a CHECK that refuses new
 * ones. The enum and the table now agree.
 */
const connectionSchema = z.object({
  id: z.string(),
  kind: z.enum(['jira']),
  siteOrHost: z.string(),
  accountLabel: z.string(),
  viewerIdentity: z
    .object({ accountId: z.string(), displayName: z.string().nullable() })
    .nullable(),
  /** Whether a credential is present. Never the credential, and never a prefix of it. */
  hasCredential: z.boolean(),
})

/**
 * Four fields left this schema: `githubConnectionId`, `repoOwner`, `repoName`
 * and `checkoutPaths`.
 *
 * The narrowing does the work in both directions and neither is incidental. On
 * the way *out*, Zod strips unknown keys, so a `Project` still carrying the four
 * columns is answered without them — the boundary is narrow before the store
 * is. On the way *in*, a caller that still sends `repoOwner` has it dropped
 * rather than written, which is what stops a client built against 0.3.0 from
 * quietly repopulating a column this change is in the middle of removing.
 *
 * `jiraProjectKey` stays **nullable** here even though `projects.upsert` now
 * refuses a null one. That is deliberate: the schema is also the *output* shape,
 * and a database written by 0.3.0 can hold a repository-only project whose key
 * is null. 006 keeps that row (FR-110), so the schema has to be able to describe
 * it. The constraint belongs on the write, where the operator is present to be
 * told why — not on the read, where it would make an existing row unreadable.
 */
const projectSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  colorIndex: z.number().int().nullable(),
  jiraConnectionId: z.string().nullable(),
  jiraProjectKey: z.string().nullable(),
  documentationUrl: z.string().nullable(),
  statusOverrides: z.record(z.enum(['blocked', 'terminal', 'in-progress', 'backlog'])),
})

/** The input is the same shape as the output, with nothing defaulted. */
const projectInput = projectSchema

export function configOperations(services: CoreServices): Operation<never, never>[] {
  const ops = [
    defineOperation({
      name: 'connections.list',
      description: 'Configured Jira connections. Never returns a credential.',
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
        // `repo` was here: which repository to probe with, since a token could
        // authenticate and still not be able to read one. There is no repository
        // to probe.
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
        // Each probe reported separately, and the array shape stays even though
        // there are fewer probes in it. It exists because folding several checks
        // into one boolean hides the failure worth naming — a token that
        // authenticates against a site but cannot see the bound project is a
        // different problem from one that does not authenticate at all, and one
        // tick over the pair says neither. That reasoning does not depend on how
        // many probes there are.
        checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
      }),
      exposure: 'ui-only',
      mutates: false,
      providerDerived: false,
      handler: async (input) => services.connections.test({ connectionId: input.connectionId }),
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
      description: 'The operator’s projects. Each names one Jira project.',
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
        /*
         * A project must name a ticket project.
         *
         * This was a table CHECK — `jira_project_key IS NOT NULL OR repo_name
         * IS NOT NULL` — and half of that disjunction no longer exists. It
         * moves here rather than becoming a narrower CHECK for two reasons.
         *
         * The table has to stay permissive enough to hold a legacy
         * repository-only row (FR-110): a replacement constraint would refuse
         * one, and the tidy way to satisfy a constraint during a migration is to
         * delete the row that violates it. There is no server-side copy of the
         * operator's projects (XI), so that deletion is unrecoverable.
         *
         * And this is where the operator is standing. A constraint violation
         * surfaces as a store failure with SQLite's own wording; a validation
         * here names the field and says what is wrong with it.
         */
        if (input.jiraProjectKey === null || input.jiraProjectKey.trim() === '') {
          throw invalid('A project must name a ticket project key. Without one it has nothing to show.')
        }

        /*
         * The ticket-key pattern was validated here and is gone.
         *
         * It answered one question -- *does this branch or pull request name a
         * ticket?* -- asked by `correlation/match.ts`, which 006 deletes.
         * Nothing names a ticket from outside Jira any more, so the pattern had
         * no reader: a setting the operator could carefully get right and which
         * changed nothing, which is a lie the interface tells slowly. The column
         * goes with it in authored migration 2.
         *
         * The validation was worth having while the field was: an invalid
         * expression saved here would have failed inside correlation later,
         * where the error has no obvious connection to what was typed.
         */
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
