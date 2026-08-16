import { describe, expect, it } from 'vitest'
import {
  placement,
  trackWindowState,
  type DisplayLike,
  type Rectangle,
  type TrackableWindow,
} from '../src/main/persistence.js'

/**
 * Where the window opens, and when its position is worth writing down (T154).
 *
 * These are exactly the rules that are impossible to check by using the
 * application: reproducing "the monitor it was last on is no longer attached"
 * means unplugging a monitor, and reproducing "do not save a maximised window's
 * bounds" means noticing, a week later, that restore no longer restores. Both
 * are one line of arithmetic here.
 */

const laptop: DisplayLike = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const second: DisplayLike = { workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }

describe('placement', () => {
  it('opens centred on the primary display when nothing has been saved', () => {
    const bounds = placement({ saved: null, displays: [laptop], primary: laptop })

    expect(bounds).toEqual({ x: 320, y: 90, width: 1280, height: 860 })
  })

  it('reopens exactly where the operator left it', () => {
    const saved: Rectangle = { x: 2100, y: 120, width: 1400, height: 900 }

    expect(placement({ saved, displays: [laptop, second], primary: laptop })).toEqual(saved)
  })

  it('refuses a position on a display that is no longer attached', () => {
    // The dock is gone; the saved position is 180px past the right edge of the
    // only screen there is. Restoring it produces a window that is running,
    // focused, taking keystrokes, and invisible — with nothing inside the
    // application able to recover it.
    const saved: Rectangle = { x: 2100, y: 120, width: 1400, height: 900 }

    expect(placement({ saved, displays: [laptop], primary: laptop })).toEqual({
      x: 320,
      y: 90,
      width: 1280,
      height: 860,
    })
  })

  it('keeps a window deliberately hanging off an edge', () => {
    // Half off the right side is a thing people do on purpose, and moving it
    // back is more annoying than leaving it. The test is whether the titlebar
    // is grabbable, not whether the window is fully contained.
    const saved: Rectangle = { x: 1300, y: 40, width: 1200, height: 800 }

    expect(placement({ saved, displays: [laptop], primary: laptop })).toEqual(saved)
  })

  it('refuses a position whose titlebar is above the top of every screen', () => {
    // Dragged under a menu bar that has since moved, or restored from a display
    // arrangement with a screen above this one. The body overlaps; the part you
    // grab does not.
    const saved: Rectangle = { x: 200, y: -400, width: 1200, height: 800 }

    expect(placement({ saved, displays: [laptop], primary: laptop }).y).toBe(90)
  })

  it('lets GRNDCTRL_DISPLAY override the saved position, because it was typed', () => {
    const saved: Rectangle = { x: 100, y: 100, width: 1200, height: 800 }
    const bounds = placement({
      saved,
      displays: [laptop, second],
      primary: laptop,
      requestedDisplay: 2,
    })

    expect(bounds.x).toBeGreaterThanOrEqual(1920)
  })

  it('falls back rather than failing when that display was unplugged', () => {
    const bounds = placement({
      saved: null,
      displays: [laptop],
      primary: laptop,
      requestedDisplay: 2,
    })

    expect(bounds).toEqual({ x: 320, y: 90, width: 1280, height: 860 })
  })

  it('fits the default size to a display smaller than it', () => {
    const small: DisplayLike = { workArea: { x: 0, y: 0, width: 1024, height: 700 } }
    const bounds = placement({ saved: null, displays: [small], primary: small })

    expect(bounds).toEqual({ x: 0, y: 0, width: 1024, height: 700 })
  })
})

/** A window that records what was asked of it, with no Electron behind it. */
function fakeWindow(state: Partial<Record<'maximized' | 'minimized' | 'full' | 'destroyed', boolean>> = {}) {
  const listeners = new Map<string, () => void>()
  let bounds: Rectangle = { x: 10, y: 20, width: 800, height: 600 }

  const window: TrackableWindow = {
    on: (event, listener) => listeners.set(event, listener),
    getBounds: () => bounds,
    isMaximized: () => state.maximized === true,
    isMinimized: () => state.minimized === true,
    isFullScreen: () => state.full === true,
    isDestroyed: () => state.destroyed === true,
  }

  return {
    window,
    fire: (event: string) => listeners.get(event)?.(),
    move: (next: Rectangle) => {
      bounds = next
    },
  }
}

/** A timer that only runs when told to, so the debounce needs no real clock. */
function fakeTimers() {
  let queued: (() => void) | null = null
  return {
    setTimer: (fn: () => void) => {
      queued = fn
      return 1
    },
    clearTimer: () => {
      queued = null
    },
    run: () => {
      const fn = queued
      queued = null
      fn?.()
    },
    get pending() {
      return queued !== null
    },
  }
}

describe('trackWindowState', () => {
  it('writes once for a drag, not once per frame', () => {
    const saved: Rectangle[] = []
    const w = fakeWindow()
    const timers = fakeTimers()

    trackWindowState({ window: w.window, save: (g) => saved.push(g), ...timers })

    // One gesture. Electron emits these continuously — a hundred for a slow
    // drag, each of which would otherwise be a write to SQLite.
    for (let i = 0; i < 50; i++) w.fire('resize')
    expect(saved).toHaveLength(0)

    timers.run()
    expect(saved).toHaveLength(1)
  })

  it('flushes the last position on close rather than losing it to a pending timer', () => {
    const saved: Rectangle[] = []
    const w = fakeWindow()
    const timers = fakeTimers()

    trackWindowState({ window: w.window, save: (g) => saved.push(g), ...timers })

    w.move({ x: 500, y: 300, width: 1000, height: 700 })
    w.fire('move')
    // Quitting right after moving the window is the most ordinary thing there
    // is, and it is exactly when a debounce would throw the move away.
    w.fire('close')

    expect(saved).toEqual([{ x: 500, y: 300, width: 1000, height: 700 }])
    expect(timers.pending).toBe(false)
  })

  it('does not save a maximised window, whose bounds are the screen', () => {
    const saved: Rectangle[] = []
    const w = fakeWindow({ maximized: true })
    const timers = fakeTimers()

    trackWindowState({ window: w.window, save: (g) => saved.push(g), ...timers })
    w.fire('resize')
    timers.run()

    // Saving them produces a window that fills the display and is not
    // maximised, and the restore size the operator actually wants has been
    // overwritten with the screen size — which cannot be undone from inside.
    expect(saved).toEqual([])
  })

  it('does not save a minimised or full-screen window either', () => {
    for (const state of [{ minimized: true }, { full: true }]) {
      const saved: Rectangle[] = []
      const w = fakeWindow(state)
      const timers = fakeTimers()

      trackWindowState({ window: w.window, save: (g) => saved.push(g), ...timers })
      w.fire('move')
      timers.run()

      expect(saved).toEqual([])
    }
  })

  it('does not read the bounds of a window that has gone', () => {
    const saved: Rectangle[] = []
    const w = fakeWindow({ destroyed: true })
    const timers = fakeTimers()

    trackWindowState({ window: w.window, save: (g) => saved.push(g), ...timers })
    w.fire('resize')
    timers.run()

    expect(saved).toEqual([])
  })

  it('cancels a pending write when tracking stops', () => {
    const saved: Rectangle[] = []
    const w = fakeWindow()
    const timers = fakeTimers()

    const stop = trackWindowState({ window: w.window, save: (g) => saved.push(g), ...timers })
    w.fire('resize')
    stop()
    timers.run()

    expect(saved).toEqual([])
  })
})
