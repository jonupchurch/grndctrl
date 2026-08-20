import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The golden path (T155), in one session, in order.
 *
 * Configure → render → open a ticket → write a note and watch the badge follow
 * it → edit it, and lose a revision race on purpose. Every other e2e in this
 * directory asserts one property in isolation; this one asserts that the
 * properties compose, which is the thing that actually breaks. Each of the eight
 * defects found the day this application first met live providers had a passing
 * test beside it, and every one of them was a seam.
 *
 * Written as a single ordered file rather than independent tests because the
 * later steps genuinely depend on the earlier ones — the note badge reads `1`
 * because step three wrote a note, not because a fixture said so. Playwright
 * runs the tests in a file in order against one `beforeAll`, which is exactly
 * that shape.
 *
 * **The path used to be nine steps and is now six**, and what left is worth
 * naming rather than quietly renumbering. Two steps opened a pull request row
 * and a branch row; three drove a drift finding through the confirmation dialog
 * into the outbox and then restarted the application to prove the queued action
 * had never been in memory.
 *
 * The outbox itself is **not** gone — its eight operations, its durable table
 * and its claim protocol are all still here, and `outbox-durability.test.ts` in
 * core still proves an action survives a restart. What is gone is the only route
 * *from the interface* to it, because that route began at a drift finding. So
 * this file no longer ends at the outbox: nothing on the board can put anything
 * in it, and a golden path that queued an action by calling the bridge directly
 * would be asserting the seam it exists to test does not matter.
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

/**
 * Every launcher click, captured instead of performed.
 *
 * Without this the suite opens real browser tabs — three of them per run, at
 * acme.atlassian.net and github.com, on whatever machine is running CI. The
 * patch is applied in the **main** process at the last possible step, so
 * everything the assertion cares about still runs for real: the renderer's
 * subject key, the IPC hop, `links.resolve` in core with its scheme check, and
 * main's own https guard. Only the final syscall is replaced.
 */
async function openedUrls(): Promise<string[]> {
  return it.app.evaluate(() => {
    const store = globalThis as unknown as { __opened?: string[] }
    return store.__opened ?? []
  })
}

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  await it.app.evaluate(({ shell }) => {
    const store = globalThis as unknown as { __opened?: string[] }
    store.__opened = []
    // Reassigning the property rather than wrapping the module: `linkOpener` is
    // constructed with `(url) => shell.openExternal(url)`, so it reads the
    // property at call time and this is seen.
    shell.openExternal = async (url: string): Promise<void> => {
      store.__opened?.push(url)
    }
  })
})

test.afterAll(async () => {
  await it.close()
})

