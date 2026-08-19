import type { BallInCourt, Severity, StalenessBand, WorkItem } from '@grndctrl/core'

/**
 * The board as text.
 *
 * This exists to answer the one real cost of building headless-first: there is
 * nothing to look at until M4, on a product whose value is visual. A text
 * renderer makes the correlation engine demonstrable at M2 and stays useful
 * afterwards for inspecting fixtures and diffing two runs.
 *
 * It is deliberately not a pretty CLI. It mirrors what the real board will show
 * — severity, staleness, ball-in-court — so that a disagreement between this and
 * the UI is a bug in one of them rather than in two different ideas of what the
 * data means. That is why the Attention section and the two code-host lanes
 * leave here in the same change that took them off the board: a text renderer
 * that still printed drift findings would not be a second opinion, it would be a
 * second product.
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

  lines.push(renderStats(items))
  lines.push('')

  lines.push(renderLane('TICKETS', items.filter((w) => w.ticket !== null)))
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

function renderStats(items: readonly WorkItem[]): string {
  const yourCourt = items.filter((w) => w.ballInCourt === 'you').length
  const stalled = items.filter((w) => w.staleness === 'stale' || w.staleness === 'abandoned').length
  const agentsLive = items.filter((w) => w.sessions.some((s) => s.endedAt === null)).length

  // `drifting` was the second of four and is gone with the tile it mirrors. The
  // other three count exactly what they counted before.
  return [
    `your court: ${yourCourt}`,
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

/**
 * Both of these had a pull-request arm and a branch arm between the ticket and
 * the fallback. A work item is built from a ticket now, so the first arm is
 * almost always the answer — but the fallback stays, because `ticket` is still
 * nullable until M4 and a key is a better thing to print than an empty cell.
 */
function identity(item: WorkItem): string {
  return item.ticket === null ? item.key : item.ticket.issueKey
}

function titleOf(item: WorkItem): string {
  if (item.ticket !== null) return item.ticket.summary
  if (item.sessions.length > 0) return item.sessions[0]?.reportedStatus ?? ''
  return ''
}
