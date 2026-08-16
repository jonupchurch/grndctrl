/**
 * Where the window was, and whether it stays on top (T154, T176 — FR-082).
 *
 * `windowGeometry` has been in the settings schema since M2 and nothing has
 * ever written it or read it. That is the same shape as most of the defects
 * this project has produced: a field both halves agree about that nothing
 * connects. This is the connection.
 *
 * Nothing here imports Electron. The two functions take the facts they need —
 * the saved settings, the displays as the OS currently reports them, a window
 * with four methods — so the rules can be exercised over an unplugged monitor
 * and a maximised window in a plain unit test. `index.ts` supplies the real
 * ones.
 */

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayLike {
  /** The usable area, excluding the taskbar. Bounds would put a window under it. */
  workArea: Rectangle
}

export interface SavedWindowState {
  windowGeometry: Rectangle | null
  alwaysOnTop: boolean
}

export interface PlacementInput {
  saved: Rectangle | null
  displays: readonly DisplayLike[]
  primary: DisplayLike
  /**
   * `GRNDCTRL_DISPLAY`, 1-based, or undefined.
   *
   * It wins over the saved position when set, because it is an instruction
   * about *this* launch and the saved position is a record of the last one.
   * Someone who typed it meant it.
   */
  requestedDisplay?: number | undefined
}

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 860

/**
 * How much of the window has to be on a screen for the position to be usable.
 *
 * Not "any overlap": a window one pixel onto a display is functionally lost,
 * and not "fully contained" either, because a window deliberately hanging off
 * the right edge is a normal thing to have done and restoring it slightly moved
 * is worse than leaving it. The titlebar is the part that must be reachable,
 * so the test is on a band across the top rather than on area.
 */
const VISIBLE_MARGIN = 80

export function placement(input: PlacementInput): Rectangle {
  if (input.requestedDisplay !== undefined) {
    const display = input.displays[input.requestedDisplay - 1]
    // Out of range falls back rather than failing — the number of displays
    // changes when someone unplugs a laptop, and the variable outlives the dock.
    if (display !== undefined) return centred(display.workArea)
  }

  if (input.saved !== null && reachable(input.saved, input.displays)) return input.saved

  return centred(input.primary.workArea)
}

/**
 * Is the window's titlebar somewhere the operator can actually grab it?
 *
 * The case this exists for: the window was last closed on a second monitor that
 * is no longer attached. Restoring those coordinates opens it at, say, x=2400
 * on a single-screen laptop — running, focused, receiving keystrokes, and
 * invisible. There is no way to recover from that inside the application.
 */
function reachable(saved: Rectangle, displays: readonly DisplayLike[]): boolean {
  const top = {
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: Math.min(VISIBLE_MARGIN, saved.height),
  }

  return displays.some((display) => overlapArea(top, display.workArea) > 0)
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function centred(area: Rectangle): Rectangle {
  const width = Math.min(DEFAULT_WIDTH, area.width)
  const height = Math.min(DEFAULT_HEIGHT, area.height)

  return {
    width,
    height,
    // Centred within *this* display's work area. Electron's `center: true`
    // centres on the primary one, which is the whole thing being avoided.
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  }
}

/** The half of `BrowserWindow` this module touches. */
export interface TrackableWindow {
  on(event: 'resize' | 'move' | 'close', listener: () => void): unknown
  getBounds(): Rectangle
  isMaximized(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  isDestroyed(): boolean
}

export interface TrackOptions {
  window: TrackableWindow
  /** Persist. Failures are swallowed by the caller — see `index.ts`. */
  save(geometry: Rectangle): void
  /** Overridden in tests so the debounce does not need a real clock. */
  debounceMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Remember where the window is, without writing to SQLite on every frame.
 *
 * `resize` fires continuously during a drag — a hundred events for one gesture,
 * each of which would be a database write. So the write is debounced, and the
 * `close` handler flushes synchronously: the last gesture before quitting is
 * exactly the one an operator expects to be remembered, and it is the one a
 * pending timer would lose.
 *
 * **A maximised, minimised or full-screen window is not saved.** Its bounds are
 * the screen, and restoring them produces a window that fills the display but
 * is not maximised — subtly wrong in a way that is hard to undo, because the
 * remembered "restore" size has been overwritten with the screen size.
 */
export function trackWindowState(options: TrackOptions): () => void {
  const window = options.window
  const wait = options.debounceMs ?? 400
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never))

  let pending: unknown = null

  const capture = (): void => {
    if (window.isDestroyed()) return
    if (window.isMaximized() || window.isMinimized() || window.isFullScreen()) return
    options.save(window.getBounds())
  }

  const schedule = (): void => {
    if (pending !== null) clearTimer(pending)
    pending = setTimer(() => {
      pending = null
      capture()
    }, wait)
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('close', () => {
    if (pending !== null) {
      clearTimer(pending)
      pending = null
    }
    capture()
  })

  return () => {
    if (pending !== null) {
      clearTimer(pending)
      pending = null
    }
  }
}
