import { useState, type FormEvent, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BridgeError, call } from '../bridge.js'

/**
 * Projects: a name, a ticket project, and a documentation link (FR-001 to FR-003).
 *
 * **This screen used to bind three things**: a ticket project, a repository, and
 * the local paths the repository was checked out to. Two of them are gone with
 * the providers behind them, and with them goes the argument this file used to
 * open with — that every binding is optional because a project with tickets and
 * no repository is a legitimate shape. There is one binding now, so it is not
 * optional: a project that names no ticket project has nothing to show, and
 * `projects.upsert` refuses it by name rather than letting SQLite refuse it by
 * constraint.
 *
 * **The ticket-key pattern went too**, and it is worth saying why here rather
 * than only in the changelog. It existed to answer one question — *does this
 * branch or pull request name a ticket?* — asked by `correlation/match.ts`,
 * which 006 deletes. It was the setting most likely to be wrong in a way nothing
 * else explained; it is now the setting most likely to be *read* in a way nothing
 * else honours, which is worse. A field the operator can carefully get right and
 * which changes nothing is a lie the interface tells slowly.
 */

interface Connection {
  id: string
  kind: 'jira'
  siteOrHost: string
  accountLabel: string
}

interface Project {
  id: string
  code: string
  name: string
  colorIndex: number | null
  jiraConnectionId: string | null
  jiraProjectKey: string | null
  documentationUrl: string | null
  statusOverrides: Record<string, 'blocked' | 'terminal' | 'in-progress' | 'backlog'>
}

export function Projects(): ReactElement {
  const client = useQueryClient()
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => call('projects.list') as Promise<Project[]>,
  })
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => call('connections.list') as Promise<Connection[]>,
  })

  const [editing, setEditing] = useState<Project | null>(null)

  const remove = useMutation({
    mutationFn: (id: string) => call('projects.remove', { id }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['projects'] }),
  })

  return (
    <section className="settings__section" aria-labelledby="projects-heading">
      <h2 id="projects-heading">Projects</h2>
      <p className="settings__note">
        A project names one ticket project in Jira. Everything on the board is grouped by it, and
        the chip on every row is its short code.
      </p>

      {projects.data?.length === 0 && (
        <p className="settings__empty">No projects yet. Add one below.</p>
      )}

      <ul className="settings__list">
        {(projects.data ?? []).map((project) => (
          <li key={project.id} className="settings__row">
            <div className="settings__row-main">
              <strong>
                {project.code} · {project.name}
              </strong>
              {/*
                One line where there were three. The other two reported the
                repository and the local checkouts, and the checkout line carried
                a warning — "no local checkout, branches and uncommitted work
                will not appear" — about two lanes that no longer exist.

                `no ticket project` stays reachable, and that is deliberate. New
                projects cannot be saved without one, but a database written by
                0.3.0 can hold a repository-only project, and 006 keeps that row
                rather than deleting the operator's data to satisfy a new rule.
                It has to render as something, and what it renders is the truth.
              */}
              <span className="settings__meta">
                {project.jiraProjectKey ?? 'no ticket project — nothing to show for this one'}
              </span>
            </div>

            <div className="settings__row-actions">
              <button type="button" className="ghost" onClick={() => setEditing(project)}>
                Edit
              </button>
              <button type="button" className="ghost" onClick={() => remove.mutate(project.id)}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <ProjectForm
        key={editing?.id ?? 'new'}
        project={editing}
        connections={connections.data ?? []}
        onSaved={() => {
          setEditing(null)
          void client.invalidateQueries({ queryKey: ['projects'] })
        }}
        onCancel={() => setEditing(null)}
      />
    </section>
  )
}

interface ProjectFormProps {
  project: Project | null
  connections: readonly Connection[]
  onSaved(): void
  onCancel(): void
}

function ProjectForm({ project, connections, onSaved, onCancel }: ProjectFormProps): ReactElement {
  const [code, setCode] = useState(project?.code ?? '')
  const [name, setName] = useState(project?.name ?? '')
  const [jiraProjectKey, setJiraProjectKey] = useState(project?.jiraProjectKey ?? '')
  const [documentationUrl, setDocumentationUrl] = useState(project?.documentationUrl ?? '')
  const [error, setError] = useState<string | null>(null)

  const jira = connections.filter((c) => c.kind === 'jira')

  const [jiraConnectionId, setJiraConnectionId] = useState(
    project?.jiraConnectionId ?? jira[0]?.id ?? '',
  )

  const save = useMutation({
    mutationFn: (input: Project) => call('projects.upsert', input),
    onSuccess: () => onSaved(),
    onError: (e: Error) =>
      setError(e instanceof BridgeError ? e.message : 'Could not save that project.'),
  })

  function submit(event: FormEvent): void {
    event.preventDefault()
    setError(null)

    if (jiraProjectKey.trim() === '') {
      // Also enforced by `projects.upsert`, and that is the one that matters —
      // this one is here so the operator finds out while their hands are still
      // on the form rather than after a round trip.
      setError('A project needs a ticket project key. Without one there is nothing to show.')
      return
    }

    save.mutate({
      id: project?.id ?? code.trim().toLowerCase(),
      code: code.trim(),
      name: name.trim() === '' ? code.trim() : name.trim(),
      colorIndex: project?.colorIndex ?? null,
      jiraConnectionId: jiraConnectionId === '' ? null : jiraConnectionId,
      jiraProjectKey: jiraProjectKey.trim(),
      documentationUrl: documentationUrl.trim() === '' ? null : documentationUrl.trim(),
      statusOverrides: project?.statusOverrides ?? {},
    })
  }

  return (
    <form className="settings__form" onSubmit={submit}>
      <h3>{project === null ? 'Add a project' : `Edit ${project.code}`}</h3>

      <label>
        Short code
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MERC" required />
        <span className="settings__hint">Shown on every row as the project chip.</span>
      </label>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mercury" />
      </label>

      <label>
        Ticket project key
        <input
          value={jiraProjectKey}
          onChange={(e) => setJiraProjectKey(e.target.value)}
          placeholder="MERC"
          required
        />
        <span className="settings__hint">
          The key Jira puts in front of every issue number in this project.
        </span>
      </label>

      {jira.length > 1 && (
        // Only when there is a choice to make. FR-002 binds a project to a
        // specific account rather than a global one, but a picker with one entry
        // is a question with one answer.
        <label>
          Jira account
          <select value={jiraConnectionId} onChange={(e) => setJiraConnectionId(e.target.value)}>
            {jira.map((c) => (
              <option key={c.id} value={c.id}>
                {c.siteOrHost} — {c.accountLabel}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        Documentation link
        <input
          value={documentationUrl}
          onChange={(e) => setDocumentationUrl(e.target.value)}
          placeholder="https://…"
        />
        <span className="settings__hint">Stored and linked only. Never fetched or polled.</span>
      </label>

      {error !== null && (
        <p className="settings__warn" role="alert">
          {error}
        </p>
      )}

      <div className="settings__row-actions">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save project'}
        </button>
        {project !== null && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

