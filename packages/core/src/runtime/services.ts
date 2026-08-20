import type { Database } from 'better-sqlite3'
import type { CredentialStore } from '../auth/keychain.js'
import { credentialRef, parseCredentialRef, unavailableKeychain } from '../auth/keychain.js'
import type { WorkItem } from '../domain/types.js'
import type { Fetcher } from '../providers/http.js'
import type { Envelope } from '../registry/envelope.js'
import { buildBoard, envelopeBoard } from '../services/board.js'
import { runSync, type SyncReport } from '../services/sync.js'
import { buildSyncTargets, type BuiltTargets } from './providers.js'
import { confirmationTokens, type ConfirmationTokens } from '../services/confirmation.js'
import { focusService, type FocusService } from '../services/focus.js'
import { updatesService, type UpdatesService } from '../services/updates.js'
import { promptsService, type PromptsService } from '../services/prompts.js'
import { notesService, type NotesService } from '../services/notes.js'
import { outboxService, type OutboxService } from '../services/outbox.js'
import { connectionsService, type ConnectionsService } from '../services/connections.js'
import { sessionsService, type SessionsService } from '../services/sessions.js'
import { settingsStore, type SettingsStore } from '../services/settings.js'
import { projectsRepository, type ProjectsRepository } from '../store/authored/config.js'
import { focusRepository } from '../store/authored/focus.js'
import { updatesRepository } from '../store/authored/updates.js'
import { promptsRepository } from '../store/authored/prompts.js'
import { notesRepository } from '../store/authored/notes.js'
import { outboxRepository } from '../store/authored/outbox.js'
import { sessionsRepository } from '../store/authored/sessions.js'
import { mirrorRepository, type MirrorRepository } from '../store/mirror/repository.js'
import { openAuthored, openMirror } from '../store/open.js'
import { subjectPresenceResolver } from './presence.js'

/**
 * The composition root: two database files in, one bundle of services out.
 *
 * This is where the two stores are joined, and it is the *only* place. Neither
 * repository holds a handle to the other's file, so anything needing both —
 * "is this note's subject still there?", "which tickets have an agent on them?"
 * — is assembled here in code (XIII). There is no SQL join to write because
 * there is no foreign key to join on, by design.
 *
 * Nothing in this file knows what an adapter is. It builds fine with Electron
 * uninstalled, which is the point of XVIII and the reason the CLI can drive the
 * whole engine.
 */

export interface CoreServices {
  mirror: MirrorRepository
  projects: ProjectsRepository
  /** Adding, testing and removing provider credentials (FR-005 to FR-007). */
  connections: ConnectionsService
  notes: NotesService
  /** The one ticket being worked. Authored, and settable by an agent (FR-127). */
  focus: FocusService
  /** What agents have said while working. Append-only (FR-132). */
  updates: UpdatesService
  /** Prompts kept so they can be sent again. The one authored thing with a delete (FR-136). */
  prompts: PromptsService
  sessions: SessionsService
  outbox: OutboxService
  settings: SettingsStore
  confirmations: ConfirmationTokens
  /** The whole board, correlated and wrapped in its freshness envelope (XIV). */
  board(now: Date): Envelope<BoardView>
  /** Whether a connection has a credential. Never whether it is valid, and never the value. */
  hasCredential(connectionId: string): boolean
  /** Connections that cannot sync, and which of the two reasons applies. */
  credentialGaps(): BuiltTargets['unavailable']
  syncNow(options: { connectionId?: string | undefined }, now: Date): Promise<SyncReport>
  databases: { mirror: Database; authored: Database }
  close(): void
}

export interface BoardView {
  workItems: WorkItem[]
}

export interface CoreServicesOptions {
  /** The data directory. Both database files live side by side inside it. */
  dir: string
  /**
   * Where credentials live.
   *
   * Defaults to a store that reports itself unreachable rather than to the OS
   * keychain, because reaching the real one means loading a native module —
   * and core must stay importable with no native binding and no Electron
   * (XVIII). The host injects the real store.
   */
  credentials?: CredentialStore
  /** Injected so a sync can be driven from recorded fixtures with no network. */
  fetcher?: Fetcher
  /**
   * Where the compiled SQLite addon lives, when it is not the copy in
   * `node_modules`. Electron needs its own ABI build; see `store/open.ts`.
   */
  nativeBinding?: string | undefined
}

