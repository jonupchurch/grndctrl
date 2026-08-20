import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { appDataDir, type Connection, type Settings, type SyncReport } from '@grndctrl/core'
import { scheduler } from '@grndctrl/core/scheduler'
import { COPY_CHANNEL, CREDENTIAL_CHANNEL, OPEN_CHANNEL, OPEN_URL_CHANNEL } from '../shared/channels.js'
import { promptCopier, type CopyRequest } from './clipboard.js'
import { credentialHandler, type CredentialResult } from './credential.js'
import { registerIpcAdapter, type IpcResult, type IpcSender } from './ipc.js'
import {
  descriptionLinkOpener,
  linkOpener,
  type OpenDescriptionLinkRequest,
  type OpenRequest,
} from './links.js'
import {
  placement,
  trackWindowState,
  type Rectangle,
  type SavedWindowState,
} from './persistence.js'
import { push } from './push.js'
import { applySecurity, hardenWebContents } from './security.js'
import { startAppService, type AppService } from './service.js'

/**
 * The shell. It owns a window and a lifecycle, and nothing else.
 *
 * Everything the application can *do* is an operation in the registry, reached
 * through the adapter in `ipc.ts`. What is left here is the part only Electron
 * can do: open a window, keep one copy running, and shut the service down
 * cleanly. Deciding anything in this file is a sign a decision has escaped the
 * service layer.
 *
 * Note the order of construction: the service starts *before* the window. Core,
 * the loopback API, and the handshake are what an agent talks to, and they must
 * be reachable whether or not there is a UI on screen — the same property M3
 * demonstrated with no UI in existence at all. The window is a client of the
 * service, not its host.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PRELOAD = join(HERE, '..', 'preload', 'index.cjs')
const RENDERER = join(HERE, '..', 'renderer', 'index.html')

let service: AppService | null = null
let stopFreshnessClock: (() => void) | null = null
let stopWindowTracking: (() => void) | null = null
let stopPolling: (() => void) | null = null

/**
 * Chromium's own storage goes inside our data directory, and this must happen
 * before anything else touches `app`.
 *
 * Two reasons, and the second one is the one that bites. Electron keys the
 * single-instance lock on the `userData` path, so leaving it at the default
 * makes the lock machine-wide — which means the end-to-end suite, each spec
 * launching a real app over a temp directory of its own, refuses to start while
 * the operator has Ground Control open, and each spec races the previous one's
 * shutdown. Scoping `userData` to the data directory makes the lock mean what it
 * is for: one writer per set of databases.
 *
 * The first reason is XI. Cookies, cache and local storage are state this
 * application creates, and it should live where all its other state lives —
 * under one directory the operator can delete.
 */
app.setPath('userData', join(appDataDir(), 'chromium'))

