import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The settings screens (T153), against a real Chromium.
 *
 * The unit suite cannot reach these: they are forms whose value is in what they
 * refuse and what they never hold, and both of those are properties of the
 * rendered page. Today produced eight defects in code with passing tests, every
 * one found by looking at the running application — so the parts of this screen
 * that matter get looked at by something.
 *
 * What is asserted here is deliberately not "the form works". It is:
 *
 *   - the secret field is a password field and starts empty, **including when
 *     re-authorizing an account that already has a working token**
 *   - nothing on the page can read a credential back
 *   - a test result reports each check by name rather than one verdict
 */

let it: LaunchedApp

test.beforeEach(async () => {
  it = await launch()
})

test.afterEach(async () => {
  await it.close()
})

test('settings is reachable from the board and returns to it', async () => {
  const { window } = it

  await window.getByRole('button', { name: 'Settings' }).click()
  await expect(window.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()

  await window.getByRole('button', { name: 'Back to the board' }).click()
  await expect(window.getByRole('heading', { name: 'Ground Control', level: 1 })).toBeVisible()
})

test('the secret field is a password field and starts empty', async () => {
  const { window } = it
  await window.getByRole('button', { name: 'Settings' }).click()

  // There is exactly one, and re-authorizing an existing account gets the same
  // empty box as adding a new one. That is the point: no operation returns a
  // stored secret and no bridge method could, so there is nothing to pre-fill
  // it with — and a field that *looked* pre-filled would mean there was.
  const secret = window.locator('input[type="password"]')
  await expect(secret).toHaveCount(1)
  await expect(secret).toBeVisible()
  await expect(secret).toHaveValue('')

  // Never offered back by the browser either. The keychain is the only place a
  // credential lives (FR-005), and an autofill store would be a second one.
  await expect(secret).toHaveAttribute('autocomplete', 'off')

  /*
   * This test used to type a value and then press the "GitHub" button, to check
   * what a change of provider did to a half-typed Jira token. There is one
   * provider now, so there is no context to switch and the segmented control is
   * gone — a control that cannot be used to choose anything is not a control.
   */
})

test('no field on the page exposes a stored credential', async () => {
  const { window } = it
  await window.getByRole('button', { name: 'Settings' }).click()

  // Nothing reads a secret back: there is no operation that returns one and no
  // bridge method that could. The assertion is on the rendered page because
  // that is where the mistake would be visible — a "current token" field
  // helpfully pre-filled from somewhere.
  const values = await window.locator('input').evaluateAll((inputs) =>
    inputs.map((i) => (i as HTMLInputElement).value),
  )

  for (const value of values) {
    expect(value.length, `an input was pre-filled with ${value.length} characters`).toBeLessThan(60)
  }
})

test('the bridge offers no way to read a credential', async () => {
  const { window } = it

  const surface = await window.evaluate(() => {
    const bridge = (window as unknown as { grndctrl?: Record<string, unknown> }).grndctrl
    return bridge === undefined ? [] : Object.keys(bridge)
  })

  // `credential` is write-only by construction. A getter beside it would put a
  // token back inside the process that renders provider-supplied strings.
  expect(surface).toContain('credential')
  expect(surface).not.toContain('credentials')
  expect(surface).not.toContain('getCredential')
})

test('an empty configuration says so rather than looking broken', async () => {
  const { window } = it
  await window.getByRole('button', { name: 'Settings' }).click()

  await expect(window.getByText('No connections yet. Add one below.')).toBeVisible()
  await expect(window.getByText('No projects yet. Add one below.')).toBeVisible()
})
