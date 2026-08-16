import type { ReactElement } from 'react'
import { ProjectChip, paletteIndexOf } from './components/ProjectChip.js'
import type { Filter } from './filter.js'
import { launch } from './launch.js'
import type { FreshnessView } from './query.js'
import { useTheme, type Appearance } from './theme.js'
import type { Project } from './types.js'

/**
 * The header: identity, the project filter, freshness, and appearance.
 *
 * The project chips are a **filter, not navigation** (FR-070) — pressing one
 * narrows the page, pressing it again widens it back, and "All" is a chip like
 * the others rather than a special mode. When the filter narrows to exactly one
 * project the header gains that project's links, because at that point there is
 * an unambiguous answer to "where does this live?" and it is the one moment the
 * question has one.
 *
 * The freshness reading is the **worst** across the board, not an average, and
 * it is the provider's timestamp rather than the query cache's (XIV). "as of
 * 14:02" beside a board whose pull requests stopped refreshing at 09:00 would be
 * a lie told confidently.
 */

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export interface TitlebarProps {
  projects: readonly Project[]
  filter: Filter
  freshness: FreshnessView | null
  syncing: boolean
  /** T176. Absent until the setting has been read; the toggle waits rather than guessing. */
  alwaysOnTop?: boolean | undefined
  onToggleAlwaysOnTop?: (() => void) | undefined
  onRefresh(): void
  onOpenSettings(): void
}

export function Titlebar({
  projects,
  filter,
  freshness,
  syncing,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  onRefresh,
  onOpenSettings,
}: TitlebarProps): ReactElement {
  const theme = useTheme()
  const ids = projects.map((p) => p.id)

  return (
    <header className="titlebar">
      <span className="titlebar__mark" aria-hidden="true">
        {/* The tracking ring from the locked brand direction (1a). Inline
            because a `file:` page has no external SVG to fetch and the CSP
            would refuse one anyway. */}
        <svg width="16" height="16" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="9" stroke="currentColor" strokeWidth="5" />
          <circle cx="42" cy="24" r="6" fill="var(--accent)" />
        </svg>
      </span>
      {/* The page title, and an h1 because it is one. The board has no other
          heading above the lanes, so without this the document starts at h2 and
          a screen reader has nothing to announce the page as. */}
      <h1 className="titlebar__word">Ground Control</h1>

      <nav className="titlebar__projects" aria-label="Filter by project">
        <button
          type="button"
          className="chip-button"
          aria-pressed={filter.projectId === null}
          onClick={() => filter.select(null)}
        >
          All
        </button>

        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            className="chip-button"
            aria-pressed={filter.projectId === project.id}
            onClick={() => filter.select(project.id)}
          >
            <ProjectChip
              projectId={project.id}
              code={project.code}
              paletteIndex={paletteIndexOf(project, ids)}
              name={project.name}
            />
          </button>
        ))}
      </nav>

      {/* Only when narrowed to one. With two projects selected there is no
          single repository to link to, and a link that sometimes means one
          thing and sometimes another is worse than no link. */}
      {filter.only !== null && (
        <span className="titlebar__links">
          {filter.only.jiraProjectKey !== null && (
            <button type="button" onClick={() => void launch(`project:${filter.only?.id}`, 'ticket')}>
              {filter.only.jiraProjectKey}
            </button>
          )}
          {filter.only.repoOwner !== null && filter.only.repoName !== null && (
            <button
              type="button"
              onClick={() => void launch(`project:${filter.only?.id}`, 'repository')}
            >
              {filter.only.repoOwner}/{filter.only.repoName}
            </button>
          )}
          {filter.only.documentationUrl !== null && (
            <button
              type="button"
              onClick={() => void launch(`project:${filter.only?.id}`, 'documentation')}
            >
              Docs
            </button>
          )}
        </span>
      )}

      <span className="titlebar__spacer" />

      <span className="titlebar__freshness" data-state={freshness?.state ?? 'fresh'}>
        {describeAsOf(freshness)}
      </span>

      <button type="button" className="ghost" onClick={onRefresh} disabled={syncing}>
        {syncing ? 'Refreshing…' : 'Refresh'}
      </button>

      {/*
        Keep the window above everything else (T176).

        A toggle button with `aria-pressed` rather than a checkbox: it is the
        same control as the court tile and the project chips, it belongs to the
        same row as Refresh and Settings, and a lone checkbox in a titlebar of
        buttons would be a second idiom for the same gesture.

        It renders only once the setting has been read. Rendering it earlier
        would mean drawing it in an off state that might be wrong, and an
        operator seeing "off" and pressing it would turn a setting *off* that
        they had asked to be on.
      */}
      {alwaysOnTop !== undefined && onToggleAlwaysOnTop !== undefined && (
        <button
          type="button"
          className="ghost"
          aria-pressed={alwaysOnTop}
          onClick={onToggleAlwaysOnTop}
          title={
            alwaysOnTop
              ? 'Ground Control stays above other windows'
              : 'Keep Ground Control above other windows'
          }
        >
          {/* The label states the setting, not the action. "On top" beside a
              pressed state reads as what is true; "Keep on top" beside a
              pressed state reads as an instruction that has not happened. */}
          <span aria-hidden="true">{alwaysOnTop ? '▣' : '▢'}</span> On top
        </button>
      )}

      <div className="segmented" role="group" aria-label="Appearance">
        {APPEARANCES.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={theme.appearance === option.value}
            onClick={() => theme.setAppearance(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <button type="button" className="ghost" onClick={onOpenSettings}>
        Settings
      </button>
    </header>
  )
}

function describeAsOf(freshness: FreshnessView | null): string {
  if (freshness === null) return ''
  if (freshness.state === 'never') return 'never synced'
  if (freshness.state === 'failed') return 'refresh failed'
  if (freshness.lastSuccessAt === null) return 'never synced'

  return `as of ${new Date(freshness.lastSuccessAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}
