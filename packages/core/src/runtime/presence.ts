import type { NaturalKey, SubjectKind } from '../domain/keys.js'
import { subjectKindOf } from '../domain/keys.js'
import type { ResourceKind } from '../domain/types.js'
import type { SubjectPresence } from '../services/notes.js'
import type { MirrorRepository } from '../store/mirror/repository.js'

/**
 * "Does this subject still exist?" — asked across two database files.
 *
 * Notes and sessions are authored; tickets, pull requests and branches are
 * mirrored. Answering needs both, and neither store may hold a handle to the
 * other (XIII), so the join happens here in code — the same way the board joins
 * them, and for the same reason.
 *
 * The answer is three-valued. Two-valued would be a lie on first launch: an
 * unsynced mirror holds no tickets, and reporting *every* note as orphaned
 * because polling has not finished yet would be the most alarming possible
 * first screen, and wrong. Per resource kind rather than globally, so a synced
 * branch list still gives real answers while tickets are still loading.
 */

const RESOURCE_FOR: Partial<Record<SubjectKind, ResourceKind>> = {
  ticket: 'tickets',
  'pull-request': 'pulls',
  branch: 'branches',
  workspace: 'local',
  check: 'checks',
}

export interface PresenceDeps {
  mirror: MirrorRepository
  /** Sessions are authored, so their absence is a fact rather than a maybe. */
  hasSession(key: NaturalKey): boolean
}

export function subjectPresenceResolver(deps: PresenceDeps): (key: NaturalKey) => SubjectPresence {
  return (key) => {
    const kind = subjectKindOf(key)
    if (kind === null) return 'unknown'

    // Authored, and therefore knowable. There is no "we have not fetched it
    // yet" state for something this machine wrote itself.
    if (kind === 'session') return deps.hasSession(key) ? 'present' : 'absent'

    const resource = RESOURCE_FOR[kind]
    // A bare repository key has no mirrored row of its own — a repository is
    // implied by its branches — so its presence genuinely cannot be answered.
    if (resource === undefined) return 'unknown'

    if (deps.mirror.hasSubject(key)) return 'present'

    // Absent from a table that has never been filled means nothing at all.
    return deps.mirror.hasEverSynced(resource) ? 'absent' : 'unknown'
  }
}
