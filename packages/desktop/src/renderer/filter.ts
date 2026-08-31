import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, Project, TicketHistoryEntry, WorkItem } from './types.js'

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

export function filterSessions(
  sessions: readonly AgentSession[],
  filter: Filter,
): AgentSession[] {
  return sessions.filter((s) => filter.projectId === null || s.projectId === filter.projectId)
}

/**
 * The ticket history, narrowed by the same project chips (FR-070).
 *
 * ## Why this one cannot filter on `projectId`
 *
 * Every other list on the board carries the project it belongs to, because every
 * other list is a projection of the mirror and the mirror holds the binding. A
 * history entry outlives the mirrored ticket by design (008/FR-149) — it is
 * written *because* the work finished, and a finished ticket stops being
 * assigned to the operator and leaves the mirror on the next sync. So the join
 * that would give it a `projectId` is exactly the join that is gone by the time
 * anybody reads one, and filtering on it would empty the region for old entries
 * and keep the new ones: the opposite of what the chip means.
 *
 * What survives on the entry is its own key, and the issue key derived from it
 * — `MERC-1184`. A Jira project key is the part before the last dash and a
 * project binds exactly one of them, so the chip narrows on that.
 *
 * **This is the one place in the renderer that reads a key's contents.** It is
 * the same exception `issueKeyOfTicketKey` names in core, one level down: the
 * service already parsed `jira:<site>/<ISSUE>` and handed over the issue key, so
 * nothing here touches the natural key itself.
 *
 * **The site is not checked**, and two projects on two Jira sites sharing a
 * project key would show each other's history. Both would have to be configured
 * here, and neither the entry nor `Project` carries a site the renderer can see
 * — `jiraConnectionId` names a connection, not a host. Named rather than fixed:
 * the failure is a few extra rows in a narrowed region, and the alternative is
 * plumbing a site through two layers for a board nobody has.
 *
 * `mineOnly` deliberately does **not** apply. "Your court" is a fact about a
 * ticket that is still moving; every entry here is about work that is finished
 * and therefore in nobody's court, so honouring the toggle would empty the
 * region every time the operator narrowed to their own work — reading as "you
 * have no history" rather than as a filter.
 */
export function filterHistory(
  entries: readonly TicketHistoryEntry[],
  filter: Filter,
): TicketHistoryEntry[] {
  if (filter.projectId === null) return [...entries]

  const key = filter.only?.jiraProjectKey ?? null
  // A project with no Jira project key has no tickets either, so its ticket lane
  // is empty for the same reason. Returning everything instead would make the
  // one chip that narrows nothing look like the chip that was not pressed.
  if (key === null) return []

  const prefix = `${key.toUpperCase()}-`

  return entries.filter((entry) => entry.issueKey?.toUpperCase().startsWith(prefix) === true)
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
  sessions: readonly AgentSession[],
): { yourCourt: number; stalled: number; agentsLive: number } {
  return {
    yourCourt: items.filter((i) => i.ballInCourt === 'you').length,
    stalled: items.filter((i) => i.staleness === 'stale' || i.staleness === 'abandoned').length,
    agentsLive: sessions.filter((s) => s.state === 'running' || s.state === 'needs-you').length,
  }
}
