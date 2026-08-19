import { describe, expect, it } from 'vitest'
import { tempServices } from '../helpers/services.js'

/**
 * What 006 was supposed to leave alone (T038a).
 *
 * **This is the milestone's real risk.** The danger in removing drift is not
 * that drift fails to leave — a deletion is easy to verify. It is that drift
 * takes a passenger: something that happened to be wired through it, or read by
 * it, or displayed beside it, and whose only visible symptom afterwards is an
 * absence nobody thinks to look for.
 *
 * Three passengers were identified in advance, and each gets one test here
 * rather than being checked once by eye during the change.
 */

const ctx = {
  authorKind: 'agent' as const,
  authorId: 'a1',
  surface: 'mcp' as const,
  now: () => new Date('2026-08-14T12:00:00Z'),
}

const uiCtx = { ...ctx, authorKind: 'user' as const, authorId: null, surface: 'ipc' as const }

describe('the bystanders of the drift removal', () => {
  /**
   * The outbox.
   *
   * Its only route from the interface ran through a drift finding's
   * confirmation dialog, so "nothing reaches it" is true and is not a reason to
   * remove it — it is the agent-facing half of a durable store holding actions
   * the operator confirmed, and gate XVI has no other implementation.
   *
   * The registry-level version of this is in `conformance.test.ts`; this is the
   * one that proves the operations still *work* rather than merely still being
   * listed, because an operation registered against a service that was quietly
   * unwired would pass the first and fail here.
   */
  it('still answers an outbox query, rather than merely listing the operation', async () => {
    const t = tempServices()
    try {
      const pending = await t.registry.dispatch('outbox.pending', {}, ctx)
      expect(pending).toEqual([])

      const listed = await t.registry.dispatch('outbox.list', {}, ctx)
      expect(listed).toEqual([])
    } finally {
      t.dispose()
    }
  })

  /**
   * `notes.questions`.
   *
   * The renderer read this to feed the Attention region, and that is the read
   * most likely to have been deleted along with the component it fed. Two other
   * things depend on it: the question mark on a row's note badge, and
   * ball-in-court. FR-121 is the requirement; this is the operation still being
   * answerable at all.
   */
  it('still answers notes.questions', async () => {
    const t = tempServices()
    try {
      await expect(t.registry.dispatch('notes.questions', {}, ctx)).resolves.toEqual([])
    } finally {
      t.dispose()
    }
  })

  /**
   * FR-121, end to end through the real services.
   *
   * An agent writes a `question-for-human` note against a session; the board
   * has to put that item in the operator's court. The unit-level version is in
   * `join.test.ts`, which hands `correlate` an `openQuestionSubjects` array
   * directly. This one goes through the notes store, the presence resolver and
   * `buildBoard` — the path that was actually at risk, because it is the one
   * that has a component-shaped hole in the middle of it now.
   */
  it('still moves ball-in-court to the operator for an open question', async () => {
    const t = tempServices()
    try {
      const session = (await t.registry.dispatch(
        'sessions.start',
        { agentId: 'a1', sessionId: 's1', heartbeatIntervalSec: 60 },
        ctx,
      )) as { key: string }

      await t.registry.dispatch(
        'notes.create',
        { subjectKey: session.key, type: 'question-for-human', body: 'Which branch should I cut from?' },
        ctx,
      )

      const questions = (await t.registry.dispatch('notes.questions', {}, uiCtx)) as {
        subjectKey: string
        resolvedAt: string | null
      }[]

      expect(questions).toHaveLength(1)
      expect(questions[0]?.subjectKey).toBe(session.key)
      expect(questions[0]?.resolvedAt).toBeNull()

      // And the session reads as needing the operator, which is what the state
      // derivation does with an open question. The board has no work item here
      // — there is no ticket — so the session lane is where it lands, and that
      // is the surface 007 gives the display back to.
      const sessions = (await t.registry.dispatch('sessions.list', {}, uiCtx)) as {
        key: string
        state: string
      }[]

      expect(sessions.find((s) => s.key === session.key)?.state).toBe('needs-you')
    } finally {
      t.dispose()
    }
  })

  /**
   * The dismissal rows.
   *
   * Retained by FR-122 with no reader and no writer, which is the one entity in
   * this change that ends up inert rather than gone. The table has to still
   * exist, because M4's migration is required not to open it and a migration
   * cannot leave alone a table that is not there.
   */
  it('still has the finding_dismissals table, with nothing reading it', () => {
    const t = tempServices()
    try {
      const tables = (
        t.services.databases.authored
          .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
          .all() as { name: string }[]
      ).map((r) => r.name)

      expect(tables).toContain('finding_dismissals')

      // And no operation offers it. A reader reintroduced without the rules
      // that produce findings would be a surface onto identifiers that no
      // longer resolve.
      expect(t.registry.names().filter((n) => n.includes('drift') || n.includes('dismiss'))).toEqual(
        [],
      )
    } finally {
      t.dispose()
    }
  })
})
