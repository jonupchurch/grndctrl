import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The board refreshes itself (T074 — FR-013).
 *
 * This is the only test in the suite that can fail for the reason that matters:
 * `packages/core/test/runtime/scheduler.test.ts` proves the *rules* — cadence,
 * backoff, the cap — against injected timers, and would go on passing
 * perfectly if `main/index.ts` never called `start()`. A scheduler nobody
 * starts is exactly the defect this project keeps producing, so the wiring
 * needs a test that runs the real shell and touches no injected clock.
 *
 * Nothing here clicks anything. That is the assertion.
 *
 * The seeded connections carry a `credentialRef` pointing at a keychain entry
 * that does not exist, so the poll fails — which is *better* evidence than a
 * success would be: `lastFailureAt` moving proves a fetch was attempted and
 * recorded, and it costs no network. The connection ids (`jira-1`, `gh-1`) are
 * not the operator's own, so this cannot reach a real provider by accident.
 */

const SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
  'canonical-board.json',
)

interface Freshness {
  connectionId: string
  resourceKind: string
  lastFailureAt: string | null
  lastSuccessAt: string | null
}

const status = (app: LaunchedApp): Promise<Freshness[]> =>
  app.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      sync: { status(input: unknown): Promise<{ ok: boolean; data: unknown }> }
    }
    const result = await bridge.sync.status({})
    if (!result.ok) throw new Error('sync.status failed')
    return (result.data as { connections: Freshness[] }).connections
  })

const stamp = (rows: Freshness[], connectionId: string): string =>
  rows
    .filter((r) => r.connectionId === connectionId)
    .map((r) => `${r.resourceKind}:${r.lastSuccessAt ?? ''}/${r.lastFailureAt ?? ''}`)
    .sort()
    .join('|')

let it: LaunchedApp

/**
 * The seeded `lastSuccessAt`, read before anything can have polled.
 *
 * Captured rather than written down. It used to be the literal
 * `2026-08-14T11:57:00Z` from the fixture, which stopped being true the moment
 * scenario timestamps became offsets resolved at load (FR-118) — and an
 * assertion that pins a constant from a file is one edit away from failing for a
 * reason that has nothing to do with polling.
 */
let seededSuccess: string | null = null

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  // Start collecting `sync:progress` before the first poll can fire, and keep
  // collecting for the whole file. A test that subscribes when it runs is a test
  // racing a three-second timer, and the loser waits a full poll interval for
  // the next one.
  await it.window.evaluate(() => {
    const events: string[] = []
    ;(globalThis as Record<string, unknown>)['__syncPhases'] = events
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      on: { syncProgress(listener: (p: unknown) => void): () => void }
    }
    bridge.on.syncProgress((payload) => events.push((payload as { phase: string }).phase))
  })

  seededSuccess =
    (await status(it)).find((r) => r.connectionId === 'jira-1' && r.resourceKind === 'tickets')
      ?.lastSuccessAt ?? null
})

test.afterAll(async () => {
  await it.close()
})

test('polls on its own, without anything being clicked', async () => {
  const seeded = await status(it)

  // The scheduler waits before its first pass so the window can paint (SQLite
  // is synchronous and shares this process), then runs on its tick. Polling for
  // the change rather than sleeping a fixed span: this asserts *that* it
  // happens, and pinning the exact second would be a test about the delay
  // constant instead.
  await expect
    .poll(async () => stamp(await status(it), 'jira-1'), { timeout: 30_000, intervals: [500] })
    .not.toBe(stamp(seeded, 'jira-1'))

  /*
   * A second assertion followed, against `gh-1`: both providers polled, not
   * just whichever one happened to be first in the map. The seeded scenario has
   * a GitHub connection and it is no longer synced, so there is one target here
   * and nothing to compare it against.
   *
   * The property is not lost — `scheduler.test.ts` drives two targets on two
   * cadences directly, which is where the map-ordering question belongs anyway.
   * 007 does not add a second connection, so this stays a unit-level guarantee.
   */
})

test('tells the window a poll happened, so the numbers on screen follow', async () => {
  // The mirror being refreshed is only half of it. `sync:progress` is what makes
  // the renderer refetch; without it the poll updates the database and the
  // window keeps showing the previous board — while the freshness reading
  // underneath, which comes from the same refetch, goes on saying the data is
  // current. Stale numbers labelled fresh is worse than stale numbers.
  //
  // This is the assertion that distinguishes the scheduler dispatching through
  // the observed wrapper from dispatching straight at the service. Checking the
  // mirror cannot see the difference — both write the same rows.
  const phases = (): Promise<string[]> =>
    it.window.evaluate(
      () => [...((globalThis as Record<string, unknown>)['__syncPhases'] as string[])],
    )

  await expect
    .poll(phases, { timeout: 30_000, intervals: [250] })
    .toEqual(expect.arrayContaining(['started', 'finished']))
})

test('records the attempt as a failure, so the board does not claim to be fresh', async () => {
  // The pair that has to stay together: something ran, and it did not succeed.
  // A poll that swallowed the credential gap would move `lastSuccessAt` and
  // leave the lanes reading green over data nobody could fetch — the exact
  // failure `sync.now` had before the degradation work.
  //
  // `lastSuccessAt` is not null and should not be: the seed writes the mirror
  // as if a sync had succeeded, which is what makes this the interesting case.
  // The assertion is that the automatic poll did not *touch* it — the last
  // success is still the seeded one, from before the app was launched.
  const rows = await status(it)
  const jira = rows.find((r) => r.connectionId === 'jira-1' && r.resourceKind === 'tickets')

  expect(seededSuccess).not.toBeNull()
  expect(jira?.lastSuccessAt).toBe(seededSuccess)
  expect(jira?.lastFailureAt).not.toBeNull()
  expect(Date.parse(jira?.lastFailureAt ?? '')).toBeGreaterThan(
    Date.parse(jira?.lastSuccessAt ?? ''),
  )
})
