import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState, type ReactElement } from 'react'
import { call, conflictingNote, BridgeError } from '../bridge.js'
import { useOperation } from '../query.js'
import type { Note } from '../types.js'
import { formatAge } from './StaleBar.js'
import { Modal } from './Modal.js'

/**
 * Notes on one subject: read, add, edit, delete (T149).
 *
 * Notes are the part of this application that is not a mirror of somebody
 * else's system. A ticket is Jira's, a pull request is GitHub's, and both are
 * replaced wholesale on the next sync — but a note is the operator's own, and it
 * is also an agent's: both write here, both read here (FR-054). That is what
 * makes it worth the modal. A gotcha an agent hit at 2am is worth exactly as
 * much as the operator's own, and neither is anywhere else.
 *
 * **The conflict path is the reason this is not a text box.** `notes.update`
 * takes the revision that was read and rejects a stale one — optimistic
 * concurrency, because an agent may well be writing to the same subject while
 * the operator types (FR-055). The rejected write comes back carrying the row
 * that won, and this shows *both*: the other text above, the draft still in the
 * box below. An error that said only "changed by someone else" would force a
 * reload, which discards the draft to find out what it lost to.
 */

const TYPES: { value: Note['type']; label: string }[] = [
  { value: 'decision', label: 'Decision' },
  { value: 'gotcha', label: 'Gotcha' },
  { value: 'question-for-human', label: 'Question for human' },
  { value: 'todo', label: 'To do' },
]

export interface NotesModalProps {
  subjectKey: string
  /** What the row said, so the dialog names the thing rather than its key. */
  subjectLabel: string
  onClose(): void
  now?: Date
}

export function NotesModal({
  subjectKey,
  subjectLabel,
  onClose,
  now,
}: NotesModalProps): ReactElement {
  const client = useQueryClient()
  const notes = useOperation<Note[]>('notes.list', { subjectKey })

  const [draft, setDraft] = useState('')
  const [type, setType] = useState<Note['type']>('decision')
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ body: string; revision: number } | null>(null)

  /**
   * Every write goes through here, so there is one place that invalidates.
   *
   * The counts on the rows behind the dialog are a different query
   * (`notes.counts`, one call for a whole lane) and the Attention nudges a third
   * (`notes.questions`). A note created here changes all three, and a modal that
   * refreshed only its own list would leave a badge reading 2 over a subject
   * with three notes until the next sync.
   */
  const write = useCallback(
    async (run: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true)
      setError(null)
      setConflict(null)

      try {
        await run()
        await Promise.all([
          client.invalidateQueries({ queryKey: ['notes.list'] }),
          client.invalidateQueries({ queryKey: ['notes.counts'] }),
          client.invalidateQueries({ queryKey: ['notes.questions'] }),
          client.invalidateQueries({ queryKey: ['work.list'] }),
        ])
        return true
      } catch (cause) {
        const lost = conflictingNote(cause)
        if (lost !== null) setConflict(lost)
        setError(cause instanceof BridgeError ? cause.message : 'That did not save.')
        // The list is refetched even on a conflict: the operator is about to
        // decide between two texts and needs the current one on screen.
        await client.invalidateQueries({ queryKey: ['notes.list'] })
        return false
      } finally {
        setBusy(false)
      }
    },
    [client],
  )

  const submit = useCallback(async (): Promise<void> => {
    const body = draft.trim()
    if (body === '') return

    // `?? null` rather than leaving it `undefined`: `find` can miss even when
    // `editing` is set — the note may have been deleted by an agent between the
    // Edit click and this one — and that has to fall through to *create*, not
    // to an update against a note that no longer exists.
    const existing =
      editing === null ? null : ((notes.data ?? []).find((n) => n.id === editing) ?? null)

    const ok = await write(() =>
      existing === null
        ? call('notes.create', { subjectKey, type, body })
        : call('notes.update', { id: existing.id, revision: existing.revision, body, type }),
    )

    if (ok) {
      setDraft('')
      setEditing(null)
      setType('decision')
    }
  }, [draft, editing, notes.data, subjectKey, type, write])

  const rows = notes.data ?? []

  return (
    <Modal
      title="Notes"
      description={subjectLabel}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            data-tone="primary"
            disabled={busy || draft.trim() === ''}
            onClick={() => void submit()}
          >
            {editing === null ? 'Add note' : 'Save changes'}
          </button>
        </>
      }
    >
      <div className="notes">
        {notes.isPending && <p className="notes__empty">Reading…</p>}

        {notes.isError && (
          <p className="notes__empty" role="alert">
            These notes could not be read: {notes.error.message}
          </p>
        )}

        {!notes.isPending && rows.length === 0 && (
          <p className="notes__empty">
            No notes yet. Anything written here is readable by agents working on this, and anything
            they write lands here.
          </p>
        )}

        {/* Named, so it is distinguishable from the type picker below it — by a
            screen reader reading the dialog, and by anything else asking what
            is in here. Both contain the word "Gotcha". */}
        <ul className="notes__list" aria-label="Notes on this item">
          {rows.map((note) => (
            <li key={note.id} className="notes__note">
              <div className="notes__note-head">
                <span className="notes__type" data-type={note.type}>
                  {TYPES.find((t) => t.value === note.type)?.label ?? note.type}
                </span>
                {/* Who wrote it matters more here than anywhere else on the
                    board: an agent's note is a report, the operator's own is a
                    decision, and the two are read differently. `authorKind`
                    comes from the transport the write arrived on and is not
                    something a note body can claim. */}
                <span>{note.authorKind === 'agent' ? (note.authorId ?? 'an agent') : 'you'}</span>
                <span>{formatAge(note.updatedAt, now)}</span>
                {note.resolvedAt !== null && <span>· resolved</span>}

                <span className="notes__note-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(note.id)
                      setDraft(note.body)
                      setType(note.type)
                      setConflict(null)
                    }}
                  >
                    Edit
                  </button>
                  {note.type === 'question-for-human' && note.resolvedAt === null && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void write(() =>
                          call('notes.update', {
                            id: note.id,
                            revision: note.revision,
                            resolved: true,
                          }),
                        )
                      }
                    >
                      Mark answered
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void write(() => call('notes.delete', { id: note.id, revision: note.revision }))
                    }
                  >
                    Delete
                  </button>
                </span>
              </div>

              <p className="notes__body">{note.body}</p>
            </li>
          ))}
        </ul>

        {conflict !== null && (
          <div className="notes__conflict" role="alert">
            <strong>Someone else saved this first.</strong>
            <span>
              Their version is below and is now the current one. Yours is still in the box — copy
              across what you need, then save again.
            </span>
            <p className="notes__conflict-body">{conflict.body}</p>
          </div>
        )}

        {error !== null && conflict === null && (
          <p className="notes__empty" role="alert">
            {error}
          </p>
        )}

        <div className="notes__form">
          <label>
            Type
            <select
              value={type}
              onChange={(event) => setType(event.target.value as Note['type'])}
              disabled={busy}
            >
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            {editing === null ? 'New note' : 'Editing'}
            <textarea
              rows={4}
              value={draft}
              maxLength={8000}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="What should you — or an agent — know next time you open this?"
            />
          </label>

          {editing !== null && (
            <span className="notes__form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditing(null)
                  setDraft('')
                  setConflict(null)
                }}
              >
                Cancel edit
              </button>
            </span>
          )}
        </div>
      </div>
    </Modal>
  )
}
