import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { Section } from '../components/Section.js'
import { formatAge } from '../components/StaleBar.js'
import type { TicketHistoryEntry } from '../types.js'

/**
 * The ticket history — one curated line per ticket (008/FR-156 to FR-159).
 *
 * ## Why this region looks nothing like the ones above it
 *
 * Every other region on this board answers *what is happening now* and is
 * therefore read top to bottom, in full, at a glance. This one answers *what
 * happened once*, and the operator arrives at it already knowing which ticket
 * they are looking for. So it is a searchable index rather than a feed: one line
 * per row, folded, with the detail one click away.
 *
 * That is also why the detail is **not rendered until it is asked for**. A
 * hundred entries with their notes expanded is a page nobody can use, and
 * `display: none` would leave the paragraphs in the DOM for the perf and
 * greyscale suites to count — the same argument `Section` makes about collapsed
 * regions, applied one level down.
 *
 * ## Filtering happens here, not at the operation
 *
 * `history.list` takes a `q` and this component does not use it. Sending a
 * dispatch per keystroke would put a round trip between the operator and their
 * own search, and — worse — every one of those dispatches is a `history.list`,
 * which is a read, which is exactly the shape that turned into a push loop in
 * `main/push.ts` once already. The list is bounded and already in memory. The
 * operation's `q` is for agents, which ask once.
 *
 * ## The editor is inline, and it holds the revision it read
 *
 * FR-155. The draft captures `revision` when editing opens, so an agent
 * recording against the same ticket in the meantime makes the save lose — which
 * is the point. The list refreshing underneath changes what is drawn behind the
 * editor and not what it will send, which is why `history.list` *can* be
 * invalidated on push where `notes.list` deliberately cannot (`query.ts`).
 *
 * ## Deleting asks, where deleting a prompt does not
 *
 * The opposite call to `Prompts.tsx`, on purpose. A prompt is deleted *because*
 * it holds something the operator would rather not keep, so a confirmation sits
 * on the wrong side of the friction. A history entry is the only durable record
 * of work that has finished — there is no provider copy to restore it from
 * (XI) — so the second press is the cheapest possible guard against losing one
 * to a mis-click.
 */

export interface ReviseRequest {
  ticketKey: string
  revision: number
  line: string
  notes: string | null
}

export interface TicketHistoryProps {
  entries: readonly TicketHistoryEntry[]
  /** Rewrites an entry whole. Rejects with the failure, including a conflict. */
  onRevise(request: ReviseRequest): Promise<void>
  onDelete(request: { ticketKey: string; revision: number }): Promise<void>
  now?: Date
}

interface Draft {
  ticketKey: string
  /** Read when the editor opened. What makes a lost race detectable (FR-155). */
  revision: number
  line: string
  notes: string
}

