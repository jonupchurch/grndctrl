import { describe, expect, it } from 'vitest'
import { correlate } from '../../src/correlation/join.js'
import { hoursAgo, input, keys, project, session, ticket } from './builders.js'

/**
 * SC-004: ten consecutive runs over identical inputs produce byte-identical
 * output.
 *
 * This is not a performance property, it is a correctness one. Correlation
 * output drives note attachment (keyed on natural key) and a UI that re-renders
 * every poll. Non-determinism there looks like a board that flickers — a symptom
 * nobody would trace back to iteration order.
 *
 * **The finding-id half of SC-004 is gone with drift**, and it was the sharper
 * half: a dismissal is keyed on a finding id, so a non-deterministic id meant
 * dismissals that evaporated on the next sync. What survives is the ordering
 * guarantee, which is the one that still has consumers.
 *
 * The board below has less shape than it did — four tickets and two sessions,
 * where it had six pull requests, two checks, two branches and three workspaces.
 * That is a real reduction in surface area and is worth naming rather than
 * glossing: the `expect(workItems.length).toBeGreaterThan(...)` guard at the end
 * is what stops this file degenerating into ten runs agreeing about nothing.
 */

/** A board with every shape the engine still handles. */
function busyBoard() {
  const projects = [
    project(),
    project({ id: 'p-atls', code: 'ATLS', jiraProjectKey: 'ATLS' }),
  ]

  return input({
    projects,
    tickets: [
      ticket({ issueKey: 'MERC-1184', statusName: 'In Review' }),
      ticket({ issueKey: 'MERC-1190', statusCategory: 'new', statusName: 'Todo' }),
      ticket({ issueKey: 'MERC-9000', statusCategory: 'done', statusName: 'Done' }),
      ticket({ issueKey: 'MERC-7', lastStatusChangeAt: hoursAgo(400), lastRealActivityAt: hoursAgo(400) }),
      ticket({ issueKey: 'ATLS-3', isBlocked: true, statusName: 'Blocked' }),
    ],
    sessions: [
      session({ sessionId: 's1' }),
      session({ sessionId: 's2', lastHeartbeatAt: hoursAgo(5) }),
      session({ sessionId: 's3', workItemKey: keys.ticket('MERC-1190') }),
    ],
    noteCounts: { [keys.ticket('MERC-1184')]: 3 },
    openQuestionSubjects: [keys.ticket('MERC-1190')],
  })
}

describe('determinism', () => {
  it('produces byte-identical correlation output across ten runs', () => {
    const runs = Array.from({ length: 10 }, () => JSON.stringify(correlate(busyBoard())))
    expect(new Set(runs).size).toBe(1)
  })

  // Provider responses arrive in whatever order the API felt like. If input
  // order leaked into output order, the board would reshuffle every poll.
  it('is unaffected by the order the inputs arrive in', () => {
    const forward = busyBoard()
    const reversed = {
      ...forward,
      tickets: [...forward.tickets].reverse(),
      sessions: [...forward.sessions].reverse(),
      projects: [...forward.projects].reverse(),
    }

    expect(JSON.stringify(correlate(reversed))).toBe(JSON.stringify(correlate(forward)))
  })

  /**
   * The natural keys are stable when unrelated inputs change.
   *
   * This is what is left of "finding ids stay stable": notes attach to a natural
   * key, so a key that changed because a note count changed would detach every
   * note on the board from the row it was written against.
   */
  it('keeps work item keys stable when unrelated inputs change', () => {
    const before = busyBoard()
    const keysBefore = correlate(before).workItems.map((w) => w.key)

    const after = {
      ...before,
      noteCounts: { ...before.noteCounts, [keys.ticket('MERC-9000')]: 9 },
    }

    expect(correlate(after).workItems.map((w) => w.key)).toEqual(keysBefore)
  })

  it('produces a non-trivial board, so the check has something to check', () => {
    const { workItems } = correlate(busyBoard())

    // Guards against the failure mode where all ten runs agree on nothing.
    expect(workItems.length).toBeGreaterThan(4)
    expect(workItems.some((w) => w.sessions.length > 0)).toBe(true)
    // More than one severity on the board, or "identical output" is a claim
    // about a board with nothing to distinguish.
    expect(new Set(workItems.map((w) => w.severity)).size).toBeGreaterThan(1)
  })
})
