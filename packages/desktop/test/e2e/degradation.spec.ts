import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The board on a bad morning (T157 — US6, XV).
 *
 * A developer's tools are most needed exactly when something is broken, so the
 * question this answers is not "does it show an error" but **"is it still
 * usable"**. An application that blanks itself because one of its connections
 * failed has chosen a purity that serves nobody, and the failure mode is silent
 * — the lanes just look empty, which reads as "no work" rather than "no data".
 *
 * **What XV looks like with one provider.** This file used to demonstrate the
 * guarantee across three lanes: one provider failing while the others rendered.
 * That comparison is gone with the providers, and the tempting reading is that
 * the guarantee went with it. It did not — it changed shape. The board is no
 * longer *tickets, pull requests and checkouts*; it is *provider-derived data and
 * everything else*, and everything else is a large fraction of the screen: the
 * agent session panel, the ball-in-court accounting, the tiles, the notes, and
 * the notice explaining what broke. So the line the failure must not cross runs
 * between the ticket lane and the rest of the page, and that is what is asserted
 * below.
 *
 * The seeded connection carries a `credentialRef` pointing at a keychain entry
 * that does not exist, which is precisely the state a revoked or deleted token
 * leaves behind. So this is a real revocation rather than a simulated one, and
 * it costs no network: the connection id is `jira-1`, which is not the
 * operator's own (`jira`), so nothing here can reach a real provider with a real
 * credential even by accident.
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

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
})

test.afterAll(async () => {
  await it.close()
})

test('the board says it cannot refresh, rather than ageing quietly', async () => {
  // The state before a refresh is attempted: the seeded freshness is what it
  // is, and the notice is derived from the credential gap rather than from a
  // failed fetch — so it is true from the first paint.
  const notice = it.window.getByRole('status', { name: 'Connections that cannot refresh' })

  await expect(notice).toBeVisible()
  await expect(notice.getByText(/no stored credential/)).toBeVisible()

  // Naming which one. "A connection is broken" sends the operator to check all
  // of them, which is the work the application is supposed to have done.
  // The site the *scenario* names, which is where the seeded connection's site
  // now comes from. It read `example.atlassian.net` until 2026-08-20 — a literal
  // the seeder invented, against tickets keyed to `acme.atlassian.net`, so the
  // seeded board disagreed with itself and nothing compared the two.
  await expect(notice.getByText(/Jira · acme\.atlassian\.net/)).toBeVisible()

  // And saying that pressing Refresh cannot help, because it cannot — that is
  // the sentence that distinguishes this from an ordinary stale lane.
  await expect(notice.getByText(/pressing Refresh cannot help/)).toBeVisible()
})

test('a refresh that could not happen is reported as a failure, not a success', async () => {
  const report = await it.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      sync: { now(input: unknown): Promise<{ ok: boolean; data: unknown }> }
    }
    const result = await bridge.sync.now({})
    return result.ok
      ? (result.data as { results: { connectionId: string; resourceKind: string; ok: boolean }[] })
      : null
  })

  expect(report).not.toBeNull()

  // The bug this pins: a connection with no credential used to be skipped in
  // silence, so the results array came back holding nothing that failed and the
  // whole refresh reported success — while the part of the board that needed
  // that credential could not be fetched at all.
  //
  // One entry now. The list held three: `jira-1`, `gh-1`, and `local` for the
  // fixture's checkout path, which existed on no machine. Neither of the other
  // two is synced any more, and the scenario no longer seeds them at all.
  const failed = (report?.results ?? []).filter((r) => !r.ok)
  expect(failed.map((r) => r.connectionId).sort()).toEqual(['jira-1'])

  // Paired with the presence: a report with no results at all would satisfy the
  // line above, and "nothing failed" was the original bug.
  expect(report?.results.length).toBeGreaterThan(0)
})

