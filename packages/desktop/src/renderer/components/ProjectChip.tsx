import type { CSSProperties, ReactElement } from 'react'

/**
 * The project chip, and what happens past six projects (T136 — FR-080).
 *
 * The palette has six entries. A seventh project does not get a seventh colour
 * invented for it: it falls back to a neutral chip carrying only its 3–4
 * character code (decision 8). Identity degrades to the label, which the design
 * system already requires to work alone at 16px — so nothing is lost that was
 * ever being relied on.
 *
 * The alternative, generating a colour from a hash of the project id, is worse
 * in a way that only shows up later: it produces colours that collide with the
 * severity roles, and a project whose chip happens to land on `--critical` red
 * makes every one of its rows read as urgent.
 *
 * Assignment is by *position in the sorted project list*, not by hash, so it is
 * stable across restarts and identical on every machine — a screenshot in a
 * pull request shows the colours a colleague will see.
 */

export const PALETTE_SIZE = 6

export interface ProjectChipProps {
  projectId: string
  /** Short display code. Trimmed to four characters, which is what the slot fits. */
  code: string
  /**
   * Index in the sorted project list. `-1`, or anything past the palette, gets
   * the neutral chip.
   */
  paletteIndex: number
  name?: string
}

export function ProjectChip({
  projectId,
  code,
  paletteIndex,
  name,
}: ProjectChipProps): ReactElement {
  const withinPalette = paletteIndex >= 0 && paletteIndex < PALETTE_SIZE
  const label = code.slice(0, 4).toUpperCase()

  return (
    <span
      className="project-chip"
      data-project={projectId}
      data-neutral={!withinPalette}
      // React types have no notion of a custom property, so the cast is the
      // whole of the workaround. The value is a token reference, not a colour:
      // the chip still resolves through the palette and still swaps with the
      // theme.
      style={
        withinPalette
          ? ({ '--chip': `var(--p${paletteIndex + 1})` } as CSSProperties)
          : undefined
      }
      title={name ?? projectId}
    >
      {label}
    </span>
  )
}

/**
 * Which palette entry a project gets.
 *
 * `colorIndex` on the project is authoritative when the operator has set one —
 * they have said "this project is the blue one" and nothing here should argue.
 * Otherwise it falls out of the project's position in the sorted list, which is
 * stable across restarts and identical on every machine, so a screenshot in a
 * pull request shows the colours a colleague will see.
 *
 * Taking the whole list rather than one id is deliberate: the fallback depends
 * on the others, and a function given only the id would have to guess — which is
 * how the same project ends up two different colours in two panels.
 */
export function paletteIndexOf(
  project: { id: string; colorIndex: number | null },
  allProjectIds: readonly string[],
): number {
  if (project.colorIndex !== null) return project.colorIndex
  return [...allProjectIds].sort().indexOf(project.id)
}
