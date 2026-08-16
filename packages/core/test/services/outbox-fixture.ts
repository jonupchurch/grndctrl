import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { ticketKey } from '../../src/domain/keys.js'
import type { Ctx, Surface } from '../../src/registry/types.js'
import { confirmationTokens, type ConfirmationTokens } from '../../src/services/confirmation.js'
import { outboxService, type OutboxService } from '../../src/services/outbox.js'
import { outboxRepository } from '../../src/store/authored/outbox.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * A real outbox over a real database file.
 *
 * The durability claim (SC-008) is specifically that an action survives the
 * process that created it, so these tests close and reopen the database rather
 * than reaching into a fake.
 */

export const SUBJECT = ticketKey('acme.atlassian.net', 'MERC-1184')
export const T0 = Date.parse('2026-08-14T10:00:00.000Z')

export const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

export interface OutboxFixture {
  dir: string
  db: Database
  service: OutboxService
  confirmations: ConfirmationTokens
  /** Close and reopen. The service is rebuilt; the tokens are not, and must not be. */
  restart(): void
  close(): void
}

export interface FixtureOptions {
  claimLeaseSec?: number
  pendingTtlSec?: number
}

export function outboxFixture(options: FixtureOptions = {}): OutboxFixture {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-outbox-'))
  let ids = 0

  const f: OutboxFixture = {
    dir,
    db: undefined as unknown as Database,
    service: undefined as unknown as OutboxService,
    confirmations: undefined as unknown as ConfirmationTokens,

    restart() {
      f.db.close()
      build()
    },

    close() {
      f.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }

  function build(): void {
    f.db = openAuthored({ dir }).db
    // Fresh token store on every build, which is the truthful model: tokens live
    // in memory and a restart is meant to lose them.
    f.confirmations = confirmationTokens()
    f.service = outboxService({
      outbox: outboxRepository(f.db),
      confirmations: f.confirmations,
      ...(options.claimLeaseSec === undefined ? {} : { claimLeaseSec: options.claimLeaseSec }),
      ...(options.pendingTtlSec === undefined ? {} : { pendingTtlSec: options.pendingTtlSec }),
      newId: () => `action:${String(++ids).padStart(3, '0')}`,
    })
  }

  build()
  return f
}

export function ctx(seconds: number, who: 'operator' | string = 'operator', surface?: Surface): Ctx {
  const isAgent = who !== 'operator'
  return {
    authorKind: isAgent ? 'agent' : 'user',
    authorId: isAgent ? who : null,
    surface: surface ?? (isAgent ? 'mcp' : 'ipc'),
    now: () => new Date(T0 + seconds * 1000),
  }
}

/** Confirm and enqueue in one step — the operator gesture, as the UI performs it. */
export function confirmAndEnqueue(
  f: OutboxFixture,
  payload: Record<string, unknown> = { to: 'Done' },
  seconds = 0,
): ReturnType<OutboxService['enqueue']> {
  const c = ctx(seconds)
  const { token } = f.service.mintConfirmation(
    { subjectKey: SUBJECT, kind: 'transition-ticket', payload },
    c,
  )
  return f.service.enqueue(
    { subjectKey: SUBJECT, kind: 'transition-ticket', payload, confirmationToken: token },
    c,
  )
}
