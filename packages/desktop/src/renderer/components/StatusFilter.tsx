import { useEffect, useId, useRef, useState, type ReactElement } from 'react'

/**
 * The Status heading's show/hide dropdown.
 *
 * **A dropdown here and not beside the lane**, and that is the argument `sort.ts`
 * makes about sorting, applied to filtering: the control sits on the column it
 * narrows, so what is hidden and where it was hidden from are the same place on
 * screen.
 *
 * **The list is the statuses the lane actually holds**, plus any hidden one that
 * has since left it. A fixed list would need to know the site's workflow, which
 * nothing here does; a list built only from what is visible would make a hidden
 * status impossible to bring back, because hiding it removes it from the lane.
 *
 * **The trigger says when something is hidden.** A lane with rows missing and no
 * sign of why reads as a sync that lost tickets, so the button carries the count
 * and the accent colour whenever the filter is doing anything.
 */

export interface StatusFilterProps {
  /** Every status name on the lane before filtering, with how many rows carry it. */
  statuses: readonly { name: string; count: number }[]
  hidden: ReadonlySet<string>
  onToggle(name: string): void
  onShowAll(): void
}

export function StatusFilter({ statuses, hidden, onToggle, onShowAll }: StatusFilterProps): ReactElement {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const menuId = useId()

  // Closed by a press anywhere else, or by Escape — the two ways every other
  // dropdown the operator uses closes, so neither has to be discovered.
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A hidden status no longer on the lane still gets a row, at zero, so it can
  // be shown again.
  const gone = [...hidden]
    .filter((name) => !statuses.some((s) => s.name === name))
    .map((name) => ({ name, count: 0 }))
  const options = [...statuses, ...gone].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
  const hiddenCount = options.filter((o) => hidden.has(o.name)).length

  return (
    <span className="status-filter" ref={root}>
      <button
        type="button"
        className="status-filter__trigger"
        data-active={hiddenCount > 0 ? 'true' : 'false'}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={
          hiddenCount === 0
            ? 'Filter statuses'
            : `Filter statuses, ${hiddenCount} hidden`
        }
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">{hiddenCount > 0 ? `▾${hiddenCount}` : '▾'}</span>
      </button>

      {open && (
        <div className="status-filter__menu" id={menuId} role="group" aria-label="Show statuses">
          {options.map((option) => (
            <label key={option.name} className="status-filter__option">
              <input
                type="checkbox"
                checked={!hidden.has(option.name)}
                onChange={() => onToggle(option.name)}
              />
              <span className="status-filter__name">{option.name}</span>
              <span className="status-filter__count" aria-label={`${option.count} tickets`}>
                {option.count}
              </span>
            </label>
          ))}

          <button
            type="button"
            className="status-filter__all"
            disabled={hiddenCount === 0}
            onClick={onShowAll}
          >
            Show all
          </button>
        </div>
      )}
    </span>
  )
}
