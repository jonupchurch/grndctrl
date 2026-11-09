import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/**
 * Ticket tags (010): the coloured pill on a ticket row, and the menu that
 * picks one. The tags themselves are defined in Settings → Ticket tags.
 */

export interface TagDefinition {
  id: string
  label: string
  /** `#rrggbb`. */
  color: string
}

/**
 * Black or white, whichever reads on `hex`. The operator picks the colour, so
 * the text colour has to follow it — white on the default yellow is unreadable.
 */
export function tagInk(hex: string): '#000000' | '#ffffff' {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (m === null) return '#000000'
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => {
    const c = parseInt(h as string, 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // Above the strict equal-contrast crossover (0.179), on purpose: that puts
  // black on a saturated red or green, which reads as a warning label gone
  // wrong. White keeps at least 3:1 up to here, enough for short bold text.
  return luminance > 0.3 ? '#000000' : '#ffffff'
}

export function tagStyle(color: string): CSSProperties {
  return { '--tag': color, '--tag-ink': tagInk(color) } as CSSProperties
}

/** The pill, as a button that opens the picker. */
export function TagPill({
  tag,
  issueKey,
  onPick,
}: {
  tag: TagDefinition
  issueKey: string
  onPick(anchor: DOMRect): void
}): ReactElement {
  return (
    <button
      type="button"
      className="row__tag"
      data-tag={tag.id}
      style={tagStyle(tag.color)}
      // Stopped so the row does not also open the ticket in the browser.
      onClick={(event) => {
        event.stopPropagation()
        onPick(event.currentTarget.getBoundingClientRect())
      }}
      aria-label={`Tagged ${tag.label}. Change the tag on ${issueKey}`}
      title="Change the tag"
    >
      {tag.label}
    </button>
  )
}

/** The quiet control on an untagged row, in the trailing slot. */
export function TagAdd({
  issueKey,
  onPick,
}: {
  issueKey: string
  onPick(anchor: DOMRect): void
}): ReactElement {
  return (
    <button
      type="button"
      className="row__tag-add"
      onClick={(event) => {
        event.stopPropagation()
        onPick(event.currentTarget.getBoundingClientRect())
      }}
      aria-label={`Tag ${issueKey}`}
      title="Add a tag"
    >
      <span aria-hidden="true">#</span>
    </button>
  )
}

/**
 * The picker. Portalled to the body and placed under its anchor with fixed
 * positioning, because the title cell it opens from clips its overflow.
 */
export function TagMenu({
  anchor,
  issueKey,
  tags,
  current,
  onPick,
  onClose,
}: {
  anchor: DOMRect
  issueKey: string
  tags: readonly TagDefinition[]
  current: string | null
  onPick(tagId: string | null): void
  onClose(): void
}): ReactElement {
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    const onDown = (event: MouseEvent): void => {
      if (menu.current !== null && !menu.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  // Flipped above the anchor when there is no room below it.
  const below = anchor.bottom + 4
  const roomBelow = window.innerHeight - below > 40 + tags.length * 30
  const style: CSSProperties = roomBelow
    ? { top: below, left: anchor.left }
    : { bottom: window.innerHeight - anchor.top + 4, left: anchor.left }

  return createPortal(
    <div
      ref={menu}
      className="tag-menu"
      role="menu"
      aria-label={`Tag for ${issueKey}`}
      style={style}
    >
      {tags.length === 0 && (
        <p className="tag-menu__empty">No tags defined. Add some in Settings.</p>
      )}
      {tags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          role="menuitemradio"
          aria-checked={tag.id === current}
          className="tag-menu__item"
          onClick={() => onPick(tag.id)}
        >
          <span className="tag-menu__swatch" style={tagStyle(tag.color)} aria-hidden="true" />
          {tag.label}
        </button>
      ))}
      {current !== null && (
        <button
          type="button"
          role="menuitem"
          className="tag-menu__item tag-menu__clear"
          onClick={() => onPick(null)}
        >
          Remove tag
        </button>
      )}
    </div>,
    document.body,
  )
}
