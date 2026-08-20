import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 008 — the four properties of the history region no end-to-end test can see.
 *
 * Each is about what this module is *able* to do rather than what it did on one
 * run, which is the same reason `active-ticket.test.ts` and
 * `prompts-panel.test.ts` are written against the source. All four have a
 * plausible, tidy-looking edit that would remove them and leave every spec in
 * the suite green.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...parts: string[]): string =>
  readFileSync(join(HERE, '..', '..', 'src', ...parts), 'utf8')

const PANEL = read('renderer', 'panels', 'TicketHistory.tsx')
const APP = read('renderer', 'App.tsx')
const STYLES = read('renderer', 'styles', 'board.css')

describe('the ticket history region', () => {
  it('sends the revision the editor read, not the one on screen', () => {
    /*
     * FR-155, and the whole of it.
     *
     * `entry.revision` is in scope at the call site and reads as the obvious
     * thing to send — it is the freshest value, after all. Sending it would make
     * every save succeed, including the one that overwrites what an agent
     * recorded thirty seconds ago, and the conflict machinery would still be
     * there, still tested, and never reached.
     */
    expect(PANEL).toMatch(/onRevise\(\{[^}]*revision: draft\.revision/s)
    // Scoped to the revise call. The *delete* legitimately sends
    // `entry.revision` — it removes the entry as rendered, and the row on
    // screen is what the operator is pointing at.
    expect(PANEL).not.toMatch(/onRevise\(\{[^}]*revision: entry\.revision/s)
  })

  it('does not render the notes until the row is opened', () => {
    /*
     * A `display: none` fold would look identical on screen and leave every
     * paragraph in the DOM — which `perf.spec.ts` and `greyscale.spec.ts` count,
     * and which would make a year of history part of the frame budget.
     *
     * The conditional is on the element, not on a class.
     */
    expect(PANEL).toMatch(/\{!expanded \? null : \(/)
    expect(STYLES).not.toMatch(/\.history__body\s*\{[^}]*display:\s*none/)
  })

  it('keeps the line breaks in the notes', () => {
    // The notes accumulate as paragraphs, one per record, separated by blank
    // lines. Collapsing whitespace would run a year of separate entries into one
    // block of prose — which is the failure the append rule exists to avoid.
    expect(STYLES).toMatch(/\.history__notes\s*\{[^}]*white-space:\s*pre-wrap/)
  })

  it('asks twice before deleting', () => {
    // The opposite call to the prompts panel, and deliberately: a prompt is
    // deleted *because* it holds something unwanted, so a confirmation is
    // friction on the wrong side. A history entry is the only copy of what it
    // says, and there is no provider to restore it from (XI).
    expect(PANEL).toMatch(/if \(confirming !== entry\.ticketKey\)/)
    expect(PANEL).toMatch(/Really delete/)
  })

  it('filters in the page rather than dispatching per keystroke', () => {
    // `history.list` takes a `q`, which makes wiring the search box to it look
    // like the tidy option. Every one of those dispatches is a read, and a read
    // that announces a change is the shape that produced a push loop in
    // `main/push.ts` once already — this one would fire per character.
    // The panel does not reach the bridge at all, which is the strongest form
    // of this: it cannot dispatch anything, per keystroke or otherwise.
    expect(PANEL).not.toMatch(/from '\.\.\/bridge\.js'/)
    expect(PANEL).toMatch(/entries\.filter/)
    expect(APP).toMatch(
      /useOperation<TicketHistoryEntry\[\]>\('history\.list', \{ limit: 1000 \}\)/,
    )
  })
})
