import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { launch, type LaunchedApp } from './app.js'

/**
 * The recent prompts panel (T141–T143 — SC-017, FR-136 to FR-141).
 *
 * ## SC-017 is worded the way it is for a reason, and this file obeys it
 *
 * "Asserted by reading the clipboard back, not by asserting the click handler
 * ran." The vacuous version of this test spies on the bridge, sees `copy` was
 * called with the right id, and passes on a build where the clipboard is never
 * written at all — which is precisely the failure the requirement is about,
 * because a copy that did nothing is indistinguishable from one that worked
 * until somebody pastes.
 *
 * So the assertion is `clipboard.readText()` in the **main process**, through
 * Electron's own API. That is the operating system's clipboard, read by the
 * process that wrote it, after a real click in a real window.
 *
 * ## And the long-prompt case is a separate test, deliberately
 *
 * A truncated copy fails at the paste, a long way from the click, and it passes
 * every assertion anyone writes about the short one. T143 asserts the exact
 * length rather than a `toContain`, because a copy cut at four thousand
 * characters still contains everything a substring check would look for.
 *
 * The panel is driven over the loopback API, like the other agent-facing panels:
 * nothing in the interface records a prompt, and nothing should.
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

const SHORT = 'Rewrite the reconcile path so it tolerates a missing worktree.'

/**
 * Long enough that no display could hold it, and built so a truncation anywhere
 * is visible in the last characters as well as in the length.
 */
const LONG = `Start of a very long prompt. ${'Consider the case where the worktree is already gone. '.repeat(
  400,
)}End of it.`

/** See `active-ticket.spec.ts`: long enough for an IPC round trip, short enough to mean something. */
const PUSHED = { timeout: 2_500 }

let it: LaunchedApp

const panel = () => it.window.getByRole('region', { name: /recent prompts/i })
const tickets = () => it.window.getByRole('region', { name: /^tickets$/i })

/** The system clipboard, read by the process that wrote it. The point of SC-017. */
const clipboard = (): Promise<string> =>
  it.app.evaluate(({ clipboard: c }) => c.readText())

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
      'x-grndctrl-agent': 'e2e-prompts',
    },
    body: JSON.stringify(body),
  })
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { ok: boolean; data: T }
  expect(body.ok).toBe(true)
  return body.data
}

test.beforeAll(async () => {
  it = await launch({ scenario: SCENARIO })

  // Settle before asserting anything about pushes. The launch sync invalidates
  // every query when it finishes, which would fill this panel for reasons
  // unrelated to `prompts:changed`; afterwards the scheduler backs off well past
  // the length of this file. Same argument as `active-ticket.spec.ts`.
  await expect(tickets().locator('.lane-status')).toContainText(/failed to refresh/i, {
    timeout: 30_000,
  })

  // Something else on the clipboard first, so "the copy worked" cannot be
  // satisfied by an empty clipboard or by whatever the machine happened to hold.
  await it.app.evaluate(({ clipboard: c }) => c.writeText('nothing to do with this test'))
})

test.afterAll(async () => {
  await it.close()
})

test('says what records a prompt, rather than being blank', async () => {
  // FR-141. Nothing records one until an agent is configured to, so an empty
  // panel is the expected state on a fresh install and has to read as "not wired
  // up yet" rather than as broken.
  await expect(panel()).toBeVisible()
  await expect(panel()).toContainText(/no prompts recorded/i)
  await expect(panel()).toContainText('grndctrl_record_prompt')
})

test('a prompt recorded by an agent arrives without the window being touched', async () => {
  await json(await agent('prompts.record', { text: SHORT }))

  await expect(panel()).toContainText(/reconcile path/i, PUSHED)
  await expect(panel()).toContainText('e2e-prompts')
})

test('clicking a prompt puts it on the system clipboard', async () => {
  /*
   * SC-017. The click is real, the window is real, and the assertion is the
   * clipboard rather than anything about the handler.
   */
  await panel().locator('.prompt__copy').first().click()

  await expect.poll(clipboard, { timeout: 5_000 }).toBe(SHORT)

  // And it says so. A confirmation is half the requirement (FR-138) — the count
  // is read back off the clipboard in main, so it is a claim about the clipboard
  // rather than about the click.
  await expect(panel().locator('.prompt__copied')).toContainText(`${SHORT.length} characters`)
})

test('a long prompt is copied whole, however little of it the row shows', async () => {
  /*
   * T143 / FR-138.
   *
   * Two assertions, and the pair is the point. The row is **short** — the panel
   * cuts the preview in JavaScript, so the rest of the prompt is not in the page
   * at all — and the clipboard is **exactly** as long as what was recorded. A
   * copy that read the rendered element would satisfy neither, and a `toContain`
   * would satisfy both while missing a truncation.
   */
  const recorded = await json<{ id: string }>(await agent('prompts.record', { text: LONG }))
  expect(recorded.id).toBeTruthy()

  const row = panel().locator('.prompt').first()
  await expect(row).toContainText(/Start of a very long prompt/, PUSHED)

  const shown = (await row.locator('.prompt__text').innerText()).trim()
  expect(shown.length).toBeLessThan(400)
  expect(LONG.length).toBeGreaterThan(20_000)

  await row.locator('.prompt__copy').click()

  await expect.poll(async () => (await clipboard()).length, { timeout: 5_000 }).toBe(LONG.length)
  // The end as well as the length. A copy padded to the right size would pass a
  // length check on its own.
  expect(await clipboard()).toBe(LONG)
})

test('deleting a prompt removes it, and the panel says so without a reload', async () => {
  // FR-140, and the reason it exists: a prompt is free text an agent was handed
  // and may carry a token somebody pasted. `prompts.delete` is `ui-only`, so
  // this control is the only way to do it anywhere in the product.
  //
  // It records its own row and acts on that one by name rather than counting
  // what earlier tests left behind. A count would make one failure above into
  // three failures here, which buries the thing that actually broke.
  await json(await agent('prompts.record', { text: 'DELETE-ME: it turned out to hold a secret.' }))

  const doomed = panel().locator('.prompt').filter({ hasText: 'DELETE-ME' })
  await expect(doomed).toHaveCount(1, PUSHED)

  await doomed.locator('.prompt__delete').click()

  await expect(panel().locator('.prompt').filter({ hasText: 'DELETE-ME' })).toHaveCount(0, PUSHED)
})

test('an agent cannot delete the operator\u2019s prompts', async () => {
  /*
   * The other half of `ui-only`, asserted at the surface an agent actually has.
   *
   * The registry test proves the operation refuses an agent context; this proves
   * the loopback API an agent really talks to does not carry the operation at
   * all. Curating this history is the operator's, and an agent that could delete
   * a prompt could remove the record of what it was told to do.
   */
  const recorded = await json<{ id: string }>(
    await agent('prompts.record', { text: 'KEEP-ME: the operator decides what stays.' }),
  )

  const refused = await agent('prompts.delete', { id: recorded.id })
  expect(refused.ok).toBe(false)

  await expect(panel().locator('.prompt').filter({ hasText: 'KEEP-ME' })).toHaveCount(1, PUSHED)
})
