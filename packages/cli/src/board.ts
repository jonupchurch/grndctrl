import type {
  BallInCourt,
  DriftFinding,
  Severity,
  StalenessBand,
  WorkItem,
} from '@grndctrl/core'

/**
 * The board as text.
 *
 * This exists to answer the one real cost of building headless-first: there is
 * nothing to look at until M4, on a product whose value is visual. A text
 * renderer makes the correlation engine demonstrable at M2 and stays useful
 * afterwards for inspecting fixtures and diffing two runs.
 *
 * It is deliberately not a pretty CLI. It mirrors what the real board will show
 * — severity, staleness, ball-in-court, drift — so that a disagreement between
 * this and the UI is a bug in one of them rather than in two different ideas of
 * what the data means.
 */

/** Shape and letter, not colour. The same constraint as the real UI (FR-074). */
const SEVERITY_MARK: Record<Severity, string> = {
  good: 'o  ok  ',
  warning: '^  warn',
  serious: '#  sev ',
  critical: '<> crit',
}

const STALENESS_BAR: Record<StalenessBand, string> = {
  idle: '.    ',
  recent: '|    ',
  aging: '||   ',
  stale: '|||  ',
  abandoned: '|||||',
}

const BALL: Record<BallInCourt, string> = {
  you: 'YOU  ',
  them: 'them ',
  agent: 'agent',
}

export interface RenderOptions {
  workItems: readonly WorkItem[]
  findings: readonly DriftFinding[]
  /** Per resource kind, so a lane can be fresh while another is not (XIV). */
  freshness: Record<string, { state: string; ageSec: number | null }>
  projectFilter?: string | null
  now: Date
}

export function renderBoard(options: RenderOptions): string {
  const items = options.projectFilter
    ? options.workItems.filter((w) => w.projectId === options.projectFilter)
    : options.workItems

  const lines: string[] = []

  lines.push(header('GROUND CONTROL'))
  lines.push(renderFreshness(options.freshness))
  lines.push('')

  lines.push(renderStats(items, options.findings))
  lines.push('')

  if (options.findings.length > 0) {
    lines.push(header('ATTENTION'))
    for (const f of options.findings) {
      lines.push(`  <> ${f.rule}  ${f.summary}`)
      for (const e of f.evidence) {
        lines.push(`        ${e.side.padEnd(14)} ${e.fact}${e.at === null ? '' : `  (${e.at})`}`)
      }
      if (f.suggestedAction !== null) {
        lines.push(
          `        -> ${f.suggestedAction.label}${f.dispatchable ? '' : '  (not dispatchable)'}`,
        )
      }
      lines.push('')
    }
  }

  lines.push(renderLane('TICKETS', items.filter((w) => w.ticket !== null)))
  lines.push(renderLane('PULL REQUESTS', items.filter((w) => w.pullRequests.length > 0)))
  lines.push(renderLane('BRANCHES', items.filter((w) => w.workspaces.length > 0)))
  lines.push(renderLane('AGENT SESSIONS', items.filter((w) => w.sessions.length > 0)))

  return lines.join('\n')
}

function header(text: string): string {
  return `${text}\n${'='.repeat(text.length)}`
}

/**
 * Freshness is printed before anything else, and never omitted.
 *
 * Constitution XIV applies to this surface exactly as it does to the UI: a
 * board that silently shows stale data is worse than no board, because it
 * converts "I don't know" into "I know, incorrectly."
 */
function renderFreshness(freshness: RenderOptions['freshness']): string {
  const parts = Object.entries(freshness).map(([kind, f]) => {
    if (f.state === 'never') return `${kind}: never synced`
    if (f.state === 'failed') return `${kind}: FAILED TO REFRESH`
    return `${kind}: ${f.ageSec === null ? 'unknown' : `${Math.floor(f.ageSec / 60)}m ago`}${
      f.state === 'stale' ? ' (stale)' : ''
    }`
  })
  return parts.length === 0 ? 'no sync has run' : parts.join('  |  ')
}

function renderStats(items: readonly WorkItem[], findings: readonly DriftFinding[]): string {
  const yourCourt = items.filter((w) => w.ballInCourt === 'you').length
  const stalled = items.filter((w) => w.staleness === 'stale' || w.staleness === 'abandoned').length
  const agentsLive = items.filter((w) => w.sessions.some((s) => s.endedAt === null)).length

  return [
    `your court: ${yourCourt}`,
    `drifting: ${findings.length}`,
    `stalled: ${stalled}`,
    `agents live: ${agentsLive}`,
  ].join('   ')
}

function renderLane(title: string, items: readonly WorkItem[]): string {
  const lines = [header(`${title}  (${items.length} shown)`)]

  if (items.length === 0) {
    lines.push('  (nothing here)')
    lines.push('')
    return lines.join('\n')
  }

  for (const item of items) {
    lines.push(
      [
        ' ',
        STALENESS_BAR[item.staleness],
        SEVERITY_MARK[item.severity],
        BALL[item.ballInCourt],
        identity(item).padEnd(22),
        titleOf(item).slice(0, 60).padEnd(60),
        item.noteCount > 0 ? `[${item.noteCount} notes]` : '',
        item.resolution === 'partial' ? '(partial)' : '',
      ].join(' '),
    )
  }

  lines.push('')
  return lines.join('\n')
}

function identity(item: WorkItem): string {
  if (item.ticket !== null) return item.ticket.issueKey
  if (item.pullRequests.length > 0) return `#${item.pullRequests[0]?.number}`
  if (item.workspaces.length > 0) return item.workspaces[0]?.branch ?? item.key
  return item.key
}

function titleOf(item: WorkItem): string {
  if (item.ticket !== null) return item.ticket.summary
  if (item.pullRequests.length > 0) return item.pullRequests[0]?.title ?? ''
  if (item.sessions.length > 0) return item.sessions[0]?.reportedStatus ?? ''
  return ''
}