/**
 * One copy of the app *per data directory*, because two would be two writers on
 * one SQLite file and two handshake files racing to publish different ports. The
 * second launch raises the first window instead — which is what someone
 * double-clicking the icon meant anyway.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing === undefined) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.whenReady().then(main).catch(fatal)
}

async function main(): Promise<void> {
  // Built before the service, because the service needs to tell it about agent
  // traffic and the loopback adapter starts inside `startAppService`. Safe to
  // construct this early: `targets()` is a thunk, evaluated per broadcast, so
  // there being no window yet is simply nobody to tell.
  const events = push({
    targets: () => BrowserWindow.getAllWindows().map((w) => w.webContents),
    // Read from the registry, late — `service` is assigned two lines below and
    // nothing dispatches before then. Answering `false` until it exists is
    // correct: there is nothing to announce and nobody to announce it to.
    mutates: (operation) => service?.mutates(operation) ?? false,
  })

  service = await startAppService({
    // The agent's half of the push stream. Without it every event here fired
    // for what the *window* did and nothing for what an *agent* did — so an
    // agent starting a session, or claiming an action, left the board still.
    onAgentDispatch: (operation) => events.afterDispatch(operation),
  })

  // Electron's default menu is not in the design, and two of its items are
  // actively wrong here: View → Reload navigates the window, which
  // `main/security.ts` exists to prevent, and Window → New Window opens a second
  // one with no service behind it. The design's titlebar carries the project
  // chips and the theme toggle instead (T137).
  Menu.setApplicationMenu(null)

  applySecurity(session.defaultSession)

  stopFreshnessClock = events.start()

  // `authorKind` is stamped `user` because this is the UI surface.
  const run = async (operation: string, payload: unknown): Promise<unknown> => {
    if (service === null) throw new Error('The service is not running.')
    const result = await service.dispatch(operation, payload, {
      authorKind: 'user',
      authorId: null,
      surface: 'ipc',
    })

    // The one operation the shell itself has to act on (T176). `settings.update`
    // returns the whole settings row, so this reads the value that was actually
    // stored rather than the patch that was sent — the two differ whenever the
    // key was not in the patch at all, and applying the patch would then turn
    // the window's "on top" off every time any other setting changed.
    if (operation === 'settings.update') applyWindowState(result)

    return result
  }

  // Push events are derived from the dispatch stream rather than announced by
  // each caller, so this wrapper is what every route below shares — including
  // the poll scheduler's. A background sync that skipped it would refresh the
  // mirror and leave the window showing the previous one, while the freshness
  // reading underneath said the data was new: the worst pair of the two.
  const announced = events.observing(run)

  /**
   * What keeps the board current without the operator clicking Refresh (T074).
   *
   * `pollIntervalSec` has been in settings since M2 and only the *freshness*
   * calculation ever read it — the lanes have been going stale on the schedule
   * of a poll that did not exist.
   *
   * Built here rather than in `startAppService` because it must reach core the
   * same way the window does, through `announced`. Note the asymmetry: the
   * scheduler's own polls go through `announced` and *not* through
   * `poller.observing`, because `observing` exists to notice syncs the scheduler
   * did not start. Routing its own polls through it as well would count every
   * failure twice and double the backoff.
   */
  const poller = scheduler({
    connections: async () => (await announced('connections.list', {})) as readonly Connection[],
    settings: async () => (await announced('settings.get', {})) as Settings,
    sync: async (connectionId) => (await announced('sync.now', { connectionId })) as SyncReport,
    now: () => new Date(),
    setTimer: (fire, ms) => {
      const timer = setTimeout(fire, ms)
      // Same rule as the freshness clock: a pending poll must never be the
      // reason the process outlives its last window.
      timer.unref?.()
      return timer
    },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  })

  // The dispatch every channel below shares. `poller.observing` is the outer
  // wrapper so that a refresh the operator asked for restarts that connection's
  // clock — otherwise clicking Refresh at 59 seconds is followed by an automatic
  // poll one second later.
  const dispatch = poller.observing(announced)

  stopPolling = poller.start()

  registerIpcAdapter({
    host: {
      handle: (channel, listener) =>
        ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) =>
          listener(senderOf(event), payload),
        ),
      removeHandler: (channel) => ipcMain.removeHandler(channel),
    },
    operations: service.operations(),
    dispatch,
    isTrustedSender: trusted,
  })

  const open = linkOpener({ dispatch, openExternal: (url) => shell.openExternal(url) })

  // Not an operation, and deliberately not in `exposedNames()`: opening the
  // operator's browser is a host affordance of the shell, like the window
  // itself. The URL it opens is not the renderer's — it comes from
  // `links.resolve`, which *is* an operation and is on every surface, so XII is
  // satisfied where it applies. `test/shell-channels.test.ts` pins the set of
  // non-operation channels so a fourth one cannot arrive quietly.
  ipcMain.handle(OPEN_CHANNEL, async (event, request: OpenRequest): Promise<IpcResult> => {
    if (!trusted(senderOf(event))) {
      return { ok: false, error: { code: 'invalid', message: 'Unrecognised sender.' } }
    }
    try {
      return { ok: true, data: await open(request) }
    } catch (e) {
      return {
        ok: false,
        error: { code: 'invalid', message: e instanceof Error ? e.message : 'Could not open that.' },
      }
    }
  })

  // The third non-operation channel. It takes a URL, which the launcher above
  // deliberately does not — and gives away much less than that sounds, because
  // main refuses any URL the named ticket's own description does not contain.
  // See `shared/channels.ts` for why it is separate rather than a field on the
  // launcher.
  const openDescriptionLink = descriptionLinkOpener({
    dispatch,
    openExternal: (url) => shell.openExternal(url),
  })

  ipcMain.handle(
    OPEN_URL_CHANNEL,
    async (event, request: OpenDescriptionLinkRequest): Promise<IpcResult> => {
      if (!trusted(senderOf(event))) {
        return { ok: false, error: { code: 'invalid', message: 'Unrecognised sender.' } }
      }
      try {
        return { ok: true, data: await openDescriptionLink(request) }
      } catch (e) {
        return {
          ok: false,
          error: {
            code: 'invalid',
            message: e instanceof Error ? e.message : 'Could not open that link.',
          },
        }
      }
    },
  )

  // The fourth. It takes a prompt *id* and reads the text here, so the string
  // the operating system hands to the next application is one core stored rather
  // than one the page chose (FR-139) — and it reads the clipboard back before
  // reporting success, because a copy that silently did nothing is only
  // discovered at the paste (FR-138). See `main/clipboard.ts`.
  const copyPrompt = promptCopier({
    dispatch,
    writeText: (text) => clipboard.writeText(text),
    readText: () => clipboard.readText(),
  })

  ipcMain.handle(COPY_CHANNEL, async (event, request: CopyRequest): Promise<IpcResult> => {
    if (!trusted(senderOf(event))) {
      return { ok: false, error: { code: 'invalid', message: 'Unrecognised sender.' } }
    }
    try {
      return { ok: true, data: await copyPrompt(request) }
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'invalid',
          message: e instanceof Error ? e.message : 'Could not copy that prompt.',
        },
      }
    }
  })

  // The second non-operation channel, for the reason set out in
  // `shared/channels.ts`: a secret that never enters the registry cannot be put
  // on a surface by getting an exposure wrong.
  const storeCredential = credentialHandler({
    add: (input) => {
      if (service === null) throw new Error('The service is not running.')
      return service.addConnection(input)
    },
  })

  ipcMain.handle(CREDENTIAL_CHANNEL, (event, request: unknown): CredentialResult => {
    if (!trusted(senderOf(event))) {
      return { ok: false, error: { code: 'invalid', message: 'Unrecognised sender.' } }
    }
    return storeCredential(request)
  })

  // Read before the window is built, because where it opens is one of the
  // answers (T154). A failure here is not fatal and must not be: the defaults
  // put a usable window on the primary display, and refusing to launch because
  // a preference could not be read would be absurd.
  const saved = await readWindowState(dispatch)

  const window = createWindow(saved)

  // macOS keeps the process alive with no windows; clicking the dock icon is
  // expected to bring one back rather than do nothing.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(saved)
  })

  if (process.env['GRNDCTRL_SMOKE'] === '1') await smokeCheck(window, dispatch)
}

