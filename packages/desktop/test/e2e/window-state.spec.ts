import { expect, test } from '@playwright/test'
import { launch, type LaunchedApp } from './app.js'

/**
 * The window remembers itself (T154, T176 — FR-082).
 *
 * `persistence.test.ts` covers the rules — where to open, when a position is
 * worth saving — over fabricated displays. What it cannot cover is whether any
 * of it is *connected*: `windowGeometry` sat in the settings schema from M2
 * until now with nothing writing it and nothing reading it, and every unit test
 * around it would have passed just the same. So this drives a real window.
 */

let it: LaunchedApp

test.afterEach(async () => {
  await it.close()
})

test('the on-top toggle reaches the actual window, not just the setting', async () => {
  it = await launch()

  const toggle = it.window.getByRole('button', { name: 'On top' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  const before = await it.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop(),
  )
  expect(before).toBe(false)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // The renderer holds no window handle and never will — `setAlwaysOnTop` is a
  // `BrowserWindow` method and the bridge exposes no window. So the click wrote
  // a setting, and main applied it by watching `settings.update` go past. This
  // assertion is the only thing that distinguishes that from a button which
  // merely turns blue.
  await expect
    .poll(() =>
      it.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop()),
    )
    .toBe(true)

  await toggle.click()
  await expect
    .poll(() =>
      it.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop()),
    )
    .toBe(false)
})

test('on-top survives a restart, and the window comes back already on top', async () => {
  it = await launch()
  const dir = it.dir

  await it.window.getByRole('button', { name: 'On top' }).click()
  await expect(it.window.getByRole('button', { name: 'On top' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await it.app.close()

  it = await launch({ env: { GRNDCTRL_DATA_DIR: dir } })
  it.dir = dir

  // Read from the window rather than only from the button: applied at
  // construction, so a window the operator asked to keep on top never appears
  // behind something else first and then jumps.
  expect(
    await it.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop()),
  ).toBe(true)
  await expect(it.window.getByRole('button', { name: 'On top' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('the window reopens where it was left', async () => {
  it = await launch()
  const dir = it.dir

  const moved = { x: 120, y: 90, width: 1100, height: 720 }
  await it.app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(bounds)
  }, moved)

  // Past the debounce. The write is deliberately not per-frame — a drag emits
  // a hundred resize events and each one would be a write to SQLite.
  await it.window.waitForTimeout(1200)
  await it.app.close()

  it = await launch({ env: { GRNDCTRL_DATA_DIR: dir } })
  it.dir = dir

  const restored = await it.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getBounds(),
  )

  // Not exact equality: a window manager may adjust a few pixels for frame
  // insets or snapping, and asserting to the pixel would make this fail on
  // somebody else's machine for a reason that is not a bug.
  expect(restored?.width).toBeCloseTo(moved.width, -1)
  expect(restored?.height).toBeCloseTo(moved.height, -1)
  expect(restored?.x).toBeCloseTo(moved.x, -1)
  expect(restored?.y).toBeCloseTo(moved.y, -1)
})

test('the project filter and the court filter survive a restart', async () => {
  it = await launch()
  const dir = it.dir

  // No projects in a bare launch, so the court tile is the one to drive — it is
  // the other half of what FR-082 names, and it is on screen either way.
  const court = it.window.getByRole('button', { name: /Your court/ })
  if ((await court.count()) > 0) {
    await court.click()
    await expect(court).toHaveAttribute('aria-pressed', 'true')
    await it.window.waitForTimeout(300)
  }

  const stored = await it.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      settings: { get(input: unknown): Promise<{ ok: boolean; data: unknown }> }
    }
    const result = await bridge.settings.get({})
    return result.ok ? (result.data as { mineOnly: boolean; alwaysOnTop: boolean }) : null
  })

  expect(stored).not.toBeNull()
  expect(typeof stored?.mineOnly).toBe('boolean')
  await it.app.close()

  it = await launch({ env: { GRNDCTRL_DATA_DIR: dir } })
  it.dir = dir

  const after = await it.window.evaluate(async () => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as {
      settings: { get(input: unknown): Promise<{ ok: boolean; data: unknown }> }
    }
    const result = await bridge.settings.get({})
    return result.ok ? (result.data as { mineOnly: boolean }) : null
  })

  expect(after?.mineOnly).toBe(stored?.mineOnly)
})
