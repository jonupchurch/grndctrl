import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The board, over the canonical drift scenario.
 *
 * This is the same fixture `quickstart.md` names and the correlation engine is
 * tested against: MERC-1184 sits In Review while its pull request merged three
 * days ago. Everything asserted below travelled the whole path — mirror,
 * correlation, drift rules, freshness envelope, registry, IPC, React — so a
 * regression anywhere in it lands here.
 *
 * It is deliberately about *what the operator can see*, not about component
 * internals. A test that asserted a class name would pass through a redesign
 * that broke the board.
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

test('the drift finding names both sides and when each was true', async () => {
  const attention = it.window.getByRole('region', { name: 'Attention' })

  await expect(attention.getByText('MERC-1184 is In Review, but PR #451 merged')).toBeVisible()

  // Both halves of the evidence. A strip saying only "MERC-1184 is drifting"
  // would send the operator to check the same two systems the application
  // already checked.
  await expect(attention.getByText('status is In Review')).toBeVisible()
  await expect(attention.getByText(/pull request/)).toBeVisible()
})

test('every lane carries its own count and its own threshold', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  const pulls = it.window.getByRole('region', { name: 'Pull requests' })
  const branches = it.window.getByRole('region', { name: 'Open branches' })

  // The thresholds differ because the lanes measure different things: a ticket
  // untouched for three days is normal, a pull request untouched for a day is
  // someone waiting.
  await expect(tickets.getByText('stale past 3d')).toBeVisible()
  await expect(pulls.getByText('stale past 24h')).toBeVisible()
  await expect(branches).toBeVisible()

  await expect(tickets.getByText('MERC-1184')).toBeVisible()
  await expect(pulls.getByText('#451')).toBeVisible()
})

test('each lane reports its own freshness, not the board-wide worst', async () => {
  // The bug this pins: the lanes all shared one aggregate reading, and because
  // `comparisons` had never synced, every lane on a perfectly healthy board
  // announced "never synced". A per-lane reading is what XV asks for and what
  // makes the sentence true.
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  await expect(tickets.getByText(/last refreshed/)).toBeVisible()
  await expect(tickets.getByText(/never synced/)).toHaveCount(0)
})

test('an absent correlation is drawn, not omitted', async () => {
  const badges = await it.window.evaluate(() => {
    const row = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('.row__id')?.textContent?.includes('MERC-1184'),
    )
    return [...(row?.querySelectorAll('.badge') ?? [])].map((b) => ({
      kind: (b as HTMLElement).dataset['kind'],
      present: (b as HTMLElement).dataset['present'],
    }))
  })

  // MERC-1184 has a pull request and nothing else. All four slots are still
  // rendered, so the columns line up down the lane and "nothing started" reads
  // as a state rather than as a shorter row.
  expect(badges).toHaveLength(4)
  expect(badges.find((b) => b.kind === 'pull-request')?.present).toBe('true')
  expect(badges.find((b) => b.kind === 'branch')?.present).toBe('false')
})

test('the ticket lane carries priority and story points, and names its columns', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  await expect(tickets.getByText('Priority', { exact: true })).toBeVisible()
  await expect(tickets.getByText('Points', { exact: true })).toBeVisible()

  const row = await it.window.evaluate(() => {
    const el = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('.row__id')?.textContent?.includes('MERC-1184'),
    )
    return {
      priority: el?.querySelector('.row__priority')?.textContent ?? null,
      points: el?.querySelector('.row__points')?.textContent ?? null,
    }
  })

  expect(row.priority).toBe('High')
  expect(row.points).toBe('5')
})

/**
 * Unknown is drawn as absent, never as a number.
 *
 * MERC-1190 is estimated by nobody. `0` would be a claim about the ticket that
 * the tracker never made, and it is one coercion away at every layer between
 * Jira and this cell — `Number(null)`, `?? 0` and `|| 0` all produce it and all
 * typecheck.
 */
test('an unestimated ticket shows a placeholder rather than zero points', async () => {
  const points = await it.window.evaluate(() => {
    const el = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('.row__id')?.textContent?.includes('MERC-1190'),
    )
    return el?.querySelector('.row__points')?.textContent ?? null
  })

  expect(points).not.toBe('0')
  expect(points?.trim()).toBe('–')
})

