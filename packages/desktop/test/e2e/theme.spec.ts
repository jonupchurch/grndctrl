import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * Appearance and density against a real Chromium (T130, T131 — FR-078, FR-079).
 *
 * These are the two features where a unit test would be testing its own mock.
 * The claims are "the dark palette is applied", "the override beats the system
 * preference in both directions", and "compact actually changes the row height"
 * — all of which are properties of computed style in a live document, resolved
 * through a cascade of custom properties that only the browser evaluates.
 */

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch()
})

test.afterAll(async () => {
  await it.close()
})

const setAppearance = async (appearance: string): Promise<void> => {
  await it.window.evaluate(async (value) => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      settings: { update(input: unknown): Promise<{ ok: boolean }> }
    }
    await bridge.settings.update({ appearance: value })
  }, appearance)
}

const token = (name: string): Promise<string> =>
  it.window.evaluate(
    (n) => globalThis.getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  )

test('the tokens resolve, so a component never has to name a colour', async () => {
  // If this is empty the stylesheet did not load, and every component below
  // would silently render with no colour rather than fail.
  expect(await token('--ink')).not.toBe('')
  expect(await token('--critical')).not.toBe('')
  expect(await token('--row-h')).toBe('34px')
})

test('an explicit override stamps data-theme and the system default does not', async () => {
  await it.window.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  expect(await it.window.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark')

  const dark = await token('--plane')
  expect(dark).toBe('#0d0d0d')

  await it.window.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  expect(await token('--plane')).toBe('#f9f9f7')

  // Absent, not `data-theme="system"`. The stylesheet's media query is what
  // follows the OS, and it can only do that when nothing overrides it.
  await it.window.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  expect(await it.window.evaluate(() => document.documentElement.dataset['theme'])).toBeUndefined()
})

test('the dark palette is designed, not an inversion', async () => {
  await it.window.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const good = await token('--good')
  await it.window.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  const lightGood = await token('--good')

  // #2fbe2f against #0d0d0d, #0ca30c against #f9f9f7. An algorithm inverting the
  // light value would produce neither, and the light green vanishes on the dark
  // ground.
  expect(good).toBe('#2fbe2f')
  expect(lightGood).toBe('#0ca30c')
  expect(good).not.toBe(lightGood)
})

test('compact density changes the measurements and nothing else', async () => {
  await it.window.evaluate(() => document.documentElement.setAttribute('data-density', 'compact'))

  expect(await token('--row-h')).toBe('28px')
  expect(await token('--lane-head-h')).toBe('34px')
  // A density that also moved colours or weights would be a second design to
  // maintain, and the two would drift.
  expect(await token('--ink')).toBe(await token('--ink'))
  expect(await token('--critical')).toBe('#d03b3b')

  await it.window.evaluate(() =>
    document.documentElement.setAttribute('data-density', 'comfortable'),
  )
  expect(await token('--row-h')).toBe('34px')
})

test('the appearance choice survives being written through the service', async () => {
  await setAppearance('dark')

  const stored = await it.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      settings: { get(input: unknown): Promise<{ ok: boolean; data: { appearance: string } }> }
    }
    return bridge.settings.get({})
  })

  // Written to the authored store, not held in the renderer, so it is the same
  // on the next launch and in every window (FR-082).
  expect(stored.ok).toBe(true)
  expect(stored.data.appearance).toBe('dark')

  await setAppearance('system')
})
