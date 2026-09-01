import type { Page } from '@playwright/test'

/**
 * Whether a cell is drawing all of its text, measured the only way that works.
 *
 * The obvious reading is `scrollWidth > clientWidth`, and **it is blind to the
 * failure it would be written for**. Both are integers. A 115px cell holding a
 * 115.2px string reports 115 and 115, so the check passes while the screen
 * shows an ellipsis — which is exactly what happened here: `no ticket key is
 * cut off` went green over a lane whose every key was visibly cut off, and the
 * screenshot is what caught it, not the suite.
 *
 * So the text is measured at its natural width instead. The cell is cloned into
 * its own parent with `width: max-content` and no clipping, which asks the same
 * layout engine, in the same font and the same inherited styles, how wide the
 * string wants to be. Sub-pixel, and directly comparable to the cell's own
 * bounding rect.
 */
export interface Fit {
  text: string
  /** The width the cell has. */
  box: number
  /** The width the text wants. Greater than `box` means an ellipsis. */
  natural: number
}

export async function fitOf(page: Page, selector: string): Promise<Fit[]> {
  return page.evaluate((query) => {
    return Array.from(document.querySelectorAll(query)).map((cell) => {
      const clone = cell.cloneNode(true) as HTMLElement
      clone.style.position = 'absolute'
      clone.style.width = 'max-content'
      clone.style.maxWidth = 'none'
      clone.style.overflow = 'visible'
      // Out of the way of anything that measures the page, and never painted.
      clone.style.visibility = 'hidden'
      clone.style.pointerEvents = 'none'

      const host = cell.parentElement
      host?.appendChild(clone)
      const natural = clone.getBoundingClientRect().width
      clone.remove()

      return {
        text: cell.textContent ?? '',
        box: cell.getBoundingClientRect().width,
        natural,
      }
    })
  }, selector)
}
