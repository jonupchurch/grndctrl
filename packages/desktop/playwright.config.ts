import { defineConfig } from '@playwright/test'

/**
 * The end-to-end suite drives a real Electron build.
 *
 * There is no `webServer` and no browser project, because there is no server and
 * no browser: every spec launches the packaged main process through Playwright's
 * Electron support and talks to the actual window. That is the point — the
 * claims these specs make (the renderer holds no Node, one failing provider does
 * not blank the others, severity survives greyscale) are claims about the real
 * process boundaries, and a jsdom harness would only test the harness.
 *
 * Serial by default. Each spec starts an app that opens two SQLite files and
 * binds a port; running them concurrently would have them contending for a data
 * directory unless every one remembered to make its own, and "unless everyone
 * remembers" is not a property.
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  // Launching Electron and waiting for the first paint is slower than a browser
  // page load, and a timeout that fires during startup reports as a product
  // failure rather than a slow machine.
  timeout: 60_000,
  expect: { timeout: 10_000 },
})
