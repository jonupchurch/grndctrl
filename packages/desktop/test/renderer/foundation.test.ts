import { describe, expect, it } from 'vitest'
import { formatAge } from '../../src/renderer/components/StaleBar.js'
import { PALETTE_SIZE, paletteIndexOf } from '../../src/renderer/components/ProjectChip.js'
import { worstFreshness, type Envelope, type FreshnessView } from '../../src/renderer/query.js'
import {
  describePull,
  describeWorkspace,
  severityOfPull,
} from '../../src/renderer/lanes/Lanes.js'
import type { Comparison, PullRequest, Workspace } from '../../src/renderer/types.js'

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
    // A header that averaged would say "mostly fine" about a board whose pull
    // requests have not refreshed since a token expired (XV).
    const worst = worstFreshness(
      envelope({
        tickets: view({ state: 'fresh' }),
        pulls: view({ state: 'failed', failureReason: 'auth' }),
        branches: view({ state: 'stale' }),
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

/**
 * The two status strings the lanes compute.
 *
 * Both were wrong in the same way and neither could fail: the renderer kept a
 * hand-written copy of the domain types, and it had drifted. `describeWorkspace`
 * read ahead/behind off the workspace, where core has never put them, and
 * printed "in sync" for a branch 83 commits behind. `describePull` compared
 * against GitHub's raw `CHANGES_REQUESTED` when the provider normalises to
 * `changesRequested`, so every pull request rendered "In review".
 *
 * The types are derived with `Pick` now, so a field core does not have is a
 * compile error. These cover the values, which `Pick` cannot.
 */

/** `NaturalKey` is branded, so a fixture cannot hand over a bare string. */
const key = <T,>(s: string): T => s as T

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  key: key<Workspace['key']>('repo:github.com/acme/mercury#main'),
  branch: 'main',
  canonicalRemote: 'github.com/acme/mercury',
  hasUncommittedChanges: false,
  unpushedCommitCount: 0,
  ...over,
})

const comparison = (aheadBy: number | null, behindBy: number | null): Comparison => ({
  branchKey: key<Comparison['branchKey']>('repo:github.com/acme/mercury#main'),
  aheadBy,
  behindBy,
})

describe('describeWorkspace', () => {
  it('says the answer is unknown when the host has no comparison', () => {
    // Never "in sync". FR-018: a branch the code host has not seen is unknown,
    // and reporting it as zero is the one thing that requirement forbids.
    expect(describeWorkspace(workspace(), undefined)).toBe('unknown vs base')
  })

  it('says unknown when the host answered that it does not know', () => {
    expect(describeWorkspace(workspace(), comparison(null, null))).toBe('unknown vs base')
  })

  it('reports ahead and behind from the comparison', () => {
    expect(describeWorkspace(workspace(), comparison(0, 83))).toBe('83 behind')
    expect(describeWorkspace(workspace(), comparison(2, 3))).toBe('2 ahead · 3 behind')
  })

  it('only says in sync when the host actually said zero and zero', () => {
    expect(describeWorkspace(workspace(), comparison(0, 0))).toBe('in sync')
  })

  it('distinguishes no upstream from nothing to push', () => {
    // core uses null for "there is no upstream". Typed as a plain number, the
    // old renderer compared `null > 0`, got false, and said nothing at all.
    expect(describeWorkspace(workspace({ unpushedCommitCount: null }), comparison(0, 0))).toBe(
      'no upstream',
    )
    expect(describeWorkspace(workspace({ unpushedCommitCount: 2 }), comparison(0, 0))).toBe(
      '2 unpushed',
    )
  })

  it('reports uncommitted work alongside the comparison', () => {
    expect(describeWorkspace(workspace({ hasUncommittedChanges: true }), comparison(0, 5))).toBe(
      'uncommitted · 5 behind',
    )
  })
})

describe('describePull', () => {
  const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
    key: key<PullRequest['key']>('pr:github.com/acme/mercury#1'),
    number: 1,
    title: 'Reconcile worktree state',
    headBranch: 'MERC-1',
    state: 'open',
    isDraft: false,
    reviewDecision: null,
    unresolvedThreadCount: 0,
    lastRealActivityAt: null,
    ...over,
  })

  it('recognises core’s normalised review decisions', () => {
    expect(describePull(pull({ reviewDecision: 'changesRequested' }))).toBe('Changes requested')
    expect(describePull(pull({ reviewDecision: 'approved' }))).toBe('Approved')
  })

  it('escalates severity when changes were requested', () => {
    expect(severityOfPull(pull({ reviewDecision: 'changesRequested' }), 'good')).toBe('serious')
    expect(severityOfPull(pull({ unresolvedThreadCount: 2 }), 'good')).toBe('warning')
  })

  it('prefers draft over everything else', () => {
    expect(describePull(pull({ isDraft: true, reviewDecision: 'approved' }))).toBe('Draft')
  })
})
