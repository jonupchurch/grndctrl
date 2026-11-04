import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { Section } from '../components/Section.js'
import type { Todo } from '../types.js'

/**
 * The to-do list (009).
 *
 * The operator adds items here; agents add them over MCP with
 * `grndctrl_add_todo`. Each item can be linked to one ticket, picked from the
 * tickets on the board. A ticket row's to-do badge opens this panel narrowed to
 * that ticket with the add box already linked to it — that is the "link from a
 * ticket" path.
 *
 * Open items first, then ticked-off ones behind a toggle, so the list stays
 * about what is left to do.
 */

export interface TicketOption {
  key: string
  issueKey: string
  summary: string
}

export interface TodosProps {
  todos: readonly Todo[]
  /** Tickets the link picker offers. A linked ticket missing from here still shows its key. */
  tickets: readonly TicketOption[]
  /** The ticket the panel is narrowed to, or null for the whole list. */
  focusTicket: string | null
  onFocusTicket(key: string | null): void
  /** Bumped each time a ticket row asks for this panel, so it scrolls and focuses again. */
  focusRequest: number
  onCreate(request: { text: string; ticketKey: string | null }): Promise<void>
  onUpdate(request: {
    id: string
    revision: number
    text?: string
    ticketKey?: string | null
    done?: boolean
  }): Promise<void>
  onDelete(request: { id: string; revision: number }): Promise<void>
}

const message = (e: unknown, fallback: string): string =>
  e instanceof Error ? e.message : fallback

