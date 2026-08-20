import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The board, over the canonical scenario.
 *
 * This is the same fixture `quickstart.md` names and the correlation engine is
 * tested against. Everything asserted below travelled the whole path — mirror,
 * correlation, freshness envelope, registry, IPC, React — so a regression
 * anywhere in it lands here.
 *
 * It was `merged-pr-open-ticket.json`, named for a ticket in review whose pull
 * request had already merged. That is a disagreement this application can no
 * longer see, so the fixture is named for its role and rebuilt around what it
 * still has to demonstrate: three tickets, an agent on one, notes on another,
 * and one in somebody else's court.
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
  'canonical-board.json',
)

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })
})

test.afterAll(async () => {
  await it.close()
})

/**
 * What 006 took off the board, asserted as absent.
 *
 * Every absence here is paired with a presence in the same query, because an
 * absence assertion passes trivially when the selector is wrong — and a suite
 * full of those is worse than no suite, since it reports confidence. If the
 * region lookup were broken, the ticket lane would come back missing too.
 */
test('the pull request lane, the branch lane and the Attention region are gone', async () => {
  await expect(it.window.getByRole('region', { name: 'Pull requests' })).toHaveCount(0)
  await expect(it.window.getByRole('region', { name: 'Open branches' })).toHaveCount(0)
  await expect(it.window.getByRole('region', { name: 'Attention' })).toHaveCount(0)

  // The same lookup, against the region that stayed. Without this the three
  // above would pass on a page that failed to render at all.
  await expect(it.window.getByRole('region', { name: 'Tickets' })).toHaveCount(1)
})

/**
 * The DRIFTING tile, likewise.
 *
 * It counted subjects where two systems disagreed, and with one provider there
 * is no second system to disagree with. A tile pinned at zero under the words
 * "the systems agree" is not a reassurance — it is a claim this application is
 * no longer entitled to make.
 */
test('the drifting tile is gone and the other three tiles are not', async () => {
  await expect(it.window.getByText('Drifting')).toHaveCount(0)

  await expect(it.window.getByRole('button', { name: /Your court/ })).toHaveCount(1)
  await expect(it.window.getByText('Stalled')).toBeVisible()
  await expect(it.window.getByText('Agents live')).toBeVisible()
})

test('the lane carries its own count and its own threshold', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  await expect(tickets.getByText('stale past 3d')).toBeVisible()
  await expect(tickets.getByText('MERC-1184')).toBeVisible()
})

test('the lane reports its own freshness, not the board-wide worst', async () => {
  // The bug this pins: the lanes all shared one aggregate reading, and because
  // `comparisons` had never synced, every lane on a perfectly healthy board
  // announced "never synced". A per-lane reading is what XV asks for and what
  // makes the sentence true. Still worth asserting with one lane on the board:
  // the envelope carries freshness for kinds nothing displays, and it is
  // reading *those* that produced the bug.
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  // **Either sentence, because this test was racing the scheduler and winning.**
  // It asserted `last refreshed` alone, which is the *stale* wording; the seeded
  // connection has no credential, so a few seconds after launch the first poll
  // fails and the lane switches to `failed to refresh <E> ...; showing 2h ago`.
  // It passed because the old fixture was stale by five days and the assertion
  // resolved before that first pass. Making the scenario's last success recent
  // enough to read as fresh <E> where the lane renders no status line at all <E>
  // was enough to lose the race, which is the kind of failure that arrives
  // months later looking like flake.
  //
  // Both wordings name a real event on *this* connection, which is the property.
  // The third wording is the bug, and it is the one that must never appear.
  await expect(tickets.getByText(/last refreshed|failed to refresh/)).toBeVisible()
  await expect(tickets.getByText(/never synced/)).toHaveCount(0)

  // Whichever it is, the age it reports is the ticket connection's own seeded
  // success rather than some other resource's. An aggregate reading is how the
  // original bug looked from here.
  await expect(tickets.getByText(/2 hours ago/)).toBeVisible()
})

/**
 * An absent correlation is still drawn, and it is down to one kind.
 *
 * There were four badges: branch, pull request, CI check, agent. Three of them
 * described a code host and a local checkout. What has to survive the narrowing
 * is the *placeholder* — a row with no agent renders a hairline mark holding
 * its column, not a gap — because that is what keeps the slots after it lined
 * up down the lane.
 */
