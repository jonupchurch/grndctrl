import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * The active ticket (T120 — FR-127, FR-128, FR-131, US1 scenarios 1, 3 and 6).
 *
 * Driven **from outside the window**, over the loopback API, because that is the
 * caller this panel was built for: the operator's brief was "populated by MCP".
 * A spec that set the pointer by clicking would test the half that was never in
 * doubt and would pass with the push event unwired — which is precisely the
 * failure `agent-push.spec.ts` exists because of.
 *
 * The case worth the most here is the **last** one: an active ticket the mirror
 * does not hold. It is not a corner. An agent may set focus before the sync that
 * would fetch the ticket, and a ticket that is not assigned to the operator is
 * never in this mirror at all — so "the pointer names something the board cannot
 * describe" is an ordinary Tuesday, and the panel has to say what it knows and
 * name what it does not rather than fetch it.
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

/** On the board, assigned to the operator, with a summary this file asserts on. */
const ON_BOARD = 'jira:acme.atlassian.net/MERC-1184'

/**
 * In no scenario, and deliberately in the same project as the rest.
 *
 * A key from an unknown project would also be absent from the mirror, and would
 * additionally have no project binding — so the panel could fail to offer the
 * tracker link for the *wrong* reason and this file would not notice.
 */
const NOT_ON_BOARD = 'jira:acme.atlassian.net/MERC-4242'

let it: LaunchedApp

const panel = () => it.window.getByRole('region', { name: /active ticket/i })
const tickets = () => it.window.getByRole('region', { name: /^tickets$/i })