export function Todos({
  todos,
  tickets,
  focusTicket,
  onFocusTicket,
  focusRequest,
  onCreate,
  onUpdate,
  onDelete,
}: TodosProps): ReactElement {
  const [text, setText] = useState('')
  const [link, setLink] = useState<string>('')
  const [showDone, setShowDone] = useState(false)
  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<{ id: string | null; message: string } | null>(null)
  const [editing, setEditing] = useState<{ id: string; revision: number; text: string } | null>(
    null,
  )
  const [linking, setLinking] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  // A ticket row asked for this panel: link the add box to that ticket, bring
  // the panel into view, and put the cursor in the box.
  useEffect(() => {
    if (focusRequest === 0) return
    setLink(focusTicket ?? '')
    anchor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    input.current?.focus()
  }, [focusRequest])

  const labelOf = useMemo(() => {
    const byKey = new Map(tickets.map((t) => [t.key, t]))
    return (todo: Todo): string | null =>
      todo.ticketKey === null
        ? null
        : (byKey.get(todo.ticketKey)?.issueKey ?? todo.issueKey ?? todo.ticketKey)
  }, [tickets])

  const scoped = focusTicket === null ? todos : todos.filter((t) => t.ticketKey === focusTicket)
  const open = scoped.filter((t) => t.doneAt === null)
  const done = scoped.filter((t) => t.doneAt !== null)
  const focusLabel =
    focusTicket === null
      ? null
      : (tickets.find((t) => t.key === focusTicket)?.issueKey ??
        todos.find((t) => t.ticketKey === focusTicket)?.issueKey ??
        focusTicket)

  const add = (): void => {
    const trimmed = text.trim()
    if (trimmed === '' || adding) return
    setAdding(true)
    setFailure(null)
    onCreate({ text: trimmed, ticketKey: link === '' ? null : link })
      .then(() => setText(''))
      .catch((e: unknown) =>
        setFailure({ id: null, message: message(e, 'That to-do could not be added.') }),
      )
      .finally(() => setAdding(false))
  }

  const update = (
    todo: Todo,
    patch: { text?: string; ticketKey?: string | null; done?: boolean },
  ): void => {
    setFailure(null)
    onUpdate({ id: todo.id, revision: todo.revision, ...patch })
      .then(() => {
        setEditing(null)
        setLinking(null)
      })
      .catch((e: unknown) =>
        setFailure({ id: todo.id, message: message(e, 'That change could not be saved.') }),
      )
  }

  const remove = (todo: Todo): void => {
    if (confirming !== todo.id) {
      setConfirming(todo.id)
      return
    }
    setConfirming(null)
    setFailure(null)
    onDelete({ id: todo.id, revision: todo.revision }).catch((e: unknown) =>
      setFailure({ id: todo.id, message: message(e, 'That to-do could not be deleted.') }),
    )
  }

  const ticketSelect = (
    value: string,
    onChange: (v: string) => void,
    id?: string,
  ): ReactElement => (
    <select
      {...(id === undefined ? {} : { id })}
      className="todos__link"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Linked ticket"
    >
      <option value="">No ticket</option>
      {/* A link to a ticket that has left the board still has to be selectable,
          or opening the picker would silently offer to unlink it. */}
      {value !== '' && !tickets.some((t) => t.key === value) && (
        <option value={value}>{value}</option>
      )}
      {tickets.map((t) => (
        <option key={t.key} value={t.key}>
          {t.issueKey} — {t.summary}
        </option>
      ))}
    </select>
  )

  const item = (todo: Todo): ReactElement => {
    const label = labelOf(todo)
    const isEditing = editing?.id === todo.id
    const failed = failure?.id === todo.id ? failure : null

    return (
      <li key={todo.id} className="todo" data-todo={todo.id} data-done={todo.doneAt !== null}>
        <input
          type="checkbox"
          className="todo__check"
          checked={todo.doneAt !== null}
          onChange={(e) => update(todo, { done: e.target.checked })}
          aria-label={todo.doneAt === null ? `Mark “${todo.text}” done` : `Reopen “${todo.text}”`}
        />

        {isEditing ? (
          <input
            type="text"
            className="todo__edit"
            value={editing.text}
            maxLength={500}
            autoFocus
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && editing.text.trim() !== '')
                update(todo, { text: editing.text })
              if (e.key === 'Escape') setEditing(null)
            }}
            aria-label="To-do text"
          />
        ) : (
          <span
            className="todo__text"
            onDoubleClick={() =>
              setEditing({ id: todo.id, revision: todo.revision, text: todo.text })
            }
          >
            {todo.text}
          </span>
        )}

        {linking === todo.id ? (
          ticketSelect(todo.ticketKey ?? '', (v) =>
            update(todo, { ticketKey: v === '' ? null : v }),
          )
        ) : (
          <button
            type="button"
            className="todo__ticket"
            data-linked={label !== null}
            onClick={() => setLinking(todo.id)}
            title={label === null ? 'Link to a ticket' : 'Change the linked ticket'}
          >
            {label ?? 'Link'}
          </button>
        )}

        <span className="todo__author">
          {todo.authorKind === 'user' ? 'you' : (todo.authorId ?? 'agent')}
        </span>

        <span className="todo__controls">
          {isEditing ? (
            <>
              <button
                type="button"
                className="ghost"
                disabled={editing.text.trim() === ''}
                onClick={() => update(todo, { text: editing.text })}
              >
                Save
              </button>
              <button type="button" className="ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setConfirming(null)
                  setEditing({ id: todo.id, revision: todo.revision, text: todo.text })
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="ghost todo__delete"
                data-confirming={confirming === todo.id}
                onClick={() => remove(todo)}
              >
                {confirming === todo.id ? 'Really delete' : 'Delete'}
              </button>
            </>
          )}
        </span>

        {failed === null ? null : (
          <p className="todo__failed" role="alert">
            {failed.message}
          </p>
        )}
      </li>
    )
  }

  const count = focusTicket === null ? open.length : `${open.length} on ${focusLabel}`

  return (
    <div ref={anchor}>
      <Section id="todos" title="To do" className="lane" count={count}>
        <div className="todos__add">
          <input
            ref={input}
            type="text"
            className="todos__input"
            placeholder={focusLabel === null ? 'Add a to-do' : `Add a to-do for ${focusLabel}`}
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            aria-label="New to-do"
          />
          {ticketSelect(link, setLink, 'todo-link')}
          <button
            type="button"
            className="ghost"
            onClick={add}
            disabled={adding || text.trim() === ''}
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>

        {failure?.id === null ? (
          <p className="todo__failed" role="alert">
            {failure.message}
          </p>
        ) : null}

        {focusTicket === null ? null : (
          <p className="todos__scope">
            Showing to-dos for {focusLabel}.{' '}
            <button
              type="button"
              className="ghost"
              onClick={() => {
                onFocusTicket(null)
                setLink('')
              }}
            >
              Show all
            </button>
          </p>
        )}

        {scoped.length === 0 ? (
          <EmptyState title="Nothing to do">
            {focusTicket === null ? (
              <>
                Add one above, or have an agent add one with <code>grndctrl_add_todo</code>.
              </>
            ) : (
              <>No to-dos are linked to {focusLabel}.</>
            )}
          </EmptyState>
        ) : (
          <>
            {open.length === 0 ? (
              <p className="todos__none">Everything here is done.</p>
            ) : (
              <ul className="todos">{open.map(item)}</ul>
            )}

            {done.length === 0 ? null : (
              <>
                <button
                  type="button"
                  className="ghost todos__toggle-done"
                  aria-expanded={showDone}
                  onClick={() => setShowDone(!showDone)}
                >
                  {showDone ? 'Hide' : 'Show'} {done.length} done
                </button>
                {showDone && <ul className="todos todos--done">{done.map(item)}</ul>}
              </>
            )}
          </>
        )}
      </Section>
    </div>
  )
}