export function createCoreServices(options: CoreServicesOptions): CoreServices {
  const open = { dir: options.dir, nativeBinding: options.nativeBinding }
  const openedMirror = openMirror(open)
  const mirrorDb = openedMirror.db
  const authoredDb = openAuthored(open).db

  const mirror = mirrorRepository(mirrorDb)
  const notesRepo = notesRepository(authoredDb)
  const sessionsRepo = sessionsRepository(authoredDb)
  const projects = projectsRepository(authoredDb)
  const settings = settingsStore(authoredDb)

  // Notes ask the sessions store whether a session subject exists; sessions ask
  // the notes store which subjects have open questions. Both at the repository
  // level, so the two services do not depend on each other and neither has to
  // be constructed first.
  const notes = notesService({
    notes: notesRepo,
    subjectPresence: subjectPresenceResolver({ mirror, hasSession: (key) => sessionsRepo.has(key) }),
  })

  const focus = focusService({ focus: focusRepository(authoredDb) })

  // Both dependencies are read per call rather than captured, so an update
  // posted after the operator moves focus captures the ticket that is active
  // *then* — which is the whole point of capturing it at all.
  const updates = updatesService({
    updates: updatesRepository(authoredDb),
    agentOf: (sessionKey) => sessionsRepo.get(sessionKey)?.agentId ?? null,
    activeTicket: () => focus.get()?.ticketKey ?? null,
  })

  // Nothing injected. Unlike an update, a prompt takes its author from `Ctx`
  // rather than from a session, and its `sessionKey` and `projectId` are labels
  // it stores rather than references it resolves — so there is no second store
  // for this one to reach.
  const prompts = promptsService({ prompts: promptsRepository(authoredDb) })

  const sessions = sessionsService({
    sessions: sessionsRepo,
    openQuestionSubjects: () => notesRepo.openQuestionSubjects(),
    // Read per call rather than captured, so changing the setting takes effect
    // without a restart.
    missMultiplier: () => settings.get().heartbeatMissMultiplier,
  })

  const confirmations = confirmationTokens()
  const outbox = outboxService({ outbox: outboxRepository(authoredDb), confirmations })

  const credentials = options.credentials ?? unavailableKeychain()

  /*
   * FR-112: delete the secrets belonging to connections the mirror migration
   * removed.
   *
   * **The order is the whole thing, and it is enforced by position.**
   * `openMirror` read these references before migration 4 dropped the rows
   * holding them; after the migration there is nothing left that names them.
   * Deleting first and reading after would find an empty list and leave a live
   * token in the operator's keychain, unreachable and unremovable through any
   * screen. `open.ts` has the read; `store/keychain-orphans.test.ts` has the
   * ordering.
   *
   * Empty on every launch but the upgrade, and empty on that one too for an
   * operator who never added a code host. Each deletion is caught on its own: a
   * keyring that cannot be reached is a reason to leave the rest of the launch
   * alone, not to fail it, and the alternative to a best-effort cleanup here is
   * no cleanup at all.
   */
  for (const handle of openedMirror.orphanedCredentialRefs) {
    const ref = parseCredentialRef(handle)
    if (ref === null) continue
    try {
      credentials.delete(ref)
    } catch {
      // Nothing to report to. The secret belongs to a provider this application
      // no longer speaks to, and a failed cleanup must not stop the app opening.
    }
  }

  /**
   * Providers are rebuilt per sync rather than cached.
   *
   * A cached client would hold a credential in memory for the life of the
   * process and keep using a token the operator has since revoked or replaced.
   * Rebuilding costs nothing measurable next to an HTTP round trip.
   */
  const buildTargets = (now?: () => Date): BuiltTargets =>
    buildSyncTargets({
      projects: projects.list(),
      connections: mirror.listConnections(),
      credentials,
      fetcher: options.fetcher,
      now,
    })

  const connections = connectionsService({ mirror, credentials, fetcher: options.fetcher })

  return {
    mirror,
    projects,
    connections,
    notes,
    focus,
    updates,
    prompts,
    sessions,
    outbox,
    settings,
    confirmations,
    databases: { mirror: mirrorDb, authored: authoredDb },

    board(now) {
      const current = settings.get()

      const board = buildBoard({
        mirror,
        projects: projects.list(),
        // The real note data, at last. Until now these were inputs a caller had
        // to supply; the count on every row, and the questions driving
        // ball-in-court, now come from what the operator and agents wrote
        // (FR-052, FR-053).
        noteCounts: notesRepo.countsBySubject(),
        openQuestionSubjects: notesRepo.openQuestionSubjects(),
        sessions: sessionsRepo.list(),
        settings: current,
        now,
      })

      return envelopeBoard({ workItems: board.workItems }, mirror, now, current)
    },

    hasCredential(connectionId) {
      try {
        const secret = credentials.get(credentialRef(connectionId))
        return secret !== null && secret !== ''
      } catch {
        // The keychain being unreachable is not "no credential" — but for the
        // purpose of this boolean it is equally unusable, and the distinction
        // is reported properly by `credentialGaps`.
        return false
      }
    },

    credentialGaps: () => buildTargets().unavailable,

    async syncNow(request, now) {
      const built = buildTargets(() => now)

      return runSync({
        mirror,
        // The gaps travel with the targets, so a connection that could not be
        // given a provider is reported as a failed refresh rather than skipped
        // in silence. `buildSyncTargets` has always computed `unavailable`;
        // until now the only thing that read it was `sync.status`, which the
        // interface never called.
        targets: { ...built.targets, unavailable: built.unavailable },
        settings: settings.get(),
        now: () => now,
        ...(request.connectionId === undefined ? {} : { connectionId: request.connectionId }),
      })
    },

    close() {
      mirrorDb.close()
      authoredDb.close()
    },
  }
}
