import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, DriftFinding, Project, WorkItem } from './types.js'

/**
 * Project selection is a filter, not navigation (T138 — FR-070).
 *
 * The distinction is the whole shape of the product. Navigation would mean a
 * project *page*: a URL, a back button, a loading state, and a moment where the
 * other projects do not exist. This is one page, and selecting a project narrows
 * what is on it — so the operator never loses the thing they were looking at,
 * and "all my work" and "just this repo" are the same screen.
 *
 * The filter is applied **in the renderer, over data already fetched**, and that
 * is deliberate rather than lazy. Every operation accepts a `projectId`, so
 * filtering server-side was available; doing it here means selecting a project
 * is a re-render rather than four round trips and four loading states, and the
 * counts in the tiles cannot briefly disagree with the lanes beneath them
 * because they all narrow from one snapshot. It also makes SC-013 — 200 work
 * items across 6 projects, filtered in under 100ms — a property of an array
 * operation rather than of SQLite plus IPC.
 *
 * When the filter narrows to exactly one project, the header gains that
 * project's links (FR-070). That is the only thing selection changes besides
 * what is visible.
 */

export interface Filter {
  /** `null` means every project, which is the default and the common case. */
  projectId: string | null
  /** True when the operator's-court tile is toggled on (FR-073). */
  mineOnly: boolean
  select(projectId: string | null): void
  toggleMine(): void
  /** The one project when narrowed to one, otherwise `null`. */
  only: Project | null
}

export interface FilterOptions {
  /** From `settings.get`. Absent until it has been read. */
  saved?: { activeProjectId: string | null; mineOnly: boolean } | undefined
  /** Called on every change, so the filter survives a restart (T154, FR-082). */
  persist?: ((patch: { activeProjectId?: string | null; mineOnly?: boolean }) => void) | undefined
}

export function useFilter(projects: readonly Project[], options: FilterOptions = {}): Filter {
  const [projectId, setProjectId] = useState<string | null>(null)
  const [mineOnly, setMineOnly] = useState(false)
  const persist = options.persist
  const savedProject = options.saved?.activeProjectId
  const savedMine = options.saved?.mineOnly

  /**
   * Whether the operator has pressed anything yet.
   *
   * The settings read is asynchronous and the board is interactive before it
   * lands, so without this a chip pressed in the first few hundred milliseconds
   * is silently undone by the saved value arriving. A ref rather than state
   * because nothing renders differently for it.
   */
  const touched = useRef(false)

  useEffect(() => {
    if (touched.current) return
    if (savedMine !== undefined) setMineOnly(savedMine)
    if (savedProject === undefined) return

    // A project the operator has since removed must not come back as a filter:
    // it would narrow the board to nothing with no chip pressed to explain why,
    // which reads as an empty board rather than as a filter.
    setProjectId(
      savedProject !== null && !projects.some((p) => p.id === savedProject) ? null : savedProject,
    )
  }, [savedProject, savedMine, projects])

  const select = useCallback(
    (next: string | null) => {
      touched.current = true
      setProjectId((current) => {
        const resolved = current === next ? null : next
        persist?.({ activeProjectId: resolved })
        return resolved
      })
    },
    [persist],
  )

  const toggleMine = useCallback(() => {
    touched.current = true
    setMineOnly((v) => {
      persist?.({ mineOnly: !v })
      return !v
    })
  }, [persist])

  const only = useMemo(
    () => (projectId === null ? null : (projects.find((p) => p.id === projectId) ?? null)),
    [projectId, projects],
  )

  return { projectId, mineOnly, select, toggleMine, only }
}

export function filterWork(items: readonly WorkItem[], filter: Filter): WorkItem[] {
  return items.filter((item) => {
    if (filter.projectId !== null && item.projectId !== filter.projectId) return false
    if (filter.mineOnly && item.ballInCourt !== 'you') return false
    return true
  })
}

export function filterFindings(
  findings: readonly DriftFinding[],
  filter: Filter,
): DriftFinding[] {
  // Drift is deliberately *not* narrowed by `mineOnly`. A disagreement between
  // two systems is not in anyone's court until someone looks at it, and hiding
  // it behind a "mine" toggle is how it stays unlooked-at.
  return findings.filter((f) => filter.projectId === null || f.projectId === filter.projectId)
}

export function filterSessions(
  sessions: readonly AgentSession[],
  filter: Filter,
): AgentSession[] {
  return sessions.filter((s) => filter.projectId === null || s.projectId === filter.projectId)
}

/**
 * Counts recomputed from the filtered set.
 *
 * `board.summary` returns the same numbers for the unfiltered board, and using
 * it while the lanes are filtered would put a "12" above a list of three. The
 * tiles and the lanes narrow from one snapshot or they disagree.
 */
export function summarise(
  items: readonly WorkItem[],
  findings: readonly DriftFinding[],
  sessions: readonly AgentSession[],
): { yourCourt: number; drifting: number; stalled: number; agentsLive: number } {
  return {
    yourCourt: items.filter((i) => i.ballInCourt === 'you').length,
    // Distinct subjects, not findings: two rules firing on one ticket is one
    // thing to go and look at, and counting it twice overstates the problem.
    drifting: new Set(findings.map((f) => f.subjectKey)).size,
    stalled: items.filter((i) => i.staleness === 'stale' || i.staleness === 'abandoned').length,
    agentsLive: sessions.filter((s) => s.state === 'running' || s.state === 'needs-you').length,
  }
}
