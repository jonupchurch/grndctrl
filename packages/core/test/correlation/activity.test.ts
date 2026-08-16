import { describe, expect, it } from 'vitest'
import {
  clampToReceipt,
  countsAsRealActivity,
  lastRealActivity,
  latestOf,
} from '../../src/correlation/activity.js'
import { stalenessBand, thresholdMultiple } from '../../src/correlation/staleness.js'
import type { TicketActivity } from '../../src/domain/types.js'
import { hoursAgo, NOW } from './builders.js'

const entry = (over: Partial<TicketActivity> = {}): TicketActivity => ({
  ticketKey: 'jira:acme.atlassian.net/MERC-1' as TicketActivity['ticketKey'],
  at: hoursAgo(1),
  authorKind: 'human',
  field: 'status',
  countsAsReal: true,
  ...over,
})

/**
 * FR-026 says what counts; FR-027 says what does not, and that half is the
 * point. A ticket touched hourly by an automation rule looks alive on
 * `updated_at` and is in fact abandoned — a board that believes `updated_at`
 * will confidently report the most neglected work as the freshest.
 */
describe('what counts as real activity', () => {
  it('counts a human state change', () => {
    for (const field of ['status', 'assignee', 'comment', 'description', 'priority']) {
      expect(countsAsRealActivity({ authorKind: 'human', field }), field).toBe(true)
    }
  })

  it('does not count a bot or automation touching anything', () => {
    expect(countsAsRealActivity({ authorKind: 'bot', field: 'comment' })).toBe(false)
    expect(countsAsRealActivity({ authorKind: 'automation', field: 'status' })).toBe(false)
  })

  // Label churn is how automation announces itself, and a backlog grooming drag
  // reorders a hundred tickets without anyone doing work on any of them.
  it('does not count a label change or a rank change, even from a human', () => {
    expect(countsAsRealActivity({ authorKind: 'human', field: 'labels' })).toBe(false)
    expect(countsAsRealActivity({ authorKind: 'human', field: 'rank' })).toBe(false)
    expect(countsAsRealActivity({ authorKind: 'human', field: 'watchers' })).toBe(false)
  })

  it('does not count an unrecognised field rather than guessing', () => {
    expect(countsAsRealActivity({ authorKind: 'human', field: 'customfield_10042' })).toBe(false)
  })
})

describe('lastRealActivity', () => {
  it('takes the most recent entry that counts', () => {
    expect(
      lastRealActivity([
        entry({ at: hoursAgo(10) }),
        entry({ at: hoursAgo(2) }),
        entry({ at: hoursAgo(30) }),
      ]),
    ).toBe(hoursAgo(2))
  })

  it('ignores entries that do not count, however recent', () => {
    expect(
      lastRealActivity([
        entry({ at: hoursAgo(48) }),
        entry({ at: hoursAgo(1), countsAsReal: false, authorKind: 'bot' }),
      ]),
    ).toBe(hoursAgo(48))
  })

  // Unknown is a distinct answer from old, and must never be backfilled from
  // `updated_at` -- that is the field FR-027 exists to distrust, and
  // substituting it turns "we could not fetch the history" into a confident
  // wrong answer.
  it('returns null when nothing counts, rather than falling back', () => {
    expect(lastRealActivity([])).toBeNull()
    expect(lastRealActivity([entry({ countsAsReal: false })])).toBeNull()
  })

  it('ignores an unparseable timestamp instead of throwing', () => {
    expect(lastRealActivity([entry({ at: 'not a date' }), entry({ at: hoursAgo(5) })])).toBe(
      hoursAgo(5),
    )
  })
})

describe('latestOf', () => {
  it('picks the newest and skips nulls', () => {
    expect(latestOf([hoursAgo(10), null, hoursAgo(3), undefined])).toBe(hoursAgo(3))
    expect(latestOf([null, undefined])).toBeNull()
  })
})

/**
 * An agent with a skewed clock reporting a future time would otherwise sort to
 * the top of the board and stay there, reading as permanently fresh.
 */
describe('clampToReceipt', () => {
  it('clamps a future timestamp to now', () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString()
    expect(clampToReceipt(future, NOW)).toBe(NOW.toISOString())
  })

  it('leaves a past timestamp alone', () => {
    expect(clampToReceipt(hoursAgo(2), NOW)).toBe(hoursAgo(2))
  })

  it('falls back to now for an unparseable timestamp', () => {
    expect(clampToReceipt('whenever', NOW)).toBe(NOW.toISOString())
  })
})

/**
 * Two measures, deliberately separate: the gauge is absolute so a row's bar
 * means the same in every lane, and the severity contribution is relative to
 * the lane's threshold because 24 hours is unremarkable for a ticket and
 * overdue for a pull request.
 */
describe('the staleness gauge', () => {
  it('bands on absolute time', () => {
    expect(stalenessBand(hoursAgo(1), NOW)).toBe('idle')
    expect(stalenessBand(hoursAgo(10), NOW)).toBe('recent')
    expect(stalenessBand(hoursAgo(48), NOW)).toBe('aging')
    expect(stalenessBand(hoursAgo(100), NOW)).toBe('stale')
    expect(stalenessBand(hoursAgo(300), NOW)).toBe('abandoned')
  })

  // Unknown is not evidence of neglect. Rendering it as the most alarming band
  // would make every ticket whose history failed to fetch scream for attention.
  it('treats unknown activity as idle, not abandoned', () => {
    expect(stalenessBand(null, NOW)).toBe('idle')
  })
})

describe('threshold multiples', () => {
  it('counts whole multiples of the lane threshold', () => {
    expect(thresholdMultiple(hoursAgo(10), NOW, 72)).toBe(0)
    expect(thresholdMultiple(hoursAgo(80), NOW, 72)).toBe(1)
    expect(thresholdMultiple(hoursAgo(150), NOW, 72)).toBe(2)
    expect(thresholdMultiple(hoursAgo(300), NOW, 72)).toBe(4)
  })

  it('is zero when activity is unknown', () => {
    expect(thresholdMultiple(null, NOW, 72)).toBe(0)
  })

  it('does not divide by a zero threshold', () => {
    expect(thresholdMultiple(hoursAgo(100), NOW, 0)).toBe(0)
  })
})
