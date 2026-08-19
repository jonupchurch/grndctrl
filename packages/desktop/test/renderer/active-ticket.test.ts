import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * FR-131's second clause, which no end-to-end test can assert (T120).
 *
 * "Shows what is known and names what is not" is visible on the page and is
 * checked in `test/e2e/active-ticket.spec.ts`. **"And does not fetch" is not**:
 * an absent request leaves nothing behind to assert on, and a spec that watched
 * for one would be watching a window that has no network of its own anyway.
 *
 * So it is asserted structurally, against the source — the same technique
 * `preload-surface.test.ts` uses on the bridge, and for the same reason: the
 * property is about what the module *can* do, not about what it did on one run.
 *
 * The failure this prevents is a small and reasonable-looking edit. The panel
 * has a ticket key and no ticket, `work.get` takes exactly that key, and adding
 * one line would fill the panel in — for a pointer an agent may set, against a
 * ticket that may not be the operator's, on a board that never asked. The rule
 * is not "avoid a slow render"; it is that an agent's input must not become a
 * request the operator did not make.
 */

const PANEL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'panels', 'ActiveTicket.tsx'),
  'utf8',
)

describe('the active ticket panel', () => {
  it('has no way to reach an operation', () => {
    // `useOperation` and `call` are the only two doors out of the renderer, and
    // both are imported by name. An unimported identifier cannot be used.
    expect(PANEL).not.toMatch(/\buseOperation\b/)
    expect(PANEL).not.toMatch(/from '\.\.\/query\.js'/)
    expect(PANEL).not.toMatch(/from '\.\.\/bridge\.js'/)
  })

  it('takes the board as a prop rather than reading it', () => {
    // The positive half of the same property: what it renders comes from the
    // snapshot App already holds. Asserting only the absence above would pass on
    // a component that had quietly stopped rendering anything at all.
    expect(PANEL).toMatch(/items: readonly WorkItem\[\] \| undefined/)
  })

  /**
   * The three-state read, held by name.
   *
   * `items === undefined` is the board not having answered yet, and it is a
   * different sentence from the board not holding this ticket. Collapsing them
   * gives a panel that announces "not on your board" for the first frame of
   * every launch, about a ticket that is on it — the same defect as a two-state
   * note-orphan check, which reported every note as orphaned on first run.
   *
   * An end-to-end test cannot see this: the wrong version is correct within a
   * second of launch, and every assertion in the suite is polled.
   */
  it('distinguishes "not on the board" from "the board is not here yet"', () => {
    expect(PANEL).toMatch(/items === undefined/)
    expect(PANEL).toMatch(/Not on your board/)
  })
})