test('1 · the board is configured, and settings agrees with what it is showing', async () => {
  // The seeded project is bound to a Jira project. Both screens read the same
  // `projects.list`; a board that renders MERC rows while settings shows nothing
  // configured would mean two sources for one fact.
  await expect(it.window.getByRole('heading', { name: 'Ground Control' })).toBeVisible()
  await expect(
    it.window.getByRole('navigation', { name: 'Filter by project' }).getByRole('button', {
      name: 'MERC',
      exact: true,
    }),
  ).toBeVisible()

  await it.window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(it.window.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // The same project, described by the screen that owns it. The repository line
  // that used to follow — `MERC · acme/mercury` — went with the field.
  const projects = it.window.getByRole('region', { name: 'Projects' })
  await expect(projects.getByText('MERC · Mercury')).toBeVisible()
  await expect(projects.getByText('acme/mercury')).toHaveCount(0)

  await it.window.getByRole('button', { name: 'Back to the board' }).click()
  await expect(it.window.getByRole('region', { name: 'Tickets' })).toBeVisible()
})

test('2 · a ticket row opens the ticket, not the repository', async () => {
  await it.window
    .getByRole('region', { name: 'Tickets' })
    .getByRole('button', { name: /^Open MERC-1184/ })
    .click()

  await expect
    .poll(openedUrls)
    .toEqual(['https://acme.atlassian.net/browse/MERC-1184'])
})

/**
 * Every row on the board opens a ticket, because every row *is* one.
 *
 * There were three row kinds and three steps here, and the interesting one was
 * the branch: a branch the code host had never seen has no branch page, so
 * `links.resolve` answered with the repository instead of opening a 404. That
 * fallback, and the two link targets above it, are removed in M2.
 *
 * The remaining assertion is that the accumulating list has exactly one entry --
 * which also proves the click above fired once rather than twice, the thing the
 * second step used to prove.
 */
test('3 · nothing else on the board opens anything', async () => {
  expect(await openedUrls()).toEqual(['https://acme.atlassian.net/browse/MERC-1184'])
})

test('4 · a note written from the board is on the row when the dialog closes', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  // Nothing has been written to this subject, so the control is the quiet `+`
  // — present and reachable, which is the whole point of it being drawn at all.
  // A badge that only appeared once a note existed made the first note on any
  // subject unwritable from the board.
  await tickets.getByRole('button', { name: 'Add a note to MERC-1184' }).click()

  const dialog = it.window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Notes' })).toBeVisible()
  await expect(dialog.getByText('No notes yet.')).toBeVisible()

  await dialog.getByLabel('Type').selectOption('gotcha')
  await dialog
    .getByLabel('New note')
    .fill('The upstream branch is deleted on merge; reconcile reads a missing ref.')
  await dialog.getByRole('button', { name: 'Add note' }).click()

  // Scoped to the list: the type picker beside it offers the same four words,
  // and an unscoped match would pass on the `<option>` without a note existing.
  const written = dialog.getByRole('list', { name: 'Notes on this item' })
  await expect(written.getByText('Gotcha')).toBeVisible()
  // Attributed to the operator. `authorKind` comes from the transport the write
  // arrived on rather than from the payload, so a note written here can only
  // ever say "you" — an agent cannot sign one as the user.
  await expect(written.getByText('you')).toBeVisible()

  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(it.window.getByRole('dialog')).toHaveCount(0)

  // The count on the row came from `notes.counts`, a different query from the
  // one the dialog read. Both had to be invalidated; a badge still reading `+`
  // here is the modal refreshing only itself.
  await expect(tickets.getByRole('button', { name: '1 note on MERC-1184' })).toBeVisible()
})

/**
 * The note that step 4 wrote must not have moved MERC-1184's columns.
 *
 * This is the reason the row's last two grid tracks are pinned rather than
 * `auto`. A badge reading `1` is wider than the `+` on MERC-1190 below it, and
 * while the track sized itself to its content that difference came out of the
 * flexible title column — pushing status, sprint and court left on the row with
 * notes and not on the row without.
 *
 * It has to live here rather than in `board.spec.ts` because it needs a board
 * where one row has notes and another does not, and the scenario seeds notes on
 * neither of these two — the two it does seed are on MERC-1201, deliberately a
 * third row, so that step 4 above is what creates the difference being measured.
 * Asserted after the note exists, which is what makes it a real comparison
 * rather than two identical rows agreeing.
 */
test('4b · the row that gained a note still lines up with the one that did not', async () => {
  const columns = await it.window.evaluate(() => {
    const of = (id: string): Record<string, number> => {
      const row = [...document.querySelectorAll('.row')].find((r) =>
        r.querySelector('.row__id')?.textContent?.includes(id),
      )

      const out: Record<string, number> = {}
      // `.row__court` was here until 2026-08-20, when the column was removed to
      // give the summary back its width. Replaced by the two tracks that now sit
      // furthest right, where a misalignment would show first and worst.
      for (const slot of [
        '.row__status',
        '.row__sprint',
        '.row__priority',
        '.row__points',
        '.row__correlation',
      ]) {
        const cell = row?.querySelector(slot) ?? null
        if (cell !== null) out[slot] = Math.round(cell.getBoundingClientRect().left)
      }
      return out
    }

    return { withNote: of('MERC-1184'), without: of('MERC-1190') }
  })

  // Both rows have to have been found, or the loop compares nothing and passes.
  expect(Object.keys(columns.withNote)).toHaveLength(5)
  expect(Object.keys(columns.without)).toHaveLength(5)

  for (const slot of Object.keys(columns.withNote)) {
    expect(
      Math.abs((columns.withNote[slot] ?? 0) - (columns.without[slot] ?? 0)),
      `${slot} moved between a row with notes and a row without`,
    ).toBeLessThanOrEqual(1)
  }
})

