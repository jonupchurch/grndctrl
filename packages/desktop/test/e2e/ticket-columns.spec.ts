import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The Logged and PR columns, and the Status heading's show/hide dropdown.
 *
 * Its own launch rather than more tests in `board.spec.ts`, because the status
 * filter writes a setting — and a hidden status left behind by a failing test
 * there would quietly shorten every lane assertion after it.
 *
 * `shell.openExternal` is replaced in main, as `golden-path.spec.ts` does it, so
 * the pull request link travels the real path — renderer, IPC, `links.resolve`
 * and its scheme check, main's https guard — and only the syscall is swapped.
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

async function openedUrls(): Promise<string[]> {
  return it.app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? [])
}

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  await it.app.evaluate(({ shell }) => {
    const store = globalThis as unknown as { __opened?: string[] }
    store.__opened = []
    shell.openExternal = async (url: string): Promise<void> => {
      store.__opened?.push(url)
    }
  })
})

test.afterAll(async () => {
  await it.close()
})

const cells = (issueKey: string) =>
  it.window.evaluate((key) => {
    const row = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('.row__id')?.textContent?.includes(key),
    )
    return {
      logged: row?.querySelector('.row__logged')?.textContent?.trim() ?? null,
      loggedTitle: row?.querySelector('.row__logged')?.getAttribute('title') ?? null,
      prs: [...(row?.querySelectorAll('.row__pr .row__pr-link') ?? [])].map((b) => b.textContent),
      prText: row?.querySelector('.row__pr')?.textContent?.trim() ?? null,
      prTitle: row?.querySelector('.row__pr')?.getAttribute('title') ?? null,
    }
  }, issueKey)

test('logged hours sit beside the points, and nothing logged is a placeholder', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  await expect(tickets.getByRole('button', { name: /^Sort by Logged/ })).toBeVisible()

  const logged = await cells('MERC-1184')
  expect(logged.logged).toBe('5.5h')
  expect(logged.loggedTitle).toBe('Logged: 5h 30m')

  expect((await cells('MERC-1190')).logged).toBe('–')

  // The heading order is the claim: Points, then Logged, then PR.
  const order = await it.window.evaluate(() =>
    [...document.querySelectorAll('.lane__headings > *')].map((c) => c.className.split(' ')[0]),
  )
  expect(order.indexOf('row__logged')).toBe(order.indexOf('row__points') + 1)
  expect(order.indexOf('row__pr')).toBe(order.indexOf('row__logged') + 1)
})

test('each linked pull request shows its number, and none and unknown are both placeholders', async () => {
  const merc1184 = await cells('MERC-1184')
  // Open first, then merged — the order the provider stores them in.
  expect(merc1184.prs).toEqual(['#482', '#17'])
  expect(merc1184.prTitle).toContain('#482 open · acme/mercury')

  const none = await cells('MERC-1190')
  expect(none.prText).toBe('–')
  expect(none.prTitle).toBe('No linked pull request')

  // MERC-1201's lookup failed. It must not read as "no pull request".
  const unknown = await cells('MERC-1201')
  expect(unknown.prText).toBe('–')
  expect(unknown.prTitle).toMatch(/unknown/i)
})