/**
 * Boot, prove it worked, and exit (T166–T168).
 *
 * `npx grndctrl` is the riskiest path in the project because it fails on a
 * user's machine and not in CI, and the only previous evidence it works was one
 * person on Windows watching a window appear. A GitHub Actions runner is a clean
 * machine with an empty runtime cache — exactly what the task asks for — but
 * nobody is watching it, so the app has to report on itself.
 *
 * **Env-gated, never argv.** `argv` is passed through to Electron by the
 * launcher and onward to Chromium, where an unrecognised flag is ignored rather
 * than rejected. A stray `--smoke` in a shortcut would then quit a real
 * operator's app a second after it opened, with no error to explain it. An
 * environment variable has to be set deliberately by whoever starts the process.
 *
 * What passing actually proves, stated so the CI badge is not read for more than
 * it is worth: the runtime downloaded and verified, it unpacked, the ABI matched
 * a native module that then *loaded* — `app.status` reaches SQLite, so this is
 * the runtime check the launcher's static comparison cannot be — Chromium
 * composited a frame, and the renderer's HTML parsed. It does **not** prove the
 * board is correct, or that a human would recognise what is on screen. That
 * remains verified on Windows only, by eye.
 */
async function smokeCheck(
  window: BrowserWindow,
  dispatch: (name: string, input: unknown) => Promise<unknown>,
): Promise<void> {
  const fail = (why: string): never => {
    process.stderr.write(`smoke: ${why}\n`)
    // `app.exit`, not `app.quit`: quit runs `before-quit` and the window-close
    // path, either of which can swallow a non-zero code and hand CI a pass.
    app.exit(1)
    throw new Error(why)
  }

  const painted = new Promise<void>((resolve, reject) => {
    // 90s: a cold Chromium on a shared runner is slow, and a smoke test that
    // flakes gets deleted rather than fixed.
    const timer = setTimeout(() => reject(new Error('the window never painted within 90s')), 90_000)
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }

    if (!window.isDestroyed() && window.webContents.getURL() !== '' && !window.webContents.isLoading()) {
      done()
      return
    }
    window.once('ready-to-show', done)
    // A renderer that fails to load never emits `ready-to-show`, so without this
    // the run would sit until the timeout and report the wrong reason.
    window.webContents.once('did-fail-load', (_e, code, description) => {
      clearTimeout(timer)
      reject(new Error(`the renderer failed to load: ${description} (${code})`))
    })
  })

  try {
    await painted
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }

  try {
    // Through the registry, like everything else. This is the arm that touches
    // the native module: a mismatched build passes the launcher's version
    // comparison and throws here instead.
    const status = await dispatch('app.status', {})
    process.stdout.write(`smoke: ok ${JSON.stringify(status)}\n`)
  } catch (e) {
    fail(`app.status failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  app.exit(0)
}

/**
 * The saved window state, or the defaults.
 *
 * Through `dispatch` rather than by reaching into the settings store, so this
 * file keeps the property the header comment claims: everything the application
 * can *do* is an operation, and main reaches core one way.
 */
async function readWindowState(
  dispatch: (name: string, input: unknown) => Promise<unknown>,
): Promise<SavedWindowState> {
  try {
    const settings = (await dispatch('settings.get', {})) as Partial<SavedWindowState>
    return {
      windowGeometry: settings.windowGeometry ?? null,
      alwaysOnTop: settings.alwaysOnTop === true,
    }
  } catch {
    return { windowGeometry: null, alwaysOnTop: false }
  }
}

/**
 * Where to open, given the displays that exist right now (T154).
 *
 * `GRNDCTRL_DISPLAY` is a 1-based index into the displays as the OS reports
 * them, and it exists because a developer running this repeatedly does not
 * necessarily want it landing on the screen they are using for something else.
 * It wins over the saved position, because it is an instruction about *this*
 * launch and the saved position is a record of the last one.
 *
 * The rules themselves are in `persistence.ts`, which imports no Electron — so
 * "the monitor it was on has been unplugged" is a unit test rather than
 * something only reproducible with a dock.
 */
function targetBounds(saved: SavedWindowState): Rectangle {
  const requested = Number.parseInt(process.env['GRNDCTRL_DISPLAY'] ?? '', 10)

  return placement({
    saved: saved.windowGeometry,
    displays: screen.getAllDisplays(),
    primary: screen.getPrimaryDisplay(),
    ...(Number.isInteger(requested) && requested >= 1 ? { requestedDisplay: requested } : {}),
  })
}

function createWindow(saved: SavedWindowState): BrowserWindow {
  const bounds = targetBounds(saved)
  const area = screen.getPrimaryDisplay().workArea

  const window = new BrowserWindow({
    ...bounds,
    minWidth: Math.min(960, area.width),
    minHeight: Math.min(600, area.height),
    // T176. Applied at construction rather than after `show`, so a window the
    // operator asked to keep on top never appears behind anything first.
    alwaysOnTop: saved.alwaysOnTop,
    show: false,
    backgroundColor: '#101112',
    title: 'Ground Control',
    webPreferences: {
      preload: PRELOAD,
      // All four are Electron's defaults in v33. They are written out anyway:
      // a default is a decision someone else made and can change in a major
      // version, and these four are the ones that would silently turn the
      // renderer — which displays provider-supplied strings — into a process
      // holding Node.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Nothing on this page is a document to spellcheck, and the service sends
      // words to a remote endpoint on some platforms.
      spellcheck: false,
    },
  })

  hardenWebContents(window.webContents)

  // Remember where it ends up (T154, FR-082). Writes are swallowed rather than
  // surfaced: this runs on every drag, and a modal about a failed preference
  // write while the operator is moving a window would be worse than forgetting
  // where they put it.
  stopWindowTracking?.()
  stopWindowTracking = trackWindowState({
    window,
    save: (geometry) => {
      void service?.dispatch(
        'settings.update',
        { windowGeometry: geometry },
        { authorKind: 'user', authorId: null, surface: 'ipc' },
      ).catch(() => undefined)
    },
  })

  // Shown on first paint rather than immediately: a window that appears empty
  // and fills in a moment later reads as a slow app even when it is not.
  window.once('ready-to-show', () => window.show())
  void window.loadFile(RENDERER)

  return window
}

/**
 * Apply `alwaysOnTop` to the windows, after the renderer has changed it (T176).
 *
 * The renderer cannot call `setAlwaysOnTop` — it is a `BrowserWindow` method
 * and the bridge exposes no window handle, which is the point of the bridge.
 * The route is deliberately *not* a third shell channel: the toggle is a
 * setting, `settings.update` already carries it, and the shell reacting to its
 * own data keeps XII intact. A new channel would be a second way to change one
 * fact, and the two would drift.
 */
function applyWindowState(settings: unknown): void {
  const onTop = (settings as { alwaysOnTop?: unknown } | null)?.alwaysOnTop
  if (typeof onTop !== 'boolean') return

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isAlwaysOnTop() !== onTop) window.setAlwaysOnTop(onTop)
  }
}

/**
 * Where a message came from, as facts rather than as a URL.
 *
 * `senderFrame` is null once the frame has been disposed, and its `url` is not
 * dependably the final one when the renderer's *first* message arrives — which
 * is how comparing it against the entry point made the app refuse its own
 * opening call about one launch in two. Frame identity does not have that
 * problem: a frame either is a window's top-level frame or it is not, from the
 * moment it exists.
 */
function senderOf(event: IpcMainInvokeEvent): IpcSender {
  const frame = event.senderFrame
  return {
    isMainFrame: frame !== null && frame === event.sender.mainFrame,
    isOwnWindow: BrowserWindow.fromWebContents(event.sender) !== null,
  }
}

const trusted = (sender: IpcSender): boolean => sender.isMainFrame && sender.isOwnWindow

app.on('window-all-closed', () => {
  // Not on macOS, where an app with no windows is still running by convention.
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopFreshnessClock?.()
  stopFreshnessClock = null
  // Before the service closes, so a poll cannot be armed into a set of
  // databases that are about to be shut.
  stopPolling?.()
  stopPolling = null
  // The window's own `close` handler has already flushed the last position
  // synchronously; this only cancels a timer that would fire into a closing
  // service.
  stopWindowTracking?.()
  stopWindowTracking = null

  const running = service
  service = null
  // Fire and forget: `before-quit` cannot be awaited, and everything that must
  // happen — removing the handshake — is synchronous inside `close`.
  void running?.close()
})

function fatal(e: unknown): void {
  // Nothing to show it in yet: the window is created at the end of `main`, so a
  // failure here means there is no renderer to report into.
  console.error('Ground Control could not start:', e)
  app.exit(1)
}