test('the lane keeps its data and its own reading', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  // The rows are still there with the provider unusable. XV in one assertion: a
  // lane degrades, it does not blank, because what it last fetched is still the
  // best answer available. All three rows, not merely one — a lane that
  // rendered its first row and dropped the rest would pass a presence check.
  await expect(tickets.getByText('MERC-1184')).toBeVisible()
  await expect(tickets.getByText('MERC-1190')).toBeVisible()
  await expect(tickets.getByText('MERC-1201')).toBeVisible()

  // And the lane reports its own state rather than a board-wide verdict.
  // "not authenticated" rather than "refused": nothing was refused, because no
  // credential was ever sent — and `ConnectionNotice` above says which of the
  // two it is, so the two sentences on screen agree with each other.
  await expect(tickets.getByText(/Tickets failed to refresh/)).toBeVisible()
  await expect(tickets.getByText(/the connection is not authenticated/)).toBeVisible()
  // It still says what it is showing, so the rows below are not mistaken for
  // an empty board.
  await expect(tickets.getByText(/showing/)).toBeVisible()
})

/**
 * The failure stops at the lane (T054 — XV).
 *
 * This is the assertion that replaced "one provider fails, another renders".
 * Everything below is derived from the *authored* store or computed from data
 * already in hand, and none of it has any business changing because a token was
 * revoked — but all of it sits on the same page, behind the same query layer,
 * and a board-wide error boundary or a single `if (failed) return null` would
 * take the lot.
 *
 * The session panel is the sharpest case: an agent reporting over the loopback
 * API is *still working* while Jira is unreachable, and a board that hid it
 * would be hiding the one thing still moving.
 */
test('nothing that does not come from the provider is affected', async () => {
  // Agent sessions. Authored data, arriving over a completely different path.
  const sessions = it.window.getByRole('region', { name: 'Agent sessions' })
  await expect(sessions.getByText('claude-code')).toBeVisible()
  await expect(sessions.getByText('Silent')).toBeVisible()

  // Ball in court still accounts for every item, from the rows the mirror
  // already holds. A panel that emptied itself here would be reporting "nothing
  // is waiting on you" — which is a claim, and a false one.
  const court = it.window.getByRole('region', { name: 'Ball in court' })
  await expect(court.getByText('waiting on you')).toBeVisible()
  await expect(court.getByText('waiting on someone else')).toBeVisible()

  // The tiles, which are counts over the same rows.
  await expect(it.window.getByRole('button', { name: /Your court/ })).toBeVisible()
  await expect(it.window.getByText('Stalled')).toBeVisible()
  await expect(it.window.getByText('Agents live')).toBeVisible()

  // And the note the scenario seeded, still readable — the authored store is
  // not behind the credential and must not act as though it were.
  await expect(
    it.window.getByRole('region', { name: 'Tickets' }).getByRole('button', {
      name: '2 notes on MERC-1201',
    }),
  ).toBeVisible()
})

test('the board is still fully interactive', async () => {
  // The part that matters and the part a screenshot cannot tell you. Everything
  // below is an ordinary interaction, and every one of them has to still work
  // while the only provider is unusable.

  // Filtering.
  const chip = it.window
    .getByRole('navigation', { name: 'Filter by project' })
    .getByRole('button', { name: 'MERC', exact: true })
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(it.window.getByRole('region', { name: 'Tickets' }).getByText('MERC-1184')).toBeVisible()
  await chip.click()

  // The court tile.
  const court = it.window.getByRole('button', { name: /Your court/ })
  await court.click()
  await expect(court).toHaveAttribute('aria-pressed', 'true')
  await court.click()

  // Notes — authored data, which has nothing to do with a provider and must
  // keep working when every provider is down. This is the case where an
  // operator most wants to write down what they just found out.
  await it.window
    .getByRole('region', { name: 'Tickets' })
    .getByRole('button', { name: 'Add a note to MERC-1184' })
    .click()

  const dialog = it.window.getByRole('dialog')
  await dialog.getByLabel('New note').fill('Token was revoked; asked for a new one.')
  await dialog.getByRole('button', { name: 'Add note' }).click()
  await expect(
    dialog.getByRole('list', { name: 'Notes on this item' }).getByText('Token was revoked'),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
})

test('the notice routes to where the credential is fixed', async () => {
  await it.window
    .getByRole('status', { name: 'Connections that cannot refresh' })
    .getByRole('button', { name: 'Manage connections' })
    .click()

  await expect(it.window.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await it.window.getByRole('button', { name: 'Back to the board' }).click()
  await expect(it.window.getByRole('region', { name: 'Tickets' })).toBeVisible()
})
