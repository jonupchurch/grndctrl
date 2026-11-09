import { useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BridgeError, call } from '../bridge.js'
import { tagStyle, type TagDefinition } from '../components/TicketTag.js'

/**
 * Settings → Ticket tags (010): the tags a ticket row can carry.
 *
 * Edited as a draft and saved in one write, so typing a label does not rewrite
 * settings once per keystroke. A tag's id never changes once made, which is
 * what keeps every ticket on it through a rename or a recolour.
 */

const MAX_TAGS = 24

function newId(): string {
  return `tag-${Math.random().toString(36).slice(2, 10)}`
}

export function TicketTags(): ReactElement {
  const client = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings.get', 'ticketTags'],
    queryFn: () => call('settings.get') as Promise<{ ticketTags: TagDefinition[] }>,
  })

  const [draft, setDraft] = useState<TagDefinition[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const stored = settings.data?.ticketTags ?? null
  useEffect(() => {
    if (stored !== null && draft === null) setDraft(stored)
  }, [stored, draft])

  const save = useMutation({
    mutationFn: (ticketTags: TagDefinition[]) => call('settings.update', { ticketTags }),
    onSuccess: () => {
      setSaved(true)
      void client.invalidateQueries({ queryKey: ['settings.get'] })
      void client.invalidateQueries({ queryKey: ['tags.list'] })
    },
    onError: (e: Error) =>
      setError(e instanceof BridgeError ? e.message : 'Could not save the tags.'),
  })

  const tags = draft ?? []
  const change = (next: TagDefinition[]): void => {
    setDraft(next)
    setSaved(false)
    setError(null)
  }
  const patch = (id: string, p: Partial<TagDefinition>): void =>
    change(tags.map((t) => (t.id === id ? { ...t, ...p } : t)))

  const dirty = stored !== null && JSON.stringify(stored) !== JSON.stringify(tags)

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (tags.some((t) => t.label.trim() === '')) {
      setError('Every tag needs a name.')
      return
    }
    save.mutate(tags.map((t) => ({ ...t, label: t.label.trim() })))
  }

  return (
    <section className="settings__section" aria-labelledby="ticket-tags-heading">
      <h2 id="ticket-tags-heading">Ticket tags</h2>
      <p className="settings__note">
        A ticket can carry one of these, shown as a coloured tag at the start of its row. Set it
        from the <span aria-hidden="true">#</span> on a ticket row, or let an agent set it. Removing
        a tag here takes it off every ticket that has it.
      </p>

      <form className="settings__form ticket-tags" onSubmit={submit}>
        {tags.length === 0 && <p className="settings__empty">No tags. Add one below.</p>}
        <ul className="ticket-tags__list">
          {tags.map((tag, index) => (
            <li key={tag.id} className="ticket-tags__row">
              <span className="row__tag ticket-tags__preview" style={tagStyle(tag.color)}>
                {tag.label.trim() === '' ? '…' : tag.label}
              </span>
              <input
                aria-label={`Name of tag ${index + 1}`}
                value={tag.label}
                maxLength={24}
                onChange={(e) => patch(tag.id, { label: e.target.value })}
              />
              <input
                type="color"
                aria-label={`Colour of ${tag.label || `tag ${index + 1}`}`}
                value={tag.color}
                onChange={(e) => patch(tag.id, { color: e.target.value })}
              />
              <button
                type="button"
                className="ghost"
                disabled={index === 0}
                aria-label={`Move ${tag.label} up`}
                onClick={() => {
                  const next = [...tags]
                  ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
                  change(next)
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${tag.label}`}
                onClick={() => change(tags.filter((t) => t.id !== tag.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="ticket-tags__actions">
          <button
            type="button"
            className="ghost"
            disabled={tags.length >= MAX_TAGS}
            onClick={() => change([...tags, { id: newId(), label: '', color: '#6b7280' }])}
          >
            Add a tag
          </button>
          <button type="submit" disabled={!dirty || save.isPending}>
            Save tags
          </button>
          {dirty && (
            <button type="button" className="ghost" onClick={() => change(stored ?? [])}>
              Discard changes
            </button>
          )}
          {saved && !dirty && <span className="settings__hint">Saved.</span>}
        </div>
        {error !== null && (
          <p className="settings__warn" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}
