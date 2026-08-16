import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The golden path (T155), in one session, in order.
 *
 * Configure → render → open each row type → write a note and watch the badge
 * follow it → confirm a dispatch and watch it land in the outbox. Every other
 * e2e in this directory asserts one property in isolation; this one asserts
 * that the properties compose, which is the thing that actually breaks. Each of
 * the eight defects found the day this application first met live providers had
 * a passing test beside it, and every one of them was a seam.
 *
 * Written as a single ordered file rather than independent tests because the
 * later steps genuinely depend on the earlier ones — the note badge reads `1`
 * because step five wrote a note, not because a fixture said so. Playwright
 * runs the tests in a file in order against one `beforeAll`, which is exactly
 * that shape.
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
  // The seeded project is bound to a Jira project and a repository. Both screens
  // read the same `projects.list`; a board that renders MERC rows while settings
  // shows nothing configured would mean two sources for one fact.
  await expect(it.window.getByRole('heading', { name: 'Ground Control' })).toBeVisible()
  await expect(
    it.window.getByRole('navigation', { name: 'Filter by project' }).getByRole('button', {
      name: 'MERC',
      exact: true,
    }),
  ).toBeVisible()

  await it.window.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(it.window.getByRole('heading', { name: 'Settings' })).toBeVisible()

  // The same project, described by the screen that owns it: the ticket project
  // and the repository the board is joining together.
  const projects = it.window.getByRole('region', { name: 'Projects' })
  await expect(projects.getByText('MERC · Mercury')).toBeVisible()
  await expect(projects.getByText('MERC · acme/mercury')).toBeVisible()

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

test('3 · a pull request row opens that pull request', async () => {
  await it.window
    .getByRole('region', { name: 'Pull requests' })
    .getByRole('button', { name: /^Open #451/ })
    .click()

  // The second entry, not a replacement: the list accumulates, so this also
  // shows the ticket click above did not fire twice.
  await expect
    .poll(openedUrls)
    .toEqual([
      'https://acme.atlassian.net/browse/MERC-1184',
      'https://github.com/acme/mercury/pull/451',
    ])
})

test('4 · a branch row opens the branch, and falls back rather than failing', async () => {
  await it.window
    .getByRole('region', { name: 'Open branches' })
    .getByRole('button', { name: /^Open feature\/MERC-1190/ })
    .click()

  const urls = await openedUrls()
  expect(urls).toHaveLength(3)
  // FR-076: a branch the host has never seen has no branch page, so
  // `links.resolve` answers with the repository. Either is correct; opening
  // nothing, or opening a 404, is not.
  expect(urls[2]).toMatch(/^https:\/\/github\.com\/acme\/mercury(\/tree\/feature\/MERC-1190)?$/)
})

test('5 · a note written from the board is on the row when the dialog closes', async () => {
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

test('6 · editing that note against a current revision succeeds', async () => {
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

test('6b · an edit that lost the revision race shows what it lost to', async () => {
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

test('7 · the drift finding offers its action, and says what confirming means', async () => {
  const attention = it.window.getByRole('region', { name: 'Attention' })
  await expect(attention.getByText('MERC-1184 is In Review, but PR #451 merged')).toBeVisible()

  await attention.getByRole('button', { name: 'Move to Done' }).click()

  const dialog = it.window.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Confirm this action' })).toBeVisible()

  // XVI, stated to the operator rather than only enforced in the wiring. This
  // application holds read-only credentials and will not transition the ticket
  // itself; confirming records a request for an agent to carry out.
  await expect(dialog.getByText(/read-only credentials and never writes/)).toBeVisible()

  // FR-066. The seeded session has missed its heartbeat, so it is silent — and
  // a silent agent is exactly the case where "queued" must not read as "sent",
  // because a crashed agent cannot report its own crash.
  await expect(dialog.getByText('No agent is connected.')).toBeVisible()

  // Both sides of the evidence travel into the dialog. The operator is being
  // asked to authorise a change to a ticket; the two facts that disagree are
  // what the decision rests on, and the summary sentence alone is not them.
  const evidence = dialog.getByRole('list', { name: 'Evidence' })
  await expect(evidence.getByText('status is In Review')).toBeVisible()
  await expect(evidence.getByText('merged')).toBeVisible()
})

test('8 · confirming queues the action, and it is pending rather than sent', async () => {
  const dialog = it.window.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Move to Done' }).click()

  await expect(dialog.getByRole('heading', { name: 'Queued' })).toBeVisible()
  await expect(dialog.getByText('Waiting to be claimed')).toBeVisible()

  // The history's first entry is written by `enqueue` and names the operator as
  // the actor. This is the record that the action was confirmed rather than
  // raised automatically — the property XVI exists for.
  await expect(dialog.getByText(/confirmed by the operator/)).toBeVisible()

  // Still true after queueing, and still said plainly.
  await expect(dialog.getByText('No agent is connected.')).toBeVisible()

  // Nothing was opened by any of this. A confirmation flow that reached a
  // provider would be the exact failure XVI forbids, and it would be invisible
  // in every other assertion here.
  expect(await openedUrls()).toHaveLength(3)
})

test('9 · the queued action survives a restart, because it was never in memory', async () => {
  // FR-064 is the reason the outbox is a table rather than an event. An action
  // raised while nothing is listening has to still be there when something
  // finally is — which is most of the time, on a single-operator machine.
  const dir = it.dir
  await it.app.close()

  it = await launch({ env: { GRNDCTRL_DATA_DIR: dir } })
  it.dir = dir

  const pending = await it.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      outbox: { pending(input: unknown): Promise<{ ok: boolean; data: unknown }> }
    }
    const result = await bridge.outbox.pending({})
    return result.ok ? (result.data as { kind: string; state: string }[]) : null
  })

  expect(pending).not.toBeNull()
  expect(pending).toHaveLength(1)
  expect(pending?.[0]?.kind).toBe('transition-ticket')
  expect(pending?.[0]?.state).toBe('pending')
})
