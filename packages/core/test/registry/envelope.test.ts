import { describe, expect, it } from 'vitest'
import { envelope, freshnessView } from '../../src/registry/envelope.js'
import type { FreshnessRecord } from '../../src/domain/types.js'

const NOW = Date.parse('2026-08-14T12:00:00Z')
const STALE_AFTER = 300 // 5 minutes

const record = (over: Partial<FreshnessRecord> = {}): FreshnessRecord => ({
  connectionId: 'c1',
  resourceKind: 'tickets',
  lastSuccessAt: null,
  lastFailureAt: null,
  failureReason: null,
  nextAttemptAt: null,
  ...over,
})

/**
 * Constitution XIV keeps four states distinct. The distinction is the whole
 * feature: a polling tool that silently shows stale data is worse than no tool,
 * because it converts "I don't know" into "I know, incorrectly."
 */
describe('freshnessView', () => {
  it('reports never — not stale — when nothing has ever synced', () => {
    const view = freshnessView(record(), NOW, STALE_AFTER)
    expect(view.state).toBe('never')
    // Not 0. An age of zero renders as "just updated", which is the exact
    // inversion of the truth for a resource that has never been fetched.
    expect(view.ageSec).toBeNull()
  })

  it('reports never for a resource with no record at all', () => {
    expect(freshnessView(undefined, NOW, STALE_AFTER).state).toBe('never')
  })

  it('reports fresh inside the window', () => {
    const view = freshnessView(
      record({ lastSuccessAt: '2026-08-14T11:58:00Z' }),
      NOW,
      STALE_AFTER,
    )
    expect(view.state).toBe('fresh')
    expect(view.ageSec).toBe(120)
  })

  it('reports stale outside the window when nothing has failed', () => {
    const view = freshnessView(record({ lastSuccessAt: '2026-08-14T11:00:00Z' }), NOW, STALE_AFTER)
    expect(view.state).toBe('stale')
    expect(view.ageSec).toBe(3600)
  })

  // Slow polling and an expired token are different situations, and only one of
  // them the user can do something about.
  it('reports failed when a refresh errored after the last success', () => {
    const view = freshnessView(
      record({
        lastSuccessAt: '2026-08-14T11:00:00Z',
        lastFailureAt: '2026-08-14T11:30:00Z',
        failureReason: 'auth',
      }),
      NOW,
      STALE_AFTER,
    )
    expect(view.state).toBe('failed')
    expect(view.failureReason).toBe('auth')
    // The last good data is still there and still dated. "Failed to refresh"
    // does not mean "no data" (XV).
    expect(view.ageSec).toBe(3600)
  })

  it('reports fresh again once a success lands after a failure', () => {
    const view = freshnessView(
      record({
        lastSuccessAt: '2026-08-14T11:59:00Z',
        lastFailureAt: '2026-08-14T11:30:00Z',
        failureReason: 'network',
      }),
      NOW,
      STALE_AFTER,
    )
    expect(view.state).toBe('fresh')
  })

  it('never reports a negative age when a clock skews', () => {
    const view = freshnessView(record({ lastSuccessAt: '2026-08-14T12:05:00Z' }), NOW, STALE_AFTER)
    expect(view.ageSec).toBe(0)
    expect(view.state).toBe('fresh')
  })

  it('carries the retry time so a lane can say when it will try again', () => {
    const view = freshnessView(
      record({
        lastSuccessAt: '2026-08-14T11:00:00Z',
        lastFailureAt: '2026-08-14T11:59:00Z',
        failureReason: 'rateLimit',
        nextAttemptAt: '2026-08-14T12:04:00Z',
      }),
      NOW,
      STALE_AFTER,
    )
    expect(view.state).toBe('failed')
    expect(view.nextAttemptAt).toBe('2026-08-14T12:04:00Z')
  })
})

/**
 * The envelope, with one resource kind to carry.
 *
 * These were written across several kinds, which made the per-kind claims easy
 * to see. `Envelope` is still keyed by kind and `partial` is still derived by
 * looking at every entry rather than taken on trust — so the tests are
 * narrowed rather than deleted, and the multi-kind shape is exercised with a
 * cast where the type no longer permits a second name.
 */
describe('envelope', () => {
  it('derives partial from a failed contributor rather than taking it on trust', () => {
    const fresh = freshnessView(record({ lastSuccessAt: '2026-08-14T11:59:00Z' }), NOW, STALE_AFTER)
    const failed = freshnessView(
      record({
        lastSuccessAt: '2026-08-14T11:00:00Z',
        lastFailureAt: '2026-08-14T11:30:00Z',
        failureReason: 'network',
      }),
      NOW,
      STALE_AFTER,
    )

    expect(envelope([1, 2], { tickets: fresh }).partial).toBe(false)
    expect(envelope([1, 2], { tickets: failed }).partial).toBe(true)
  })

  // A stale lane is not a degraded one. Marking it partial would push the UI
  // into showing a failure state for a provider that is working fine.
  it('does not call a merely stale envelope partial', () => {
    const stale = freshnessView(record({ lastSuccessAt: '2026-08-14T10:00:00Z' }), NOW, STALE_AFTER)
    expect(envelope([], { tickets: stale }).partial).toBe(false)
  })

  /**
   * Freshness is keyed per resource kind, not per envelope.
   *
   * There is one kind, so the second key is cast in. That is not a cheat: the
   * envelope is a `Partial<Record<ResourceKind, ...>>` and the property under
   * test is that it keeps each entry's own state rather than collapsing them
   * to one reading. 007 adds a second lane and this becomes observable again
   * without the cast.
   */
  it('keeps freshness per resource kind, not per envelope', () => {
    const tickets = freshnessView(record({ lastSuccessAt: '2026-08-14T11:59:00Z' }), NOW, STALE_AFTER)
    const other = freshnessView(undefined, NOW, STALE_AFTER)

    const e = envelope({ items: [] }, { tickets, other } as unknown as Parameters<typeof envelope>[1])
    const freshness = e.freshness as unknown as Record<string, { state: string }>

    expect(freshness['tickets']?.state).toBe('fresh')
    expect(freshness['other']?.state).toBe('never')
  })
})