test('clicking a pull request number opens that pull request, not the ticket', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  await tickets.getByRole('button', { name: /^Open pull request #17/ }).click()
  await expect
    .poll(openedUrls)
    .toEqual(['https://github.example/acme/atlas/pull/17'])

  await tickets.getByRole('button', { name: /^Open pull request #482/ }).click()
  await expect
    .poll(openedUrls)
    .toEqual([
      'https://github.example/acme/atlas/pull/17',
      'https://github.example/acme/mercury/pull/482',
    ])
})

test('the new headings line up with their cells', async () => {
  const offsets = await it.window.evaluate(() => {
    const lane = document.querySelector('section.lane[data-metrics="true"]')
    const left = (row: Element | null, slot: string): number | null => {
      const cell = row?.querySelector(slot) ?? null
      return cell === null ? null : Math.round(cell.getBoundingClientRect().left)
    }
    const head = lane?.querySelector('.lane__headings') ?? null
    const row = lane?.querySelector('.row') ?? null
    return ['.row__status', '.row__points', '.row__logged', '.row__pr'].map((slot) => ({
      slot,
      head: left(head, slot),
      row: left(row, slot),
    }))
  })

  for (const { slot, head, row } of offsets) {
    expect(head, `no heading cell for ${slot}`).not.toBeNull()
    expect(row, `no row cell for ${slot}`).not.toBeNull()
    expect(Math.abs((head ?? 0) - (row ?? 0)), `the ${slot} heading is not over its column`).toBeLessThanOrEqual(1)
  }
})

test('the Status heading hides and shows statuses, and says what it is hiding', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  const ids = async (): Promise<string[]> => tickets.locator('.row .row__id').allTextContents()

  const before = await ids()
  expect(before).toContain('MERC-1184')

  const trigger = tickets.getByRole('button', { name: /^Filter statuses/ })
  await trigger.click()

  const menu = tickets.getByRole('group', { name: 'Show statuses' })
  await expect(menu).toBeVisible()

  // Visible is not enough: the first build rendered this menu clipped to the
  // Status cell by an inherited `overflow: hidden`, and `toBeVisible` passed.
  // What has to be true is that the menu's controls are the thing under the
  // pointer where they are drawn.
  const reachable = await it.window.evaluate(() => {
    const all = document.querySelector('.status-filter__all')
    if (all === null) return false
    const box = all.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === all
  })
  expect(reachable, 'the menu is clipped or covered').toBe(true)

  // MERC-1184 is In Review.
  await menu.getByRole('checkbox', { name: /In Review/ }).uncheck()

  await expect.poll(ids).not.toContain('MERC-1184')
  expect((await ids()).length).toBeLessThan(before.length)
  await expect(trigger).toHaveAttribute('aria-label', /1 hidden/)
  await expect(tickets.getByText(/hidden by status/)).toBeVisible()

  // Survives the menu closing, and a status that is hidden stays in the list.
  await it.window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await trigger.click()
  await expect(menu.getByRole('checkbox', { name: /In Review/ })).not.toBeChecked()

  await menu.getByRole('button', { name: 'Show all' }).click()
  await expect.poll(ids).toEqual(before)
  await expect(trigger).toHaveAttribute('aria-label', 'Filter statuses')

  // Closed on the way out, so the next test's first press opens it.
  await it.window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('hiding every status keeps the headings, so the filter can be undone', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  const trigger = tickets.getByRole('button', { name: /^Filter statuses/ })
  await trigger.click()

  const menu = tickets.getByRole('group', { name: 'Show statuses' })
  await expect(menu).toBeVisible()
  const boxes = await menu.getByRole('checkbox').all()
  // An empty list would make the loop below prove nothing.
  expect(boxes.length).toBeGreaterThan(1)
  for (const box of boxes) await box.uncheck()

  await expect(tickets.locator('.row')).toHaveCount(0)
  await expect(tickets.getByText(/hidden by the status filter/)).toBeVisible()
  // Not the empty state: that would say there are no tickets.
  await expect(tickets.getByText('No tickets', { exact: true })).toHaveCount(0)

  await menu.getByRole('button', { name: 'Show all' }).click()
  await expect(tickets.locator('.row').first()).toBeVisible()
  await it.window.keyboard.press('Escape')
})

test('the hidden statuses are saved', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  await tickets.getByRole('button', { name: /^Filter statuses/ }).click()
  await expect(tickets.getByRole('group', { name: 'Show statuses' })).toBeVisible()
  await tickets.getByRole('group', { name: 'Show statuses' }).getByRole('checkbox', { name: /In Review/ }).uncheck()

  await expect
    .poll(() =>
      it.window.evaluate(async () => {
        const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
          settings: { get(input: unknown): Promise<{ ok: boolean; data: unknown }> }
        }
        const result = await bridge.settings.get({})
        return result.ok ? (result.data as { hiddenStatuses: string[] }).hiddenStatuses : null
      }),
    )
    .toEqual(['In Review'])

  await tickets.getByRole('group', { name: 'Show statuses' }).getByRole('button', { name: 'Show all' }).click()
})
