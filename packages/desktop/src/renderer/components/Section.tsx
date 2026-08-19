import type { ReactElement, ReactNode } from 'react'
import { useRegions } from '../regions.js'

/**
 * The collapsible shell every region on the board sits in (T101 — FR-143).
 *
 * Applied to the five regions 006 leaves before the four new ones are built, so
 * they inherit it rather than being retrofitted — and so the decision below gets
 * tested against the board that already exists.
 *
 * ## Collapsed means **not rendered**, not hidden
 *
 * The tempting implementation is `display: none`, and it is wrong here for a
 * reason specific to this repository: `perf.spec.ts` and `greyscale.spec.ts`
 * both count elements, and `document.querySelectorAll` sees a hidden element
 * exactly as well as a visible one. A folded ticket lane implemented with CSS
 * would leave two hundred rows in the tree, so the performance budget would be
 * measured against work the operator had explicitly asked not to do, and the
 * greyscale count would keep passing over rows nobody can see. This project has
 * already had that shape of bug once, with `lane__headings` counting as a row.
 *
 * So the children are not rendered at all. The body element itself stays, empty,
 * because `aria-controls` must name an element that exists.
 *
 * ## What stays visible when it is folded
 *
 * The count and the freshness reading (FR-145). Folding a lane is "I am not
 * reading this now", not "stop telling me" — a lane that hid the fact that it
 * had failed to refresh would turn a fold into a way of not being told about a
 * broken connection, which is the one thing this board must never do (XIV).
 *
 * ## The control
 *
 * A real `<button>` carrying `aria-expanded` and `aria-controls`, so the state
 * is announced rather than conveyed by a rotated glyph. The glyph is there too,
 * and it is a *shape* change rather than a colour change, for the same reason
 * every severity mark is (FR-074).
 */

export interface SectionProps {
  /**
   * The persisted identity of this region.
   *
   * **A stable literal, never generated.** A generated id changes between
   * builds, so every region the operator had folded would quietly unfold on the
   * next launch and the stored map would fill with dead keys.
   */
  id: string
  /** The heading, and the accessible name of both the region and its toggle. */
  title: string
  /** Shown in the header whether folded or not. */
  count?: ReactNode
  /** A word about the region's own rules — a lane's staleness threshold. */
  meta?: ReactNode
  /** Freshness. Stays visible when folded, deliberately. */
  status?: ReactNode
  /**
   * The element class. `lane` and `court` are existing treatments; a region with
   * no class is unstyled, which is a visible mistake rather than a silent one.
   */
  className?: string
  /**
   * `region` for everything on the board; `status` for the connection notice,
   * which announces itself when it appears and must keep doing so.
   */
  role?: 'region' | 'status'
  /** Widens the row grid. Only the lanes with sprint, priority and points set it. */
  metrics?: boolean
  children: ReactNode
}

export function Section({
  id,
  title,
  count,
  meta,
  status,
  className,
  role = 'region',
  metrics,
  children,
}: SectionProps): ReactElement {
  const regions = useRegions()
  const collapsed = regions.isCollapsed(id)
  const bodyId = `region-${id}`

  return (
    <section
      className={className}
      aria-label={title}
      data-region={id}
      data-collapsed={collapsed}
      {...(role === 'status' ? { role: 'status' } : {})}
      {...(metrics === undefined ? {} : { 'data-metrics': metrics })}
    >
      <header className="lane__head">
        <button
          type="button"
          className="section__toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => regions.toggle(id)}
        >
          {/* Two different glyphs rather than one rotated with CSS: a rotation
              is invisible in a screenshot diff and survives `transform: none`,
              and this mark is the only visual indication of state. */}
          <span className="section__marker" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          {title}
        </button>

        {count === undefined ? null : <span className="lane__count">{count}</span>}
        {meta === undefined ? null : <span className="lane__threshold">{meta}</span>}
        {status}
      </header>

      {/* Always present, empty when folded. `aria-controls` naming an element
          that does not exist is a dangling reference, and a screen reader
          following it lands nowhere. */}
      <div id={bodyId} className="section__body">
        {collapsed ? null : children}
      </div>
    </section>
  )
}
