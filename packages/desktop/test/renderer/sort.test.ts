import { describe, expect, it } from 'vitest'
import {
  applySort,
  nextSort,
  priorityOrder,
  sortableColumns,
  type SortAccessors,
} from '../../src/renderer/lanes/sort.js'

/**
 * Sorting a lane by one of its columns (T157).
 *
 * Every test here is a way a sort can be wrong while still *looking* sorted,
 * which is the failure mode that matters: an operator who clicks "Points" and
 * gets a plausible-looking order has no way to tell it from the right one.
 *
 * The end-to-end suite drives the actual headings in a real Chromium. This is
 * the comparator underneath, where the edges are — unknown values, ties, and
 * the one column whose sort key is not the text in the cell.
 */

interface Ticket {
  id: string
  points: number | null
  priority: string | null
  sprint: string | null
}

const ACCESSORS: SortAccessors<Ticket> = {
  identifier: (t) => t.id,
  sprint: (t) => t.sprint,
  priority: (t) => priorityOrder(t.priority),
  points: (t) => t.points,
}

const ticket = (over: Partial<Ticket> & { id: string }): Ticket => ({
  points: null,
  priority: null,
  sprint: null,
  ...over,
})

const ids = (rows: readonly Ticket[]): string[] => rows.map((t) => t.id)

describe('pressing a heading', () => {
  it('starts ascending, then descends, then returns to the order core sent', () => {
    const first = nextSort(null, 'points')
    expect(first).toEqual({ column: 'points', direction: 'asc' })

    const second = nextSort(first, 'points')
    expect(second).toEqual({ column: 'points', direction: 'desc' })

    // The third press is the one that matters. Core hands the board back in a
    // deterministic order and that order is what makes two syncs comparable to
    // the eye; a lane that could only toggle between two sorts would have made
    // it unreachable after the first click.
    expect(nextSort(second, 'points')).toBeNull()
  })

  /**
   * A new column starts over rather than inheriting a direction.
   *
   * Carrying "descending" from Points onto Ticket answers a question nobody
   * asked — and it is invisible, because a descending list of ticket keys is a
   * perfectly ordinary thing to look at.
   */
  it('starts a different column at ascending rather than inheriting', () => {
    expect(nextSort({ column: 'points', direction: 'desc' }, 'sprint')).toEqual({
      column: 'sprint',
      direction: 'asc',
    })
  })
})

describe('which headings can be pressed', () => {
  // The lane's accessors are the single source: a heading cannot be made
  // clickable without a comparator behind it, and one cannot be added without
  // its heading becoming clickable.
  it('is exactly the set of columns the lane has an accessor for', () => {
    expect(sortableColumns(ACCESSORS)).toEqual(['identifier', 'sprint', 'priority', 'points'])
    expect(sortableColumns({})).toEqual([])
  })
})

