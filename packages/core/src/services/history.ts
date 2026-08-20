import { issueKeyOfTicketKey, subjectKindOf, type NaturalKey } from '../domain/keys.js'
import type { TicketHistoryEntry } from '../domain/types.js'
import { conflict, invalid, notFound } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type {
  HistoryFilter,
  HistoryRepository,
  HistoryWriteResult,
} from '../store/authored/history.js'

/**
 * The ticket history — one curated line per ticket (FR-146 to FR-159).
 *
 * ## The line is one line, and the write refuses anything else
 *
 * A model handed a free-text field writes a paragraph. A region of paragraphs is
 * the note list again with worse types, and the operator asked for "one line per
 * ticket" — so the rule is enforced here rather than hoped for in a tool
 * description.
 *
 * **Refused, not collapsed.** Turning the newlines into spaces would store
 * something the caller did not write and report nothing, and it would waste the
 * one moment where a model can be told where the paragraph belongs: `notes`, the
 * field directly beside it, which is unbounded enough for the whole story. The
 * error says so in as many words.
 *
 * Trimming the ends is not the same thing and is done: a trailing newline is how
 * text arrives, not something anyone chose.
 *
 * ## Recording appends, and appending twice does not duplicate
 *
 * The line is **replaced** on every record — it is a headline, and a headline
 * improves with hindsight. The notes are **appended to**, because detail does not
 * survive being overwritten and the whole point of the entry is that it is still
 * there in a year.
 *
 * Which leaves the obvious failure: an agent that records the same summary at the
 * end of every turn triples the notes. So an append whose text the notes already
 * end with is dropped. It is a narrow rule — exact match on the tail, after
 * trimming — and deliberately not a fuzzy one: near-duplicate detection would
 * eventually swallow a genuine second paragraph that opened the same way.
 *
 * ## Two writers, two operations
 *
 * `record` is for agents and the operator alike: state the line, add the detail.
 * `revise` is the operator's alone (FR-154) and is the *curation* half — it
 * replaces both fields wholesale and can clear the notes, which is the only way
 * to undo an append. It carries a revision, so an agent recording while the
 * operator is mid-edit produces a visible conflict rather than a silent loss
 * (FR-155); the same machinery `notes.update` uses, for the same reason.
 *
 * ## What it stores about the ticket, and why it stores anything
 *
 * `ticketSummary` is a **snapshot**, refreshed on each write the mirror can
 * answer and kept when it cannot (FR-149). The entry is written because the work
 * finished, and a finished ticket stops being assigned to the operator and leaves
 * the mirror on the next sync — so by the time anybody reads the history back,
 * the join that would have produced a label is gone. Without the snapshot this is
 * a list of bare issue keys.
 */

/**
 * What a reader gets: the stored entry, plus the issue key derived from its own
 * ticket key.
 *
 * Derived here rather than stored, and rather than parsed in the interface. It
 * is the same string the key already holds, so a stored copy would be a second
 * place for it to be wrong; and every other surface that shows a ticket has a
 * mirrored row to read `issueKey` from, which is exactly what this one does not
 * have — the entry outlives the ticket. Same shape as `NoteView`, which adds
 * `orphaned` for the same kind of reason.
 */
export interface TicketHistoryView extends TicketHistoryEntry {
  /** `MERC-1184`. Null only if the stored key is malformed, which nothing writes. */
  issueKey: string | null
}

export type SubjectSummary = (ticketKey: NaturalKey) => string | null

export interface HistoryServiceDeps {
  history: HistoryRepository
  /**
   * The ticket's own summary, if the mirror holds it. `null` when it does not.
   *
   * A cross-store read, so it is injected by the composition root rather than
   * reached for here — `authored.db` never holds a handle to `mirror.db` (XIII).
   */
  ticketSummary?: SubjectSummary
  /**
   * "Could this ticket key ever resolve?" — the same check notes and focus make.
   *
   * Optional so a caller that has not wired it keeps working; the composition
   * root supplies the real one.
   */
  assertKnownSite?(key: NaturalKey): void
}

export interface RecordHistoryRequest {
  ticketKey: NaturalKey
  line: string
  notes?: string | undefined
}

export interface ReviseHistoryRequest {
  ticketKey: NaturalKey
  revision: number
  line?: string | undefined
  /** `null` clears the notes — the only way to undo an append. */
  notes?: string | null | undefined
}

export interface HistoryService {
  list(filter?: HistoryFilter): TicketHistoryView[]
  /** The entry, or `not_found`. Never an empty one. */
  get(ticketKey: NaturalKey): TicketHistoryView
  record(input: RecordHistoryRequest, ctx: Ctx): TicketHistoryView
  revise(input: ReviseHistoryRequest, ctx: Ctx): TicketHistoryView
  remove(input: { ticketKey: NaturalKey; revision: number }): { ticketKey: string }
}

/**
 * How long the line may be.
 *
 * Long enough for a real sentence about what was done, short enough that a
 * hundred of them stay scannable in a column — which is the only property the
 * region has that the note list does not.
 */
export const MAX_LINE = 200

/**
 * How much a single record may add to the notes, and how much the notes may hold
 * in total.
 *
 * The chunk bound matches a note body, because it is the same kind of writing.
 * The total is twelve times that: notes accumulate across every record against a
 * ticket, and an entry that has been written to fifty times is a ticket that
 * earned it.
 *
 * **The total refuses rather than trimming from the front.** Dropping the oldest
 * paragraph to make room would be a prune wearing a different hat, on the one
 * table in this product that must not have one (FR-150) — and it would silently
 * delete the first thing anybody wrote about the ticket, which is usually the
 * part worth keeping. The refusal names `history.revise`, which is how an
 * operator shortens an entry deliberately.
 */