/** Call the loopback API the way `grndctrl-mcp` does, from outside the window. */
async function agent(operation: string, body: unknown): Promise<Response> {
  const { port, token } = JSON.parse(readFileSync(join(it.dir, 'runtime.json'), 'utf8')) as {
    port: number
    token: string
  }

  return fetch(`http://127.0.0.1:${port}/op/${operation}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-grndctrl-agent': 'e2e',
    },
    body: JSON.stringify(body),
  })
}

/**
 * How long a push is allowed to take, and why it is short.
 *
 * **This number is the whole test.** The first version of this file used the
 * suite's usual ten seconds and two of its assertions passed with the push
 * unwired entirely — because the launch sync finishes a few seconds in and
 * invalidates *every* query, filling the panel for a reason that has nothing to
 * do with `focus:changed`. A generous timeout on a board that refreshes itself
 * is not a lenient assertion, it is a different assertion.
 *
 * So: settle first (below), then allow only as long as an IPC round trip needs.
 */
const PUSHED = { timeout: 2_500 }

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  /*
   * Wait for the launch sync to finish before asserting anything about pushes.
   *
   * There is no credential in an end-to-end data directory, so the first poll
   * fails — and a failure is exactly what settles the board here, because the
   * scheduler then backs off to `interval * 2` (600s at the seeded five-minute
   * interval). Nothing else invalidates for the rest of this file, so from this
   * line on a panel that changes changed because it was told to.
   *
   * The seeded freshness reads "last refreshed 2 hours ago" until then, so this
   * is a transition and not a state that was already true.
   */
  await expect(tickets().locator('.lane-status')).toContainText(/failed to refresh/i, {
    timeout: 30_000,
  })
})

test.afterAll(async () => {
  await it.close()
})

test('says plainly that nothing is being worked, and how to change that', async () => {
  await expect(panel()).toBeVisible()

  // US1 scenario 6. The wording is asserted rather than merely "the panel is
  // empty", because the requirement is that the empty state is *useful*: an
  // empty panel with no way to fill it is a dead region, and a blank one would
  // satisfy any assertion about emptiness.
  await expect(panel()).toContainText(/nothing is being worked/i)
  await expect(panel()).toContainText(/grndctrl-mcp/)
  await expect(panel()).toContainText(/ticket lane/i)
})

test('an agent setting the ticket fills the panel, with no reload', async () => {
  const response = await agent('focus.set', { ticketKey: ON_BOARD })
  expect(response.ok).toBe(true)

  // The write landed before anything is asked of the window — otherwise a
  // failure below is ambiguous between "the pointer was never set" and "the
  // window was never told", which are different bugs with one symptom.
  const read = (await (await agent('focus.get', {})).json()) as {
    ok: boolean
    data: { ticketKey: string; setBy: string; setById: string } | null
  }
  expect(read.ok).toBe(true)
  expect(read.data?.ticketKey).toBe(ON_BOARD)
  // Provenance comes from the transport. This request never claimed to be
  // anyone, and it is recorded as the agent it authenticated as.
  expect(read.data?.setBy).toBe('agent')
  expect(read.data?.setById).toBe('e2e')

  // No reload, no click. If these pass it is because main pushed `focus:changed`
  // and the renderer invalidated.
  await expect(panel()).toContainText('MERC-1184', PUSHED)
  await expect(panel()).toContainText(/Reconcile worktree state/i)
  await expect(panel()).toContainText(/In Review/i)
  await expect(panel()).toContainText(/set by e2e/i)
})

test('the ticket lane shows which row it is', async () => {
  // The panel says *what* is active; the lane says *which row*. Without this the
  // operator has to read one to interpret the other, and the control on every
  // other row would look identical to the one on the active row.
  const pressed = tickets().locator('.row__focus[data-active="true"]')
  await expect(pressed).toHaveCount(1)
  await expect(pressed).toHaveAccessibleName(/stop working MERC-1184/i)
})

test('a ticket the mirror does not hold shows what is known and names what is not', async () => {
  const before = await tickets().locator('.row').count()
  expect(before).toBeGreaterThan(0)

  const response = await agent('focus.set', { ticketKey: NOT_ON_BOARD })
  expect(response.ok).toBe(true)

  // FR-131. What is known is the key.
  await expect(panel()).toContainText('MERC-4242', PUSHED)
  // And what is not known is *named*, rather than rendered as a blank line or a
  // spinner that never resolves. A panel that showed the key and then nothing
  // reads as "this ticket has no summary", which is a claim about the ticket.
  await expect(panel()).toContainText(/not on your board/i)
  await expect(panel()).toContainText(/summary and status are not here/i)

  // The link is still offered. `links.resolve` builds a tracker URL from the key
  // and the project binding, so the one thing the operator can still do with an
  // unknown ticket is open it where it does live.
  await expect(panel().locator('.active__key')).toBeEnabled()

  /*
   * **And nothing was fetched.** The pointer is settable by an agent, so a panel
   * that fetched on it would turn an agent's input into a network call the
   * operator did not ask for, against a ticket that may not be theirs.
   *
   * The observable consequence is that the lane is unchanged: no row appeared,
   * and nothing was added to the mirror on the strength of a key. The structural
   * half — that the component has no way to fetch at all — is asserted against
   * the source in `test/renderer/active-ticket.test.ts`, because "no request was
   * made" is not something this window can be asked.
   */
  await expect(tickets().locator('.row')).toHaveCount(before)
  await expect(tickets()).not.toContainText('MERC-4242')
})

test('clearing it from the panel returns the empty state', async () => {
  await panel().locator('.active__clear').click()

  await expect(panel()).toContainText(/nothing is being worked/i, PUSHED)
  await expect(tickets().locator('.row__focus[data-active="true"]')).toHaveCount(0)

  // Cleared at the store, not merely in the window. The two would differ if the
  // panel had kept local state, and the next launch would restore a ticket the
  // operator had put down.
  const read = (await (await agent('focus.get', {})).json()) as { data: unknown }
  expect(read.data).toBeNull()
})

/*
 * SC-016 — the description (T127).
 *
 * Four things at once, because the requirement is that they are all legible
 * *together*: a table, a code block, a mention, and a node this application
 * cannot render. Any one of them alone would pass against a converter that
 * handled that one and dropped the rest.
 *
 * These re-set the focus themselves rather than relying on the tests above,
 * which leave it cleared.
 */
test.describe('the description', () => {
  test.beforeAll(async () => {
    const response = await agent('focus.set', { ticketKey: ON_BOARD })
    expect(response.ok).toBe(true)
    await expect(panel().locator('.doc')).toBeVisible(PUSHED)
  })

  test('renders a table, a code block and a mention', async () => {
    const doc = panel().locator('.doc')

    // A table as a table, not as its words run together. The header cell is
    // asserted separately from the body cell because a converter that lost
    // `header` would still put both strings on the page.
    await expect(doc.locator('th', { hasText: 'State' })).toBeVisible()
    await expect(doc.locator('td', { hasText: 'reconcile' })).toBeVisible()

    await expect(doc.locator('pre code')).toHaveText('git worktree prune --dry-run')

    // A mention is text, not a link. The href would be a Jira profile URL and
    // who this is is the part the reader needs.
    await expect(doc).toContainText('@Sam Ellery')
  })

  test('names the node it cannot render instead of dropping it', async () => {
    // The assertion this whole path exists for. A description whose acceptance
    // criteria were in a node like this reads as complete once it is gone, and
    // nothing on the screen suggests otherwise — which is why the placeholder
    // says *what* it was rather than "unsupported content".
    const placeholder = panel().locator('.doc__unsupported')

    await expect(placeholder).toHaveCount(1)
    await expect(placeholder).toContainText('panel')
    await expect(placeholder).toContainText(/open the ticket at the tracker/i)
  })

  test('puts no markup and no href on the page', async () => {
    /*
     * FR-129, two ways.
     *
     * **No markup**: the description is the least trusted input this
     * application handles, and the way it would go wrong is `innerHTML`. So the
     * assertion is against the page's own HTML rather than its text — a
     * `<script>` in a ticket would be invisible to any text assertion.
     *
     * **No `href`, even though the link now opens.** It is a `<button>`: the
     * URL lives in the closure and in the tooltip, and the only thing that can
     * act on it is the click, which main refuses unless this ticket's own
     * description contains it. An `<a href>` would put a live destination in
     * the DOM for anything on the page to read, drag or middle-click, and would
     * need its default prevented anyway because this window must not navigate.
     */
    const doc = panel().locator('.doc')

    await expect(doc.locator('a')).toHaveCount(0)
    await expect(doc.locator('script')).toHaveCount(0)
    await expect(doc.locator('[href]')).toHaveCount(0)

    const link = doc.locator('.doc__link')
    await expect(link).toHaveText('the RFC')
    await expect(link).toHaveAttribute('title', 'https://example.com/rfc/worktrees')
    // A real control, not a styled span: reachable by keyboard, announced as a
    // button, and the thing the click handler is on.
    await expect(link).toHaveRole('button')
  })

  test('a description link opens, and only because the description contains it', async () => {
    /*
     * The click, end to end, without opening a browser on the machine running
     * this.
     *
     * `shell.openExternal` is stubbed in the main process for the duration of
     * this test, which is the only way to assert *what would have been opened*
     * rather than that a handler returned without throwing. The second half is
     * the one that matters: the same channel, called with a URL that is not in
     * this description, is refused — and that is the property the whole design
     * rests on, because an injected script can call it with anything.
     */
    const opened: string[] = await it.app.evaluate(async ({ shell }) => {
      const seen: string[] = []
      const globals = globalThis as unknown as { __openedUrls?: string[] }
      globals.__openedUrls = seen
      // Replaced rather than spied on, so nothing reaches a real browser.
      shell.openExternal = (url: string): Promise<void> => {
        seen.push(url)
        return Promise.resolve()
      }
      return seen
    })
    expect(opened).toEqual([])

    await panel().locator('.doc__link').click()

    await expect
      .poll(() =>
        it.app.evaluate(
          () => (globalThis as unknown as { __openedUrls: string[] }).__openedUrls.length,
        ),
      )
      .toBe(1)

    expect(
      await it.app.evaluate(
        () => (globalThis as unknown as { __openedUrls: string[] }).__openedUrls[0],
      ),
    ).toBe('https://example.com/rfc/worktrees')

    // And the refusal, through the same bridge the click uses. A URL that is
    // not in this ticket's description is rejected on main's side, against
    // core's copy of the description rather than the page's.
    const refused = await it.window.evaluate(async () => {
      const bridge = (globalThis as unknown as {
        grndctrl: {
          openLink(r: { subjectKey: string; url: string }): Promise<{ ok: boolean; error?: { message: string } }>
        }
      }).grndctrl
      return bridge.openLink({
        subjectKey: 'jira:acme.atlassian.net/MERC-1184',
        url: 'https://evil.example/steal',
      })
    })

    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toMatch(/not in .* description/)

    // Nothing further reached the OS. Asserting the rejection alone would pass
    // on a handler that refused *after* opening it.
    expect(
      await it.app.evaluate(
        () => (globalThis as unknown as { __openedUrls: string[] }).__openedUrls.length,
      ),
    ).toBe(1)
  })

  test('scrolls inside its own bounds rather than growing the column', async () => {
    // US1 scenario 2. A description can be any length at all, and a panel that
    // grew to fit one would push the sessions and ball-in-court panels off a
    // board whose whole claim is that everything is visible at once.
    /*
     * The overflow is **forced**, and the cap is read rather than named.
     *
     * This asserted `clientHeight <= 320`, and 320 was the cap until the type
     * scale went up a step on 2026-08-20 and it became 400 -- so the test failed
     * on a number that was never the guarantee. The guarantee is that the panel
     * has a cap, honours it, and scrolls rather than growing.
     *
     * And the overflow itself used to be borrowed from the fixture's
     * description happening to be long enough, which is not this test's to
     * control: a shorter one, or a taller cap, would leave the panel fitting and
     * the "is actually being constrained" line quietly proving nothing. A block
     * that cannot fit under any cap removes the coincidence.
     */
    await panel().locator('.active').evaluate((el) => {
      const filler = document.createElement('div')
      filler.style.height = '2000px'
      filler.dataset['testFiller'] = 'true'
      el.appendChild(filler)
    })

    const box = await panel().locator('.active').evaluate((el) => ({
      client: el.clientHeight,
      scroll: el.scrollHeight,
      overflow: getComputedStyle(el).overflowY,
      cap: parseFloat(getComputedStyle(el).maxHeight),
    }))

    expect(box.overflow).toBe('auto')
    expect(box.cap).toBeGreaterThan(0)
    expect(box.client).toBeLessThanOrEqual(box.cap)
    expect(box.scroll).toBeGreaterThan(box.client)

    await panel()
      .locator('.active')
      .evaluate((el) => el.querySelector('[data-test-filler]')?.remove())
  })

  test('says nothing about a description it has not been told about', async () => {
    // `null` is "no description has reached this mirror", which is true of a
    // ticket synced before the column existed and of every ticket on a
    // connection that has never synced. Reporting that as "no description"
    // would be a claim about the ticket drawn from an absence of data.
    const response = await agent('focus.set', { ticketKey: 'jira:acme.atlassian.net/MERC-1201' })
    expect(response.ok).toBe(true)

    await expect(panel()).toContainText('MERC-1201', PUSHED)
    await expect(panel().locator('.doc')).toHaveCount(0)
    await expect(panel()).not.toContainText(/no description/i)
  })
})