describe('ordering rows', () => {
  it('returns the very same array when the lane is unsorted', () => {
    const rows = [ticket({ id: 'MERC-2' }), ticket({ id: 'MERC-1' })]
    expect(applySort(rows, null, ACCESSORS)).toBe(rows)
  })

  // A lane of identifiers sorted as plain text puts MERC-10 above MERC-9, which
  // is the one column here that is mostly numbers.
  it('orders identifiers by their numbers, not by their characters', () => {
    const rows = [ticket({ id: 'MERC-10' }), ticket({ id: 'MERC-9' }), ticket({ id: 'MERC-100' })]

    expect(ids(applySort(rows, { column: 'identifier', direction: 'asc' }, ACCESSORS))).toEqual([
      'MERC-9',
      'MERC-10',
      'MERC-100',
    ])
  })

  it('reverses on descending', () => {
    const rows = [ticket({ id: 'a', points: 1 }), ticket({ id: 'b', points: 8 })]

    expect(ids(applySort(rows, { column: 'points', direction: 'desc' }, ACCESSORS))).toEqual([
      'b',
      'a',
    ])
  })

  /**
   * The one that matters most.
   *
   * Unknown is not "small". A null-as-zero comparison sorts correctly in
   * ascending order — the unestimated rows sit at the bottom with the ones and
   * twos — and then opens "points, biggest first" with a screenful of tickets
   * nobody has estimated. The operator sees a sorted-looking lane and the answer
   * to their question is somewhere below the fold.
   */
  it('keeps unknown values last in both directions', () => {
    const rows = [
      ticket({ id: 'none', points: null }),
      ticket({ id: 'small', points: 1 }),
      ticket({ id: 'big', points: 8 }),
    ]

    expect(ids(applySort(rows, { column: 'points', direction: 'asc' }, ACCESSORS))).toEqual([
      'small',
      'big',
      'none',
    ])
    expect(ids(applySort(rows, { column: 'points', direction: 'desc' }, ACCESSORS))).toEqual([
      'big',
      'small',
      'none',
    ])
  })

  // Zero is an estimate somebody made, and it is not unknown. The same pair the
  // store keeps distinct has to stay distinct here, or the sort undoes it.
  it('sorts a zero-point estimate as a number and not as an absence', () => {
    const rows = [
      ticket({ id: 'none', points: null }),
      ticket({ id: 'zero', points: 0 }),
      ticket({ id: 'three', points: 3 }),
    ]

    expect(ids(applySort(rows, { column: 'points', direction: 'asc' }, ACCESSORS))).toEqual([
      'zero',
      'three',
      'none',
    ])
  })

  /**
   * Ties keep the order they arrived in.
   *
   * A lane sorted by a column with four distinct values is mostly ties, and an
   * unstable sort would reshuffle it under the operator on every sync — rows
   * moving for no reason the board can explain.
   */
  it('is stable across rows that tie', () => {
    const rows = [
      ticket({ id: 'first', sprint: 'Sprint 12' }),
      ticket({ id: 'second', sprint: 'Sprint 12' }),
      ticket({ id: 'third', sprint: 'Sprint 12' }),
    ]

    expect(ids(applySort(rows, { column: 'sprint', direction: 'asc' }, ACCESSORS))).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('leaves the rows alone when the lane cannot sort by that column', () => {
    // `status` is a real column and this fixture's accessors deliberately do not
    // supply it — which is the case a lane hits whenever its headings and its
    // accessors disagree. It used to be `age`, a column that existed in the
    // union and in no lane; 006 removed the union member with the two lanes that
    // drew it, so the case had to be re-pointed at a live column rather than
    // deleted. Deleting it would have taken the guarantee with it.
    const rows = [ticket({ id: 'b' }), ticket({ id: 'a' })]
    expect(applySort(rows, { column: 'status', direction: 'asc' }, ACCESSORS)).toBe(rows)
  })
})

/**
 * Priority is ordered, never relabelled.
 *
 * `Ticket.priority` reaches the screen as the tracker spells it, and that is not
 * negotiable. But "sort by priority" asks for an order, and the alphabetical one
 * is actively wrong in a way that reads as a broken sort: `High` above `Highest`,
 * `Low` above `Medium`.
 */
describe('ordering by priority', () => {
  const rank = (names: (string | null)[]): (string | null)[] =>
    [...names].sort((a, b) => {
      const x = priorityOrder(a)
      const y = priorityOrder(b)
      if (x === null || y === null) return 0
      return x.localeCompare(y)
    })

  it('puts Jira’s own ladder in its own order rather than in alphabetical order', () => {
    expect(rank(['Low', 'Highest', 'Medium', 'High', 'Lowest'])).toEqual([
      'Highest',
      'High',
      'Medium',
      'Low',
      'Lowest',
    ])
  })

  // A site with its own scheme falls through to alphabetical, which for `P1`…`P4`
  // and for `Blocker`/`Critical`/`Major` is the order those schemes intend.
  it('falls back to alphabetical for a scheme it does not know', () => {
    expect(rank(['P3', 'P1', 'P2'])).toEqual(['P1', 'P2', 'P3'])
  })

  // One alphabetical block after the known ladder, rather than a list that looks
  // shuffled because two vocabularies were interleaved.
  it('sorts every unknown priority after every known one', () => {
    const known = priorityOrder('Lowest')
    const unknown = priorityOrder('Aardvark')

    expect(known).not.toBeNull()
    expect(unknown).not.toBeNull()
    expect((known ?? '') < (unknown ?? '')).toBe(true)
  })

  it('is unknown for a ticket with no priority set', () => {
    expect(priorityOrder(null)).toBeNull()
  })
})