test('an absent correlation is drawn, not omitted', async () => {
  const badges = async (issueKey: string) =>
    it.window.evaluate((key: string) => {
      const row = [...document.querySelectorAll('.row')].find((r) =>
        r.querySelector('.row__id')?.textContent?.includes(key),
      )
      return [...(row?.querySelectorAll('.badge') ?? [])].map((b) => ({
        kind: (b as HTMLElement).dataset['kind'],
        present: (b as HTMLElement).dataset['present'],
      }))
    }, issueKey)

  // An agent is working MERC-1190 and none is on MERC-1184. Both rows carry the
  // same one slot; only the mark inside it differs.
  const worked = await badges('MERC-1190')
  const idle = await badges('MERC-1184')

  expect(worked).toHaveLength(1)
  expect(idle).toHaveLength(1)
  expect(worked[0]?.kind).toBe('agent')
  expect(worked[0]?.present).toBe('true')
  expect(idle[0]?.present).toBe('false')
})

test('the ticket lane carries sprint, priority and story points, and names its columns', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })

  await expect(tickets.getByText('Sprint', { exact: true })).toBeVisible()
  await expect(tickets.getByText('Priority', { exact: true })).toBeVisible()
  await expect(tickets.getByText('Points', { exact: true })).toBeVisible()

  const row = await it.window.evaluate(() => {
    const el = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('.row__id')?.textContent?.includes('MERC-1184'),
    )
    return {
      sprint: el?.querySelector('.row__sprint')?.textContent ?? null,
      priority: el?.querySelector('.row__priority')?.textContent ?? null,
      points: el?.querySelector('.row__points')?.textContent ?? null,
    }
  })

  expect(row.sprint).toBe('Sprint 12')
  expect(row.priority).toBe('High')
  expect(row.points).toBe('5')
})

/**
 * A ticket in no sprint is drawn as absent, and not as a word this code chose.
 *
 * MERC-1190 is in no sprint. "Backlog" is the obvious thing to put here and is
 * an invention: Jira's backlog is a specific place a ticket can be in or out of,
 * and a ticket can be outside every sprint without being in it.
 */
test('a ticket in no sprint shows a placeholder rather than a name', async () => {
  const sprint = await it.window.evaluate(() => {
    const el = [...document.querySelectorAll('.row')].find((r) =>
      r.querySelector('.row__id')?.textContent?.includes('MERC-1190'),
    )
    return el?.querySelector('.row__sprint')?.textContent ?? null
  })

  expect(sprint?.trim()).toBe('–')
})

/**
 * There is no age column anywhere on the board.
 *
 * The ticket lane traded it for the sprint column and the other two lanes kept
 * it; 006 removed those two lanes, so the column had no caller left and went
 * with them. The fact is not lost — the staleness bar in the leftmost track is
 * derived from the same timestamp and carries the exact age in its `title`.
 */
test('no lane draws an age column, and the sprint column that replaced it is there', async () => {
  const counts = await it.window.evaluate(() => {
    const lane = (name: string): Element | null =>
      [...document.querySelectorAll('section.lane')].find(
        (l) => l.getAttribute('aria-label') === name,
      ) ?? null

    const inLane = (name: string, slot: string): number =>
      lane(name)?.querySelectorAll(slot).length ?? -1

    return {
      // `-1` would mean the lane itself was not found, which would make a zero
      // prove nothing at all.
      ticketAge: inLane('Tickets', '.row__age'),
      ticketSprint: inLane('Tickets', '.row__sprint'),
      anyAge: document.querySelectorAll('.row__age').length,
    }
  })

  expect(counts.ticketAge).toBe(0)
  expect(counts.ticketSprint).toBeGreaterThan(0)
  expect(counts.anyAge).toBe(0)
})

/**
 * The headings sort the lane (T157).
 *
 * Driven through the real control rather than by calling a comparator: the
 * question this answers is whether pressing the thing labelled "Ticket"
 * reorders the rows under it, which is exactly what a unit test of `applySort`
 * cannot see.
 *
 * Three presses, because the third is the one with something to prove — the
 * cycle ends at *unsorted*, and a lane that could only toggle between two
 * directions would have made core's own deterministic order unreachable.
 */