export function TicketHistory({
  entries,
  onRevise,
  onDelete,
  now,
}: TicketHistoryProps): ReactElement {
  const [query, setQuery] = useState('')
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{ ticketKey: string; message: string } | null>(null)
  /** Which entry has been asked to be deleted once. Cleared by anything else. */
  const [confirming, setConfirming] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (term === '') return entries

    return entries.filter((entry) =>
      [entry.issueKey, entry.ticketKey, entry.line, entry.ticketSummary, entry.notes].some(
        (field) => field !== null && field.toLowerCase().includes(term),
      ),
    )
  }, [entries, query])

  const startEditing = useCallback((entry: TicketHistoryEntry) => {
    setFailure(null)
    setConfirming(null)
    setOpenKey(entry.ticketKey)
    setDraft({
      ticketKey: entry.ticketKey,
      revision: entry.revision,
      line: entry.line,
      notes: entry.notes ?? '',
    })
  }, [])

  const save = useCallback(() => {
    if (draft === null) return
    setSaving(true)
    setFailure(null)

    onRevise({
      ticketKey: draft.ticketKey,
      revision: draft.revision,
      line: draft.line,
      // Empty clears. The service reads `null` and `''` the same way; sending
      // the distinction rather than relying on that keeps this end honest.
      notes: draft.notes.trim() === '' ? null : draft.notes,
    })
      .then(() => setDraft(null))
      .catch((e: unknown) =>
        setFailure({
          ticketKey: draft.ticketKey,
          message: e instanceof Error ? e.message : 'That change could not be saved.',
        }),
      )
      .finally(() => setSaving(false))
  }, [draft, onRevise])

  const remove = useCallback(
    (entry: TicketHistoryEntry) => {
      if (confirming !== entry.ticketKey) {
        setConfirming(entry.ticketKey)
        return
      }

      setConfirming(null)
      setFailure(null)
      onDelete({ ticketKey: entry.ticketKey, revision: entry.revision }).catch((e: unknown) =>
        setFailure({
          ticketKey: entry.ticketKey,
          message: e instanceof Error ? e.message : 'That entry could not be deleted.',
        }),
      )
    },
    [confirming, onDelete],
  )

  const count = query.trim() === '' ? entries.length : `${filtered.length} of ${entries.length}`

  return (
    <Section id="ticket-history" title="Ticket history" className="lane" count={count}>
      {entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          {/*
            FR-159. Empty on every fresh install, exactly like the prompts panel,
            so it has to read as "not written yet" rather than "broken" — and it
            names the tool, because the operator's next action is to put that
            name in front of an agent.
          */}
          Agents write these through <code>grndctrl-mcp</code>, with{' '}
          <code>grndctrl_record_ticket_history</code>. One line per ticket, kept for good — this is
          the record to read back when somebody asks what was done.
        </EmptyState>
      ) : (
        <>
          <div className="history__search">
            <label className="history__search-label" htmlFor="history-search">
              Search
            </label>
            <input
              id="history-search"
              type="search"
              className="history__search-input"
              placeholder="Ticket, word, anything in the notes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="history__none" role="status">
              Nothing in the history matches “{query.trim()}”.
            </p>
          ) : (
            filtered.map((entry) => {
              const expanded = openKey === entry.ticketKey
              const editing = draft?.ticketKey === entry.ticketKey
              const failed = failure?.ticketKey === entry.ticketKey ? failure : null

              return (
                <div
                  key={entry.ticketKey}
                  className="history"
                  data-history={entry.ticketKey}
                  data-expanded={expanded}
                >
                  <button
                    type="button"
                    className="history__head"
                    aria-expanded={expanded}
                    onClick={() => {
                      setConfirming(null)
                      setOpenKey(expanded ? null : entry.ticketKey)
                    }}
                  >
                    <span className="history__key">{entry.issueKey ?? entry.ticketKey}</span>
                    <span className="history__line">{entry.line}</span>
                  </button>

                  <span className="history__age">{formatAge(entry.updatedAt, now)}</span>

                  {!expanded ? null : (
                    <div className="history__body">
                      {/*
                        The ticket's summary as it was when the entry was last
                        written, not as it is now — by the time this is read the
                        ticket has usually left the board (FR-149). Labelled
                        rather than presented as current.
                      */}
                      {entry.ticketSummary === null ? null : (
                        <p className="history__summary">{entry.ticketSummary}</p>
                      )}

                      {editing ? (
                        <div className="history__editor">
                          <label className="history__field">
                            <span>Line</span>
                            <input
                              type="text"
                              value={draft.line}
                              maxLength={200}
                              onChange={(e) => setDraft({ ...draft, line: e.target.value })}
                            />
                          </label>

                          <label className="history__field">
                            <span>Notes</span>
                            <textarea
                              rows={8}
                              value={draft.notes}
                              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                            />
                          </label>

                          <div className="history__controls">
                            <button
                              type="button"
                              className="ghost history__save"
                              onClick={save}
                              disabled={saving || draft.line.trim() === ''}
                            >
                              {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => {
                                setDraft(null)
                                setFailure(null)
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {entry.notes === null ? (
                            <p className="history__empty-notes">No notes on this one.</p>
                          ) : (
                            /*
                             * `white-space: pre-wrap`, set in the stylesheet. The
                             * notes accumulate as paragraphs separated by blank
                             * lines, and collapsing them would run a year of
                             * separate entries into one block of text.
                             */
                            <p className="history__notes">{entry.notes}</p>
                          )}

                          <div className="history__controls">
                            <span className="history__author">
                              {entry.authorKind === 'user' ? 'you' : (entry.authorId ?? 'an agent')}
                            </span>
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => startEditing(entry)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="ghost history__delete"
                              data-confirming={confirming === entry.ticketKey}
                              onClick={() => remove(entry)}
                            >
                              {confirming === entry.ticketKey ? 'Really delete' : 'Delete'}
                            </button>
                          </div>
                        </>
                      )}

                      {failed === null ? null : (
                        // `role="alert"` rather than `status`: this is a refusal
                        // the operator has to act on, and the commonest one is a
                        // conflict where their draft is still in the box above.
                        <p className="history__failed" role="alert">
                          {failed.message}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </>
      )}
    </Section>
  )
}
