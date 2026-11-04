import { randomUUID } from 'node:crypto'
import { issueKeyOfTicketKey, subjectKindOf, type NaturalKey } from '../domain/keys.js'
import type { Todo } from '../domain/types.js'
import { conflict, invalid, notFound } from '../registry/errors.js'
import type { Ctx } from '../registry/types.js'
import type { TodoFilter, TodoWriteResult, TodosRepository } from '../store/authored/todos.js'

/**
 * The to-do list (009).
 *
 * Both the operator and agents create, edit, link and tick off items; only the
 * operator deletes (`todos.delete` is `ui-only`). Ticking off is a timestamp
 * rather than a flag, so "when was this done" has an answer.
 *
 * A to-do links to at most one ticket. Linking is checked the way notes and the
 * history check it: the key must be a ticket key on a site something is
 * configured for, so a to-do is never attached to a key nothing can show.
 */

/** What a reader gets: the stored item plus the issue key from its link. */
export interface TodoView extends Todo {
  /** `MERC-1184`, or null when the to-do is not linked to a ticket. */
  issueKey: string | null
}

export interface TodosServiceDeps {
  todos: TodosRepository
  assertKnownSite?(key: NaturalKey): void
  /** Overridable so tests get stable ids. */
  newId?(): string
}

export interface CreateTodoRequest {
  text: string
  ticketKey?: NaturalKey | null | undefined
}

export interface UpdateTodoRequest {
  id: string
  revision: number
  text?: string | undefined
  /** `null` unlinks. */
  ticketKey?: NaturalKey | null | undefined
  done?: boolean | undefined
}

export interface TodosService {
  list(filter?: TodoFilter): TodoView[]
  create(input: CreateTodoRequest, ctx: Ctx): TodoView
  update(input: UpdateTodoRequest, ctx: Ctx): TodoView
  remove(input: { id: string; revision: number }): { id: string }
}

export const MAX_TODO_TEXT = 500

export function todosService(deps: TodosServiceDeps): TodosService {
  const { todos } = deps
  const newId = deps.newId ?? (() => `todo:${randomUUID()}`)

  const view = (todo: Todo): TodoView => ({
    ...todo,
    issueKey: todo.ticketKey === null ? null : issueKeyOfTicketKey(todo.ticketKey),
  })

  const unwrap = (result: TodoWriteResult): TodoView => {
    if (result.ok) return view(result.todo)
    if (result.reason === 'not_found') throw notFound('That to-do no longer exists.')
    throw conflict(
      'This to-do was changed by someone else while you were editing it.',
      view(result.current),
    )
  }

  const cleanText = (raw: string): string => {
    const text = raw.trim()
    if (text === '') throw invalid('A to-do needs some text.')
    if (/[\r\n]/.test(text)) {
      throw invalid('A to-do is one line. Put longer detail in a note on the linked ticket.')
    }
    if (text.length > MAX_TODO_TEXT) {
      throw invalid(
        `A to-do may be at most ${MAX_TODO_TEXT} characters; that one is ${text.length}.`,
      )
    }
    return text
  }

  const cleanLink = (key: NaturalKey | null): NaturalKey | null => {
    if (key === null) return null
    if (subjectKindOf(key) !== 'ticket') {
      throw invalid(
        `A to-do links to a ticket only; '${key}' is not a ticket key. A ticket key is jira:<site>/<ISSUE-KEY>.`,
      )
    }
    deps.assertKnownSite?.(key)
    return key
  }

  return {
    list: (filter) => todos.list(filter).map(view),

    create(input, ctx) {
      return view(
        todos.create({
          id: newId(),
          text: cleanText(input.text),
          ticketKey: cleanLink(input.ticketKey ?? null),
          authorKind: ctx.authorKind,
          authorId: ctx.authorId ?? null,
          at: ctx.now().toISOString(),
        }),
      )
    },

    update(input, ctx) {
      if (input.text === undefined && input.ticketKey === undefined && input.done === undefined) {
        throw invalid('An update needs something to change: text, ticketKey, or done.')
      }

      const at = ctx.now().toISOString()
      return unwrap(
        todos.update(
          input.id,
          input.revision,
          {
            ...(input.text === undefined ? {} : { text: cleanText(input.text) }),
            ...(input.ticketKey === undefined ? {} : { ticketKey: cleanLink(input.ticketKey) }),
            ...(input.done === undefined ? {} : { doneAt: input.done ? at : null }),
          },
          at,
        ),
      )
    },

    remove(input) {
      return { id: unwrap(todos.remove(input.id, input.revision)).id }
    },
  }
}