test('a column heading sorts its lane, and a third press gives the order back', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  const identifiers = async (): Promise<string[]> =>
    tickets.locator('.row .row__id').allTextContents()

  const original = await identifiers()
  expect(original.length).toBeGreaterThan(1)

  // The same comparison the lane uses: numeric, so `MERC-9` precedes
  // `MERC-10`. Sorting the expectation with plain `Array.sort` would agree by
  // accident on this scenario and disagree on any board with a nine in it.
  const byKey = [...original].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const heading = tickets.getByRole('button', { name: /^Sort by Ticket/ })

  await heading.click()
  await expect(heading).toHaveAttribute('aria-label', /ascending/)
  expect(await identifiers()).toEqual(byKey)

  await heading.click()
  await expect(heading).toHaveAttribute('aria-label', /descending/)
  expect(await identifiers()).toEqual([...byKey].reverse())

  await heading.click()
  await expect(heading).toHaveAttribute('aria-label', 'Sort by Ticket')
  expect(await identifiers()).toEqual(original)
})

/*
 * There was a test here called "each lane sorts on its own", and it is not
 * commented out or skipped — it is gone, with a note, because it needed two
 * lanes and there is one.
 *
 * The guarantee it checked is still real and still in the code: `useLaneSort`
 * gives every lane its own `useState`, so ordering one cannot reorder another.
 * It is simply unobservable on a board with a single sortable lane, and a test
 * that cannot fail is worse than an absent one because it reads as cover.
 *
 * This said "007 adds the handed-off lane, and its T111 carries restoring
 * this". **That lane was dropped on 2026-08-20 without being built**, so the
 * promise is void and there is no second sortable lane coming. The comment is
 * kept rather than deleted for its original reason -- a guarantee dropped
 * silently is a guarantee nobody remembers -- and the assertion now lives in
 * `test/renderer/lane-guarantees.test.ts`, against the source, which is weaker
 * than this was and is what is available. If a second lane ever arrives, restore
 * the real test here and delete that one.
 */

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
      '.row__sprint',
      '.row__priority',
      '.row__points',
      '.row__correlation',
    ].map((slot) => ({ slot, head: left(head, slot), row: left(row, slot) }))
  })

  // The heading row is drawn only over rows, so an empty result here means the
  // lane rendered nothing and the loop below would pass by checking nothing.
  expect(offsets).toHaveLength(7)

  for (const { slot, head, row } of offsets) {
    expect(head, `no heading cell for ${slot}`).not.toBeNull()
    expect(row, `no row cell for ${slot}`).not.toBeNull()
    expect(
      Math.abs((head ?? 0) - (row ?? 0)),
      `the ${slot} heading is not over its column`,
    ).toBeLessThanOrEqual(1)
  }
})

/*
 * "The pull request lane has no sprint, priority or points column" was here, and
 * goes for the same reason as the per-lane sort test above: it needed a lane
 * without the metric columns, and after 006 every lane on the board has them.
 *
 * The opt-in behaviour it guarded is intact -- `data-metrics` still drives both
 * the grid template and the headings from one flag. This said 007's handed-off
 * lane would be the next lane without them and that T111 would restore the
 * assertion; **that lane was dropped on 2026-08-20 without being built**. There
 * is no lane on the board that omits the metric columns, so this cannot be
 * observed end-to-end at all. `test/renderer/lane-guarantees.test.ts` asserts
 * the construction instead.
 */

test('the operator court tile filters the whole board', async () => {
  const tickets = it.window.getByRole('region', { name: 'Tickets' })
  const tile = it.window.getByRole('button', { name: /Your court/ })

  await expect(tile).toHaveAttribute('aria-pressed', 'false')
  await expect(tickets.getByText('MERC-1201')).toBeVisible()

  await tile.click()
  await expect(tile).toHaveAttribute('aria-pressed', 'true')

  // MERC-1201 is assigned to somebody else and no agent is on it, so the ball is
  // theirs and it goes. Both other rows stay.
  //
  // Every fixture item used to be in the operator's court, which left this
  // asserting only that the toggle announced its state — a filter that removes
  // nothing cannot be told from a filter that is not wired up. The rebuilt
  // scenario has a row in each court for exactly this reason.
  await expect(tickets.getByText('MERC-1201')).toHaveCount(0)
  await expect(tickets.getByText('MERC-1184')).toBeVisible()
  await expect(tickets.getByText('MERC-1190')).toBeVisible()

  await tile.click()
  await expect(tile).toHaveAttribute('aria-pressed', 'false')
  await expect(tickets.getByText('MERC-1201')).toBeVisible()
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