export const MAX_NOTES_CHUNK = 8_000
export const MAX_NOTES_TOTAL = 96_000

export function historyService(deps: HistoryServiceDeps): HistoryService {
  const { history } = deps

  const view = (entry: TicketHistoryEntry): TicketHistoryView => ({
    ...entry,
    issueKey: issueKeyOfTicketKey(entry.ticketKey),
  })

  const unwrap = (result: HistoryWriteResult): TicketHistoryView => {
    if (result.ok) return view(result.entry)
    if (result.reason === 'not_found') throw notFound('That ticket has no history entry.')
    throw conflict(
      'This entry was written to by someone else while you were editing it.',
      // The row that won, in the shape a reader expects — so the interface can
      // render it beside the draft rather than only reporting that it lost.
      view(result.current),
    )
  }

  /** Shared by both write paths: a ticket key, and one that could resolve. */
  const assertTicket = (ticketKey: NaturalKey): void => {
    if (subjectKindOf(ticketKey) !== 'ticket') {
      throw invalid(
        `The ticket history attaches to tickets only; '${ticketKey}' is not a ticket key. ` +
          `A ticket key is jira:<site>/<ISSUE-KEY>.`,
      )
    }
    // Before the write, not after — an entry against a site nothing is configured
    // for is one nobody will ever see again. See `services/sites.ts`.
    deps.assertKnownSite?.(ticketKey)
  }

  const cleanLine = (raw: string): string => {
    const line = raw.trim()
    if (line === '') throw invalid('A history entry needs a line.')

    if (/[\r\n]/.test(line)) {
      throw invalid(
        'The history line must be a single line — this is the one line the ticket gets. ' +
          'Put the detail in `notes`, which takes as many paragraphs as you need.',
      )
    }

    if (line.length > MAX_LINE) {
      throw invalid(
        `The history line may be at most ${MAX_LINE} characters; that one is ${line.length}. ` +
          'Shorten it and put the rest in `notes`.',
      )
    }

    return line
  }

  return {
    list: (filter) => history.list(filter).map(view),

    get(ticketKey): TicketHistoryView {
      const entry = history.get(ticketKey)
      if (entry === null) {
        // `not_found` rather than a blank entry. A caller handed an empty line
        // renders an empty line, and "nothing was written about this ticket" and
        // "this ticket's history says nothing" are different answers.
        throw notFound(`No history entry for '${ticketKey}'.`)
      }
      return view(entry)
    },

    record(input, ctx): TicketHistoryView {
      assertTicket(input.ticketKey)

      const line = cleanLine(input.line)
      const addition = input.notes?.trim() ?? ''

      if (addition.length > MAX_NOTES_CHUNK) {
        throw invalid(
          `A single record may add at most ${MAX_NOTES_CHUNK} characters of notes; ` +
            `that one is ${addition.length}.`,
        )
      }

      return view(
        history.record({
          ticketKey: input.ticketKey,
          line,
          /*
           * Runs inside the write transaction, against the notes as they are at
           * that instant — which is why this is a callback and not a value
           * computed up here. A second agent recording between a read and an
           * update would otherwise have its paragraph overwritten by a merge that
           * never saw it.
           */
          mergeNotes: (existing) => {
            if (addition === '') return existing
            if (existing === null || existing.trim() === '') return addition

            // Exact tail match only. A fuzzier rule would eventually swallow a
            // real second paragraph that happened to open the same way.
            if (existing.trimEnd().endsWith(addition)) return existing

            const merged = `${existing.trimEnd()}\n\n${addition}`
            if (merged.length > MAX_NOTES_TOTAL) {
              throw invalid(
                `This entry's notes would exceed ${MAX_NOTES_TOTAL} characters. ` +
                  'Nothing is dropped to make room — shorten them with `history.revise` first.',
              )
            }
            return merged
          },
          // Null when the mirror cannot answer, which the store reads as "keep the
          // snapshot you have" rather than "clear it".
          ticketSummary: deps.ticketSummary?.(input.ticketKey) ?? null,
          // From the transport. A payload that could name its own author could
          // sign an entry as the operator, and the region renders that name.
          authorKind: ctx.authorKind,
          authorId: ctx.authorId ?? null,
          at: ctx.now().toISOString(),
        }),
      )
    },

    revise(input, ctx): TicketHistoryView {
      assertTicket(input.ticketKey)

      if (input.line === undefined && input.notes === undefined) {
        throw invalid('A revision needs something to change: a line, notes, or both.')
      }

      const notes = input.notes === undefined ? undefined : (input.notes?.trim() ?? '')
      if (notes !== undefined && notes.length > MAX_NOTES_TOTAL) {
        throw invalid(`An entry's notes may be at most ${MAX_NOTES_TOTAL} characters.`)
      }

      return unwrap(
        history.revise(
          input.ticketKey,
          input.revision,
          {
            ...(input.line === undefined ? {} : { line: cleanLine(input.line) }),
            // An empty string clears rather than storing a blank: "" and null
            // would render identically and only one of them is a state.
            ...(notes === undefined ? {} : { notes: notes === '' ? null : notes }),
          },
          ctx.now().toISOString(),
        ),
      )
    },

    remove(input): { ticketKey: string } {
      const removed = unwrap(history.remove(input.ticketKey, input.revision))
      return { ticketKey: removed.ticketKey }
    },
  }
}
