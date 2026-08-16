import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

/**
 * A real Ground Control, launched, over a data directory of its own.
 *
 * Two things here are not incidental:
 *
 * **`GRNDCTRL_DATA_DIR`.** Without it every spec would open the operator's
 * actual databases — creating notes in them, dispatching actions from them, and
 * asserting on an empty board while their real projects sit in it.
 *
 * **`ELECTRON_RUN_AS_NODE` is stripped.** Some editors and agent runtimes export
 * it, and it makes `electron.exe` behave as plain Node: `process.type` is
 * undefined, `require('electron')` resolves to the npm stub rather than the
 * built-in, and the failure that reaches you is `Cannot read properties of
 * undefined (reading 'requestSingleInstanceLock')` — which reads like a bug in
 * the app and is not.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = join(HERE, '..', '..')

export interface LaunchedApp {
  app: ElectronApplication
  window: Page
  dir: string
  close(): Promise<void>
}

export interface LaunchOptions {
  /** Extra environment for the app under test. */
  env?: Record<string, string>
  /**
   * A checked-in scenario to load before launching.
   *
   * The board needs data, and the data normally comes from Jira and GitHub —
   * which would make this suite depend on somebody's live board and fail on a
   * Tuesday because a colleague closed a ticket. Seeding the mirror from the
   * same fixtures the correlation engine is tested against gives the genuine
   * path over known inputs; only the provider fetch is skipped.
   */
  scenario?: string
}

export async function launch(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-e2e-'))

  if (options.scenario !== undefined) {
    execFileSync(
      process.execPath,
      [join(PACKAGE, 'scripts', 'seed.mjs'), '--dir', dir, '--scenario', options.scenario],
      { cwd: PACKAGE, stdio: 'pipe' },
    )
  }

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'ELECTRON_NO_ATTACH_CONSOLE') continue
    if (value !== undefined) env[key] = value
  }

  const app = await electron.launch({
    args: [PACKAGE],
    cwd: PACKAGE,
    env: { ...env, GRNDCTRL_DATA_DIR: dir, ...options.env },
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  return {
    app,
    window,
    dir,
    async close() {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
