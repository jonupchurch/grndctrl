import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/index.js'

/**
 * The scenario quickstart.md names by hand:
 *
 *   npx grndctrl-cli board --fixtures fixtures/scenarios/merged-pr-open-ticket
 *   "must show exactly one D1 finding, naming both the ticket and the PR"
 *
 * Asserting it here means the documented demo cannot rot silently — a quickstart
 * whose commands no longer do what it says is worse than no quickstart.
 */

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'scenarios', 'merged-pr-open-ticket.json')

const board = (args: string[] = []) => runCli(['board', '--fixtures', FIXTURE, ...args])

describe('the text board', () => {
  it('renders the fixture scenario successfully', () => {
    const { output, exitCode } = board()
    expect(exitCode).toBe(0)
    expect(output).toContain('GROUND CONTROL')
  })

  it('shows exactly one D1 finding naming both sides', () => {
    const { output } = board()

    expect(output.match(/<> D1/g)).toHaveLength(1)
    expect(output).toContain('MERC-1184 is In Review')
    expect(output).toContain('PR #451 merged')
    // Both sides of the evidence, each with its timestamp -- a finding that
    // states only one side is an accusation, not a report.
    expect(output).toContain('ticket         status is In Review')
    expect(output).toContain('pull request   merged')
  })

  it('offers the suggested resolution', () => {
    expect(board().output).toContain('-> Move to Done')
  })

  /**
   * Constitution XIV applies to this surface too. A board that silently shows
   * stale data converts "I don't know" into "I know, incorrectly".
   */
  it('prints freshness before any data, including the never state', () => {
    const { output } = board()
    const lines = output.split('\n')

    expect(lines[2]).toContain('tickets:')
    // The fixture has no branches freshness record on purpose.
    expect(output).toContain('branches: never synced')
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