/**
 * The headings sit over the columns they name.
 *
 * Each row is its own CSS grid sharing one template, so alignment is a property
 * of the *tracks* rather than of the markup — and two of them used to be
 * `auto`. That sizes a track to its content, which here is not constant: a note
 * badge reading `12` is wider than one reading `+`, and the heading row has
 * neither. Every column after the flexible title track then sat several pixels
 * off.
 *
 * Asserted in pixels because there is no other way to see it. Nothing about the
 * markup changes when this breaks; the board simply stops lining up, which is
 * the one property the row primitive exists to provide.
 */
test('the column headings line up with the cells beneath them', async () => {
  const offsets = await it.window.evaluate(() => {
    const lane = document.querySelector('section.lane[data-metrics="true"]')
    const left = (row: Element | null, slot: string): number | null => {
      const cell = row?.querySelector(slot) ?? null
      return cell === null ? null : Math.round(cell.getBoundingClientRect().left)
    }

    const head = lane?.querySelector('.lane__headings') ?? null
    const row = lane?.querySelector('.row') ?? null

    return [
      '.row__id',
      '.row__title',
      '.row__status',
      '.row__priority',
      '.row__points',
      '.row__correlation',
      '.row__court',
      '.row__age',
    ].map((slot) => ({ slot, head: left(head, slot), row: left(row, slot) }))
  })

  // The heading row is drawn only over rows, so an empty result here means the
  // lane rendered nothing and the loop below would pass by checking nothing.
  expect(offsets).toHaveLength(8)

  for (const { slot, head, row } of offsets) {
    expect(head, `no heading cell for ${slot}`).not.toBeNull()
    expect(row, `no row cell for ${slot}`).not.toBeNull()
    expect(
      Math.abs((head ?? 0) - (row ?? 0)),
      `the ${slot} heading is not over its column`,
    ).toBeLessThanOrEqual(1)
  }
})

/**
 * The two lanes that are not tickets do not carry the two ticket columns.
 *
 * A pull request has no priority and a branch is not estimated, so a column
 * there could only ever be empty — and a permanently empty column is noise
 * rather than the meaningful absence the row's other placeholders carry.
 */
test('the pull request lane has no priority or points column', async () => {
  const pulls = it.window.getByRole('region', { name: 'Pull requests' })

  await expect(pulls.getByText('Priority', { exact: true })).toHaveCount(0)
  await expect(pulls.locator('.row__points')).toHaveCount(0)
})

test('the operator court tile filters the whole board', async () => {
  const tile = it.window.getByRole('button', { name: /Your court/ })

  await expect(tile).toHaveAttribute('aria-pressed', 'false')
  await tile.click()
  await expect(tile).toHaveAttribute('aria-pressed', 'true')

  // Both fixture items are in the operator's court, so nothing disappears —
  // what is being asserted is that the toggle is a *control* with announced
  // state, not a coloured background.
  await expect(it.window.getByRole('region', { name: 'Tickets' }).getByText('MERC-1184')).toBeVisible()
  await tile.click()
  await expect(tile).toHaveAttribute('aria-pressed', 'false')
})

test('selecting a project narrows the page rather than navigating', async () => {
  const before = it.window.url()
  // Scoped to the filter nav: when the board narrows to one project the header
  // also grows a link button carrying the same Jira key, and an unscoped query
  // matches both.
  const chip = it.window
    .getByRole('navigation', { name: 'Filter by project' })
    .getByRole('button', { name: 'MERC', exact: true })

  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')

  // Still one page. No navigation, no history entry, nothing to come back from.
  expect(it.window.url()).toBe(before)
  await expect(it.window.getByRole('region', { name: 'Tickets' }).getByText('MERC-1184')).toBeVisible()

  // Pressing the same chip again widens back out — the filter is a toggle, and
  // "All" is a chip like the others rather than a special mode.
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'false')
})

test('a silent agent session says so, and is not counted as live', async () => {
  const sessions = it.window.getByRole('region', { name: 'Agent sessions' })

  await expect(sessions.getByText('claude-code')).toBeVisible()
  // The heartbeat stopped. Derived from a missed beat rather than from anything
  // the agent said, because an agent that has crashed cannot report it.
  await expect(sessions.getByText('Silent')).toBeVisible()
  await expect(sessions.getByText('0 of 1')).toBeVisible()
})

test('the ball-in-court panel accounts for every item', async () => {
  const court = it.window.getByRole('region', { name: 'Ball in court' })

  await expect(court.getByText('waiting on you')).toBeVisible()
  await expect(court.getByText('waiting on someone else')).toBeVisible()
  await expect(court.getByText('an agent is on it')).toBeVisible()
})
