import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'

/**
 * Which regions of the board are folded away (T102 — FR-143, FR-144).
 *
 * The board is about to have seven regions on it. Not all of them are wanted at
 * once, and the ones that are wanted differ by what the operator is doing —
 * mid-review, the ticket lane matters and the prompt history does not; mid-
 * handover it is the other way round. So each region folds, and the choice
 * survives a restart, because a preference that has to be re-set every launch is
 * one people stop setting.
 *
 * **Only collapsed regions are recorded.** The stored map is `{ prompts: true }`,
 * never `{ prompts: true, tickets: false }` — see `Settings.collapsedRegions`
 * for why that matters more than it looks.
 *
 * ## Why the state is here and not in each section
 *
 * A `Section` that owned its own `useState` would work and would lose the
 * choice on every re-mount, which happens whenever the board narrows to a
 * project. It would also have no way to persist without every caller wiring the
 * same write. So the state is one map at the top and the sections read it —
 * which is also what makes `App.tsx` able to say what the region ids *are*, in
 * one list, as literals.
 */

export interface Regions {
  isCollapsed(id: string): boolean
  toggle(id: string): void
}

/**
 * The default: everything open, and folding does nothing.
 *
 * A `Section` rendered outside a provider is a `Section` in a test harness or in
 * a screen that has not adopted this yet. Rendering it expanded is the honest
 * fallback — the alternative, a local `useState` here, would give a control that
 * appears to work and silently forgets, which is worse than one that visibly
 * does not.
 */
const RegionsContext = createContext<Regions>({
  isCollapsed: () => false,
  toggle: () => undefined,
})

export function RegionsProvider({
  value,
  children,
}: {
  value: Regions
  children: ReactNode
}): ReactElement {
  return <RegionsContext.Provider value={value}>{children}</RegionsContext.Provider>
}

export function useRegions(): Regions {
  return useContext(RegionsContext)
}

export interface RegionOptions {
  /** From `settings.get`. Absent until it has been read. */
  saved?: Readonly<Record<string, boolean>> | undefined
  /** Called on every change, so the choice survives a restart (FR-144). */
  persist?: ((patch: { collapsedRegions: Record<string, boolean> }) => void) | undefined
}

/**
 * The map, seeded from settings once and owned locally afterwards.
 *
 * Same shape as `useFilter` and for the same reason: the settings read is
 * asynchronous and the board is interactive before it lands, so a region folded
 * in the first few hundred milliseconds would otherwise be silently unfolded by
 * the saved value arriving. The `touched` ref is what stops that, and it is a
 * ref rather than state because nothing renders differently for it.
 */
export function useRegionState(options: RegionOptions = {}): Regions {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const persist = options.persist
  const saved = options.saved
  const touched = useRef(false)

  useEffect(() => {
    if (touched.current || saved === undefined) return
    setCollapsed({ ...saved })
  }, [saved])

  const toggle = useCallback(
    (id: string) => {
      touched.current = true
      setCollapsed((current) => {
        const next = { ...current }
        // Deleted rather than set to `false`. The stored map is "what is folded
        // away", so an expanded region has no entry — otherwise the map grows a
        // key for every region the operator has ever touched, and every renamed
        // region leaves a dead one behind.
        if (next[id] === true) delete next[id]
        else next[id] = true

        persist?.({ collapsedRegions: next })
        return next
      })
    },
    [persist],
  )

  return {
    isCollapsed: (id) => collapsed[id] === true,
    toggle,
  }
}
