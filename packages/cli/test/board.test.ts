import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/index.js'

/**
 * The scenario quickstart.md names by hand.
 *
 * Asserting it here means the documented demo cannot rot silently — a quickstart
 * whose commands no longer do what it says is worse than no quickstart.
 *
 * **Three tests left this file with drift** and one absence assertion replaced
 * them. They checked that the fixture produced exactly one D1 finding naming
 * both the ticket and the pull request, that the finding offered its suggested
 * resolution, and that the branch lane reported "never synced". The first two
 * were the whole reason this renderer existed at M2 — it made the correlation
 * engine demonstrable before there was a screen — and there is no drift to
 * demonstrate.
 */

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'scenarios', 'merged-pr-open-ticket.json')

const board = (args: string[] = []) => runCli(['board', '--fixtures', FIXTURE, ...args])

describe('the text board', () => {
  it('renders the fixture scenario successfully', () => {
    const { output, exitCode } = board()
    expect(exitCode).toBe(0)
    expect(output).toContain('GROUND CONTROL')
  })

  /**
   * Paired with a presence assertion in the same output, because an absence
   * assertion passes trivially when the thing it greps for was never spelled
   * that way. If the board failed to render at all, the ticket line would be
   * missing too.
   */
  it('has no attention section, no drift findings and no code-host lanes', () => {
    const { output } = board()

    expect(output).not.toContain('ATTENTION')
    expect(output).not.toContain('<> D1')
    expect(output).not.toContain('drifting:')
    expect(output).not.toContain('PULL REQUESTS')
    expect(output).not.toContain('BRANCHES')

    expect(output).toContain('TICKETS')
    expect(output).toContain('MERC-1184')
    expect(output).toContain('AGENT SESSIONS')
  })

  /**
   * Constitution XIV applies to this surface too. A board that silently shows
   * stale data converts "I don't know" into "I know, incorrectly".
   */
  it('prints freshness before any data', () => {
    const { output } = board()
    const lines = output.split('\n')

    expect(lines[2]).toContain('tickets:')

    // The `never synced` state was asserted here against the branches lane,
    // which the fixture deliberately had no freshness record for. There is one
    // resource kind left and the fixture does have a record for it, so the state
    // is unreachable from this scenario. It is still reachable and still
    // asserted — `renderFreshness` is covered directly, and the desktop board's
    // own `never synced` rendering is asserted end to end in `board.spec.ts`.
    expect(output).not.toContain('branches:')
  })

  // FR-074: status survives greyscale, so the mark carries a shape and a word
  // rather than relying on colour.
  it('marks severity with a shape and a label, not colour', () => {
    const { output } = board()
    expect(output).toMatch(/#\s+sev/)
    expect(output).toContain('YOU')
  })

  it('shows the note count on the row that carries notes', () => {
    expect(board().output).toContain('[2 notes]')
  })

  it('filters to one project without changing the rest of the layout', () => {
    const filtered = board(['--project', 'p-merc']).output
    const missing = board(['--project', 'does-not-exist']).output

    expect(filtered).toContain('MERC-1184')
    expect(missing).toContain('(nothing here)')
    expect(missing).toContain('TICKETS  (0 shown)')
  })

  // The counts are of what was fetched, never a server-side total -- Jira's
  // search endpoint does not provide one (research R2).
  it('says "shown" rather than implying a total', () => {
    expect(board().output).toMatch(/TICKETS {2}\(\d+ shown\)/)
  })
})

describe('the CLI contract', () => {
  it('explains itself with no arguments and exits non-zero', () => {
    const { output, exitCode } = runCli([])
    expect(exitCode).toBe(1)
    expect(output).toContain('Usage:')
  })

  it('exits zero for an explicit help request', () => {
    expect(runCli(['--help']).exitCode).toBe(0)
  })

  it('rejects an unknown command', () => {
    const { output, exitCode } = runCli(['sync'])
    expect(exitCode).toBe(1)
    expect(output).toContain("Unknown command 'sync'")
  })

  it('reports a missing fixture without a stack trace', () => {
    const { output, exitCode } = runCli(['board', '--fixtures', 'nope.json'])
    expect(exitCode).toBe(1)
    expect(output).toContain('Could not read')
    expect(output).not.toContain('at Object')
  })

  it('requires the fixtures flag', () => {
    expect(runCli(['board']).exitCode).toBe(1)
  })
})