test('5 · editing that note against a current revision succeeds', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  await tickets.getByRole('button', { name: '1 note on MERC-1184' }).click()

  const dialog = it.window.getByRole('dialog')
  const written = dialog.getByRole('list', { name: 'Notes on this item' })

  await dialog.getByRole('button', { name: 'Edit' }).click()
  await dialog.getByLabel('Editing').fill('Reconcile reads a missing ref once upstream is deleted.')
  await dialog.getByRole('button', { name: 'Save changes' }).click()

  await expect(written.getByText('Reconcile reads a missing ref once upstream is deleted.')).toBeVisible()
  // Still one note. An edit that lost its revision race would have been
  // rejected outright, and one that ignored the revision would have made two.
  await expect(written.getByRole('listitem')).toHaveCount(1)

  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
})

test('5b · an edit that lost the revision race shows what it lost to', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  await tickets.getByRole('button', { name: '1 note on MERC-1184' }).click()

  const dialog = it.window.getByRole('dialog')

  // Start editing. The revision the modal will send is the one it read when the
  // list loaded — captured now, before anyone else writes.
  await dialog.getByRole('button', { name: 'Edit' }).click()

  // A second writer, straight over the bridge — which is what an agent working
  // this ticket over MCP is, as far as the store is concerned. It bypasses
  // react-query entirely, so the modal keeps holding the revision it read.
  const wrote = await it.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      notes: {
        list(input: unknown): Promise<{ ok: boolean; data: unknown }>
        update(input: unknown): Promise<{ ok: boolean; data: unknown }>
      }
    }
    const listed = await bridge.notes.list({ subjectKey: 'jira:acme.atlassian.net/MERC-1184' })
    if (!listed.ok) return false
    const note = (listed.data as { id: string; revision: number }[])[0]
    if (note === undefined) return false

    const updated = await bridge.notes.update({
      id: note.id,
      revision: note.revision,
      body: 'Upstream deletes the branch on merge — handled in reconcile as of today.',
    })
    return updated.ok
  })
  expect(wrote).toBe(true)

  await dialog.getByLabel('Editing').fill('My own version, typed while that happened.')
  await dialog.getByRole('button', { name: 'Save changes' }).click()

  // Rejected, and the rejection carries the row that won. This is the whole
  // reason `details` is on the error: without it the operator is told only that
  // something changed and has to reload — which discards the draft, to find out
  // what it lost to.
  const alert = dialog.getByRole('alert')
  await expect(alert.getByText('Someone else saved this first.')).toBeVisible()
  // Scoped to the alert: the list behind it now shows the same text, because a
  // conflict refetches — the operator is choosing between two versions and
  // needs the current one on screen. Matching either would pass without the
  // error ever having carried `details` across the preload, which is the thing
  // under test.
  await expect(
    alert.getByText('Upstream deletes the branch on merge — handled in reconcile as of today.'),
  ).toBeVisible()

  // And the draft is still in the box, which is the point of showing both.
  await expect(dialog.getByLabel('Editing')).toHaveValue('My own version, typed while that happened.')

  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
})

/*
 * Steps 7, 8 and 9 were here.
 *
 * 7 opened a drift finding's action and checked the dialog said, in words, that
 * this application holds read-only credentials and will not make the change
 * itself. 8 confirmed it and checked the action was recorded as *pending*, with
 * the operator named in its history as the actor -- constitution XVI made
 * visible rather than only enforced. 9 restarted the application and found the
 * action still queued.
 *
 * All three began at a drift finding, and 006 removes drift. They are not
 * replaced, because there is nothing on the board to replace them with: no
 * surface in the interface can now create an outbox action.
 *
 * **The properties they held are not all covered elsewhere, and that is worth
 * being plain about.** `outbox-durability.test.ts` and `no-auto-dispatch.test.ts`
 * in core still hold the durability guarantee and the never-writes guarantee at
 * the service level. What no test holds any more is the *dialog* -- that a human
 * is shown what confirming means before they confirm it. That component is
 * deleted, so there is nothing to test; but if a confirmation flow is ever built
 * again, this is the assertion it needs and this comment is where to find it.
 */
