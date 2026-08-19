import { describe, expect, it } from 'vitest'
import { formatAge } from '../../src/renderer/components/StaleBar.js'
import { PALETTE_SIZE, paletteIndexOf } from '../../src/renderer/components/ProjectChip.js'
import { worstFreshness, type Envelope, type FreshnessView } from '../../src/renderer/query.js'

/**
 * The parts of the renderer foundation that are decisions rather than markup.
 *
 * Rendering is checked end to end against a real Chromium in `test/e2e`; what is
 * here is the logic underneath — which colour a project gets, what "3d 04h"
 * means, and which of several freshness states a header should report. Each one
 * has an edge that a component test would not reach.
 */

const view = (over: Partial<FreshnessView>): FreshnessView => ({
  lastSuccessAt: '2026-08-14T12:00:00.000Z',
  lastFailureAt: null,
  failureReason: null,
  nextAttemptAt: null,
  state: 'fresh',
  ageSec: 60,
  ...over,
})

const envelope = (freshness: Record<string, FreshnessView>): Envelope<unknown> => ({
  data: [],
  freshness,
  partial: false,
})

describe('the freshness a header reports', () => {
  it('takes the worst, not the average', () => {
    // A header that averaged would say "mostly fine" about a board one of whose
    // resources has not refreshed since a token expired (XV).
    const worst = worstFreshness(
      envelope({
        tickets: view({ state: 'fresh' }),
        sessions: view({ state: 'failed', failureReason: 'auth' }),
        projects: view({ state: 'stale' }),
      }),
    )

    expect(worst?.state).toBe('failed')
    expect(worst?.failureReason).toBe('auth')
  })

  // The distinction XIV insists on. "Never synced" is not "stale with a big
  // number" — there is no age, and claiming one would be inventing data.
  it('ranks never-synced above stale and below failed', () => {
    expect(worstFreshness(envelope({ a: view({ state: 'stale' }), b: view({ state: 'never' }) }))?.state).toBe('never')
    expect(worstFreshness(envelope({ a: view({ state: 'never' }), b: view({ state: 'failed' }) }))?.state).toBe('failed')
  })

  it('is null when there is nothing to report rather than pretending to be fresh', () => {
    expect(worstFreshness(undefined)).toBeNull()
    expect(worstFreshness(envelope({}))).toBeNull()
  })
})

describe('project colours', () => {
  const ids = ['delta', 'alpha', 'charlie', 'bravo']
  const unpinned = (id: string): { id: string; colorIndex: null } => ({ id, colorIndex: null })

  it('uses the colour the operator pinned, in preference to anything computed', () => {
    // They have said "this project is the blue one". Nothing here should argue.
    expect(paletteIndexOf({ id: 'delta', colorIndex: 0 }, ids)).toBe(0)
    expect(paletteIndexOf({ id: 'alpha', colorIndex: 5 }, ids)).toBe(5)
  })

  it('falls back to sorted position, so the colours are the same on every machine', () => {
    // Not by hash: a screenshot in a pull request has to show the colours a
    // colleague will see. And not by arrival order, which varies.
    expect(paletteIndexOf(unpinned('alpha'), ids)).toBe(0)
    expect(paletteIndexOf(unpinned('bravo'), ids)).toBe(1)
    expect(paletteIndexOf(unpinned('delta'), ids)).toBe(3)
  })

  it('does not depend on the order the list arrives in', () => {
    expect(paletteIndexOf(unpinned('charlie'), ids)).toBe(
      paletteIndexOf(unpinned('charlie'), [...ids].reverse()),
    )
  })

  it('returns -1 for a project not in the list, which renders neutral', () => {
    expect(paletteIndexOf(unpinned('echo'), ids)).toBe(-1)
  })

  it('sends the seventh project past the palette rather than reusing a colour', () => {
    const seven = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']
    expect(paletteIndexOf(unpinned('p7'), seven)).toBe(6)
    expect(paletteIndexOf(unpinned('p7'), seven) >= PALETTE_SIZE).toBe(true)
  })
})

describe('the age in a row', () => {
  const now = new Date('2026-08-14T12:00:00.000Z')
  const ago = (ms: number): string => new Date(now.getTime() - ms).toISOString()

  it('is coarse above an hour and fine below it', () => {
    expect(formatAge(ago(30_000), now)).toBe('now')
    expect(formatAge(ago(9 * 60_000), now)).toBe('9m')
    expect(formatAge(ago(3 * 3600_000), now)).toBe('3h')
  })

  it('shows two units below a week and one above', () => {
    // "9d 03h" is more digits than meaning on something nine days old.
    expect(formatAge(ago((3 * 24 + 4) * 3600_000), now)).toBe('3d 04h')
    expect(formatAge(ago(9 * 24 * 3600_000), now)).toBe('9d')
  })

  it('says nothing rather than something wrong when there is no timestamp', () => {
    expect(formatAge(null, now)).toBe('—')
    expect(formatAge('not a date', now)).toBe('—')
  })

  // Clocks disagree, and a provider timestamp a few seconds in the future is
  // ordinary. "in 4 seconds" on a board about lateness is not.
  it('clamps a future timestamp instead of counting backwards', () => {
    expect(formatAge(ago(-5000), now)).toBe('now')
  })
})
