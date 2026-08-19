/**
 * Sorting a lane by one of its columns.
 *
 * The headings became sort triggers rather than gaining a "sort by" dropdown
 * beside them. A dropdown is a second place the current order is stated, and the
 * two drift: the control says "Priority, descending" while the eye is reading a
 * column that no longer looks sorted, and nothing on screen resolves the
 * disagreement. Clicking the heading puts the control *on* the thing it orders,
 * so the caret and the column are the same claim.
 *
 * Three decisions worth naming, because each one is a way a sort can lie:
 *
 * **Unsorted is a real state, and it is the one a lane opens in.** The cycle is
 * ascending, descending, *off* — not a toggle between two directions. Core hands
 * the board back ordered by natural key, deterministically, and that order is
 * what makes two syncs comparable to the eye. A lane that could never be put
 * back would make the default order unreachable after the first click.
 *
 * **Absent values sort last in both directions.** Null here means unknown — no
 * estimate, no sprint, no priority set — and unknown is not "small". Sorting by
 * points descending to see the big ones must not open with a screenful of
 * tickets nobody estimated, which is what a null-as-zero comparison produces.
 *
 * **The sort is stable.** Rows that tie keep the order core sent them in, so a
 * lane sorted by a column with four distinct values is not reshuffled underneath
 * the operator on every sync. `Array.prototype.sort` has been required to be
 * stable since ES2019; this relies on that rather than re-implementing it.
 */

export type SortColumn = 'identifier' | 'title' | 'status' | 'sprint' | 'priority' | 'points' | 'age'

export type SortDirection = 'asc' | 'desc'

/** The column being sorted on and which way, or `null` for core's own order. */
export interface SortState {
  column: SortColumn
  direction: SortDirection
}

/**
 * What one row answers for each column that can be sorted on.
 *
 * A lane supplies only the columns it draws — the pull request lane has no
 * `sprint` accessor because it has no sprint column — and `sortableColumns`
 * reads the same object, so a heading cannot become clickable without something
 * behind it to sort by.
 *
 * `null` is unknown and sorts last. A number and a string are both allowed
 * because points are numeric and everything else is not; they are never compared
 * against each other, since a column has one accessor.
 */
export type SortAccessors<T> = Partial<Record<SortColumn, (row: T) => string | number | null>>

/** The columns this lane can actually sort by, in the order they are drawn. */
export function sortableColumns<T>(accessors: SortAccessors<T>): SortColumn[] {
  const order: SortColumn[] = ['identifier', 'title', 'status', 'sprint', 'priority', 'points', 'age']
  return order.filter((column) => accessors[column] !== undefined)
}

/**
 * The next state after pressing a heading: asc → desc → unsorted.
 *
 * Pressing a *different* heading starts that column at ascending rather than
 * inheriting the previous column's direction — the direction belongs to the
 * question being asked, and carrying "descending" from Points onto Ticket would
 * answer a question nobody asked.
 */
export function nextSort(current: SortState | null, column: SortColumn): SortState | null {
  if (current === null || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

/**
 * Jira's default priority ladder, for ordering only.
 *
 * This is the one place the tracker's priority vocabulary is interpreted, and it
 * is deliberately not a *mapping*: nothing here is ever displayed, stored, or
 * compared against a threshold. `Ticket.priority` still carries the tracker's own
 * word to the screen, unmapped, for the reasons written where it is declared.
 *
 * But an ordering is what "sort by priority" asks for, and the alphabetical
 * answer is actively wrong — it puts `High` above `Highest` and `Low` above
 * `Medium`, which reads as a sort that has silently failed. A site using
 * `P1`…`P4` or `Blocker`/`Critical` falls through to the alphabetical fallback,
 * which for those schemes is the right order anyway.
 *
 * Unknown words sort *after* the known ladder rather than interleaved with it,
 * so a site with a custom scheme gets one alphabetical block instead of a list
 * that looks shuffled.
 */
const PRIORITY_LADDER = ['highest', 'high', 'medium', 'low', 'lowest']

export function priorityOrder(priority: string | null): string | null {
  if (priority === null) return null

  const rank = PRIORITY_LADDER.indexOf(priority.trim().toLowerCase())
  // Zero-padded so the ranks compare as strings alongside the fallback, and
  // prefixed `0`/`1` so every known priority sorts before every unknown one.
  return rank === -1 ? `1:${priority.trim().toLowerCase()}` : `0:${rank}`
}

/**
 * Sorted, or the same array back when the lane is unsorted.
 *
 * Returning the input unchanged rather than a copy is not just an allocation
 * saved: it is what makes "unsorted" indistinguishable from never having sorted,
 * so nothing downstream can tell the two apart and start behaving differently.
 */
export function applySort<T>(
  rows: readonly T[],
  sort: SortState | null,
  accessors: SortAccessors<T>,
): readonly T[] {
  if (sort === null) return rows

  const read = accessors[sort.column]
  if (read === undefined) return rows

  const sign = sort.direction === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const left = read(a)
    const right = read(b)

    // Ahead of the direction, and deliberately: a `null` arm folded into
    // `compare` would be multiplied by `sign` with everything else and would
    // float the unknown rows to the top on `desc` — which is exactly the screen
    // "sort by points, biggest first" must not open with.
    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1

    return compare(left, right) * sign
  })
}

/** Two known cell values. Unknown never reaches here — see `applySort`. */
function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b

  // `numeric` so `MERC-9` comes before `MERC-10` and `#9` before `#100`. A
  // lane of identifiers sorted as plain text is a lane the operator has to read
  // twice, and the identifiers here are the one column that is mostly numbers.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}
