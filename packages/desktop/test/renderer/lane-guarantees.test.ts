import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Two guarantees that lost the test that watched them, and did not lose the
 * guarantee.
 *
 * Both were asserted end-to-end until 006, both became **unobservable** when the
 * board went down to one lane, and both were retired with a comment in
 * `board.spec.ts` promising that 007's second lane — the "no longer mine" lane,
 * T111 — would restore them. That lane was dropped on 2026-08-20 without ever
 * being built, so the promise is void and the two comments were pointing at a
 * milestone that will never arrive.
 *
 * A guarantee whose only test was deleted on a promise nobody can now keep is
 * exactly the kind that quietly stops being true. So they are asserted here
 * instead — against the source, because that is where the property lives when
 * there is no second lane to observe it through.
 *
 * **This is weaker than what it replaces and the difference is worth naming.**
 * An end-to-end test would prove the behaviour; these prove the *construction*
 * that produces it. If a second lane ever arrives, restore the real assertions
 * in `board.spec.ts` and delete this file.
 */

const LANES = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer', 'lanes', 'Lanes.tsx'),
  'utf8',
)

const SECTION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'src',
    'renderer',
    'components',
    'Section.tsx',
  ),
  'utf8',
)

describe('sorting one lane cannot reorder another', () => {
  it('keeps the sort state inside the hook, so each lane gets its own', () => {
    /*
     * The whole guarantee is that `useState` is *inside* `useLaneSort`. A module
     * -level `let`, a hoisted state, or a shared context would give every lane
     * one cursor — and with a single sortable lane on the board nothing would
     * ever show it.
     */
    const hook = LANES.slice(LANES.indexOf('function useLaneSort'))
    const body = hook.slice(0, hook.indexOf('\n}\n'))

    expect(body).toContain('useState<SortState | null>(null)')
  })

  it('holds no sort state outside the hook', () => {
    // The failure this catches is someone lifting the state "so the lanes agree",
    // which is the exact bug the retired test existed to prevent.
    const beforeHook = LANES.slice(0, LANES.indexOf('function useLaneSort'))
    expect(beforeHook).not.toMatch(/^(let|const)\s+\w*[sS]ort\w*\s*(:|=)/m)
  })
})

describe('the metric columns are opt-in', () => {
  it('drives the grid and the headings from one flag', () => {
    // `data-metrics` is the single switch: a lane that does not set it gets
    // neither the wider grid template nor the sprint/priority/points headings.
    // Retired end-to-end because every surviving lane sets it.
    expect(SECTION).toContain("'data-metrics': metrics")
    expect(SECTION).toMatch(/metrics\?: boolean/)
  })

  it('omits the attribute entirely rather than writing false', () => {
    // `data-metrics="false"` is truthy to a CSS attribute selector, so writing
    // it would turn the opt-in into an always-on. The absent-vs-false
    // distinction is the whole mechanism.
    expect(SECTION).toContain("metrics === undefined ? {} : { 'data-metrics': metrics }")
  })
})
