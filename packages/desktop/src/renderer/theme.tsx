import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { call } from './bridge.js'

/**
 * Appearance and density (T130, T131 — FR-078, FR-079).
 *
 * Both are three-state-ish in the same way and for the same reason. Appearance
 * is `system | light | dark`, and `system` is not a synonym for "whichever one
 * we computed at startup" — it is a standing instruction to follow the OS,
 * including when the operator changes it at 6pm without restarting anything. So
 * the choice is stored, the *resolution* is not, and `data-theme` is only
 * stamped when there is an explicit override. With no override the CSS media
 * query decides, which means the OS switching themes needs no JavaScript at all.
 *
 * Density is simpler — there is no system preference for it — but it is kept
 * next to appearance because they are one settings row to the operator and one
 * attribute on `:root` to the stylesheet.
 *
 * Both are persisted through `settings.update`, so they survive a restart
 * (FR-082) and are the same on every window.
 */

export type Appearance = 'system' | 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

interface ThemeValue {
  appearance: Appearance
  density: Density
  setAppearance(next: Appearance): void
  setDensity(next: Density): void
  /** What is actually on screen right now, after resolving `system`. */
  resolved: 'light' | 'dark'
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (value === null) throw new Error('useTheme was called outside ThemeProvider.')
  return value
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [appearance, setAppearanceState] = useState<Appearance>('system')
  const [density, setDensityState] = useState<Density>('comfortable')
  const [systemDark, setSystemDark] = useState(() => prefersDark())

  // Settings live in the authored store, so they are read once at startup rather
  // than kept in the renderer. A failure here is deliberately silent: the
  // defaults above are usable, and a modal about a theme preference on first
  // paint would be worse than the wrong theme.
  useEffect(() => {
    let live = true

    void call('settings.get')
      .then((data) => {
        if (!live) return
        const settings = data as { appearance?: Appearance; density?: Density }
        if (settings.appearance !== undefined) setAppearanceState(settings.appearance)
        if (settings.density !== undefined) setDensityState(settings.density)
      })
      .catch(() => undefined)

    return () => {
      live = false
    }
  }, [])

  // Only matters while appearance is `system`, but subscribing unconditionally
  // keeps `systemDark` correct for the moment someone switches back to it.
  useEffect(() => {
    const query = globalThis.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    // Absent, not `data-theme="system"`. The stylesheet's media query is what
    // follows the OS, and it can only do that when nothing overrides it.
    if (appearance === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', appearance)
  }, [appearance])

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density)
  }, [density])

  const setAppearance = useCallback((next: Appearance) => {
    setAppearanceState(next)
    void call('settings.update', { appearance: next }).catch(() => undefined)
  }, [])

  const setDensity = useCallback((next: Density) => {
    setDensityState(next)
    void call('settings.update', { density: next }).catch(() => undefined)
  }, [])

  const resolved = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance

  return (
    <ThemeContext.Provider value={{ appearance, density, setAppearance, setDensity, resolved }}>
      {children}
    </ThemeContext.Provider>
  )
}

function prefersDark(): boolean {
  return globalThis.matchMedia('(prefers-color-scheme: dark)').matches
}
