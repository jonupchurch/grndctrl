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

  // Naming which one. "A connection is broken" sends the operator to check all
  // of them, which is the work the application is supposed to have done. The
  // GitHub connection that used to be named beside it is not seeded any more —
  // the mirror's CHECK refuses the row.
  await expect(notice.getByText(/Jira · example.atlassian.net/)).toBeVisible()

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
  // fixture's checkout path, which exists on no machine. The two that left are
  // not synced any more, and `gh-1` is skipped rather than reported precisely
  // because it is a row about to be deleted rather than a connection the
  // operator has to fix.
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
  // best answer available.
  //
  // This test demonstrated the property across *three* lanes and now has one to
  // demonstrate it on, which is weaker — the interesting version was one
  // provider failing while another rendered. T054 rewrites this file at M5 to
  // demonstrate the ticket lane failing while the session lane, the panels and
  // this notice still render, which is the shape the guarantee takes with a
  // single provider. Until then it is narrowed rather than dropped.
  await expect(tickets.getByText('MERC-1184')).toBeVisible()

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
