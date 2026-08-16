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
 * The seeded connections carry a `credentialRef` pointing at a keychain entry
 * that does not exist, which is precisely the state a revoked or deleted token
 * leaves behind. So this is a real revocation rather than a simulated one, and
 * it costs no network: the connection ids are `jira-1` and `gh-1`, which are
 * not the operator's own (`jira`, `github`), so nothing here can reach a real
 * provider with a real credential even by accident.
 */

const SCENARIO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'scenarios',
  'merged-pr-open-ticket.json',
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

  // Naming which ones. "A connection is broken" sends the operator to check all
  // of them, which is the work the application is supposed to have done.
  await expect(notice.getByText(/Jira · example.atlassian.net/)).toBeVisible()
  await expect(notice.getByText(/GitHub · github.com/)).toBeVisible()

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

  // The bug this pins: both remote providers used to be skipped in silence, so
  // the results array held one entry — `local`, **ok** — and the whole refresh
  // reported success while every part of the board that needed a credential
  // could not be fetched at all.
  //
  // `local` is in this list too, and it belongs there: the fixture's checkout
  // path does not exist on any machine, and a checkout that cannot be read used
  // to answer "no branches" rather than "could not look".
  const failed = (report?.results ?? []).filter((r) => !r.ok)
  expect(failed.map((r) => r.connectionId).sort()).toEqual(['gh-1', 'jira-1', 'local'])
})

test('every lane keeps its data and its own reading', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  const pulls = it.window.getByRole('region', { name: 'Pull requests' })

  const branches = it.window.getByRole('region', { name: 'Open branches' })

  // The rows are still there — all three lanes, with all three providers
  // unusable. XV in one assertion: a lane degrades, it does not blank, because
  // what it last fetched is still the best answer available.
  await expect(tickets.getByText('MERC-1184')).toBeVisible()
  await expect(pulls.getByText('#451')).toBeVisible()
  // The branch lane is the one that regressed: an unreadable checkout wrote an
  // empty set over the cached workspaces, so this lane emptied itself while
  // reporting a failure nobody reads as "your branches are still there".
  await expect(branches.getByText('feature/MERC-1190')).toBeVisible()

  // And each lane reports its own state rather than a board-wide verdict.
  // "not authenticated" rather than "refused": nothing was refused, because no
  // credential was ever sent — and `ConnectionNotice` above says which of the
  // two it is, so the two sentences on screen agree with each other.
  await expect(tickets.getByText(/Tickets failed to refresh/)).toBeVisible()
  await expect(tickets.getByText(/the connection is not authenticated/)).toBeVisible()
  // It still says what it is showing, so the rows below are not mistaken for
  // an empty board.
  await expect(tickets.getByText(/showing/)).toBeVisible()
})

test('the board is still fully interactive', async () => {
  // The part that matters and the part a screenshot cannot tell you. Everything
  // below is an ordinary interaction, and every one of them has to still work
  // while two of the three providers are unusable.

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

  // Attention still reasons over the cached data: drift is a disagreement
  // between two records, and both records are still on hand.
  await expect(
    it.window.getByRole('region', { name: 'Attention' }).getByText(/MERC-1184 is In Review/),
  ).toBeVisible()
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
