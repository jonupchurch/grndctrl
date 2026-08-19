import type { NaturalKey, SubjectKind } from '../domain/keys.js'
import { subjectKindOf } from '../domain/keys.js'
import type { ResourceKind } from '../domain/types.js'
import type { SubjectPresence } from '../services/notes.js'
import type { MirrorRepository } from '../store/mirror/repository.js'

/**
 * "Does this subject still exist?" — asked across two database files.
 *
 * Notes and sessions are authored; tickets are mirrored. Answering needs both,
 * and neither store may hold a handle to the other (XIII), so the join happens
 * here in code — the same way the board joins them, and for the same reason.
 *
 * The answer is three-valued. Two-valued would be a lie on first launch: an
 * unsynced mirror holds no tickets, and reporting *every* note as orphaned
 * because polling has not finished yet would be the most alarming possible
 * first screen, and wrong.
 *
 * **A note on a pull request, a branch, a checkout or a check now answers
 * `unknown`**, and that is the correct answer rather than a gap. Those notes are
 * retained (FR-109) and readable by key; what is gone is any store that could
 * say whether their subject still exists. `absent` would be a claim this
 * application is no longer in a position to make, and would invite a cleanup of
 * the operator's own writing on the strength of it.
 */

const RESOURCE_FOR: Partial<Record<SubjectKind, ResourceKind>> = {
  ticket: 'tickets',
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
    // A bare repository key never had a mirrored row of its own; a pull request,
    // branch, checkout or check no longer has one either. Both cases land here,
    // and both are genuinely unanswerable rather than answerably absent.
    if (resource === undefined) return 'unknown'

    if (deps.mirror.hasSubject(key)) return 'present'

    // Absent from a table that has never been filled means nothing at all.
    return deps.mirror.hasEverSynced(resource) ? 'absent' : 'unknown'
  }
}
