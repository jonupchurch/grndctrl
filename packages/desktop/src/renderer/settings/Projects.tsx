import { useState, type FormEvent, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BridgeError, call } from '../bridge.js'

/**
 * Projects: one ticket project, one repository, and the local checkouts
 * (FR-001 to FR-003).
 *
 * Every binding is optional and that is deliberate, not laxity. A project with a
 * ticket project and no repository is how the board works before an
 * organisation has approved a code-host token; one with a repository and no
 * ticket project is how it works for code nobody files tickets against. Per
 * provider degradation is a first-class state (XV), so the absent half reports
 * as absent rather than as empty.
 *
 * The ticket-key pattern defaults from the bound project key and stays editable
 * (FR-003). It is shown rather than hidden because it is the single setting most
 * likely to be wrong in a way nothing else explains: a repository whose branches
 * read `feature/ACME-12` under a project keyed `ACM` correlates nothing, and the
 * symptom is a board of tickets with no code beside them.
 */

interface Connection {
  id: string
  kind: 'jira' | 'github'
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
  githubConnectionId: string | null
  repoOwner: string | null
  repoName: string | null
  documentationUrl: string | null
  ticketKeyPattern: string
  checkoutPaths: string[]
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
        A project joins a ticket project to a repository and the places you have it checked out.
        Either half may be left empty — the board reports the missing side as absent rather than
        pretending it is empty.
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
              <span className="settings__meta">
                {project.jiraProjectKey ?? 'no ticket project'} ·{' '}
                {project.repoOwner === null
                  ? 'no repository'
                  : `${project.repoOwner}/${project.repoName}`}
              </span>
              <span className="settings__meta">
                {project.checkoutPaths.length === 0
                  ? 'no local checkout — branches and uncommitted work will not appear'
                  : project.checkoutPaths.join(' · ')}
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
  const [repo, setRepo] = useState(
    project?.repoOwner === null || project?.repoOwner === undefined
      ? ''
      : `${project.repoOwner}/${project.repoName}`,
  )
  const [checkouts, setCheckouts] = useState(project?.checkoutPaths.join('\n') ?? '')
  const [documentationUrl, setDocumentationUrl] = useState(project?.documentationUrl ?? '')
  const [pattern, setPattern] = useState(project?.ticketKeyPattern ?? '')
  const [error, setError] = useState<string | null>(null)

  const jira = connections.filter((c) => c.kind === 'jira')
  const github = connections.filter((c) => c.kind === 'github')

  const [jiraConnectionId, setJiraConnectionId] = useState(
    project?.jiraConnectionId ?? jira[0]?.id ?? '',
  )
  const [githubConnectionId, setGithubConnectionId] = useState(
    project?.githubConnectionId ?? github[0]?.id ?? '',
  )

  // FR-003: the pattern defaults from the bound key. Only while the operator has
  // not typed one — overwriting an override on every keystroke of the key would
  // make the field impossible to edit.
  const effectivePattern =
    pattern !== '' ? pattern : jiraProjectKey === '' ? '' : `(${escapeRegex(jiraProjectKey)}-\\d+)`

  const save = useMutation({
    mutationFn: (input: Project) => call('projects.upsert', input),
    onSuccess: () => onSaved(),
    onError: (e: Error) =>
      setError(e instanceof BridgeError ? e.message : 'Could not save that project.'),
  })

  function submit(event: FormEvent): void {
    event.preventDefault()
    setError(null)

    const parsed = parseRepo(repo)
    if (repo !== '' && parsed === null) {
      setError('That repository should read owner/name, or be a GitHub URL.')
      return
    }

    save.mutate({
      id: project?.id ?? code.trim().toLowerCase(),
      code: code.trim(),
      name: name.trim() === '' ? code.trim() : name.trim(),
      colorIndex: project?.colorIndex ?? null,
      jiraConnectionId: jiraProjectKey === '' ? null : (jiraConnectionId === '' ? null : jiraConnectionId),
      jiraProjectKey: jiraProjectKey === '' ? null : jiraProjectKey.trim(),
      githubConnectionId: parsed === null ? null : (githubConnectionId === '' ? null : githubConnectionId),
      repoOwner: parsed?.owner ?? null,
      repoName: parsed?.name ?? null,
      documentationUrl: documentationUrl.trim() === '' ? null : documentationUrl.trim(),
      ticketKeyPattern: effectivePattern === '' ? `(${escapeRegex(code.trim() || 'X')}-\\d+)` : effectivePattern,
      // One per line. A path is allowed to contain almost anything including a
      // comma, so a separator that cannot appear in the value is the only one
      // that parses back correctly on Windows.
      checkoutPaths: checkouts.split('\n').map((p) => p.trim()).filter((p) => p !== ''),
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
        />
      </label>

      {jira.length > 1 && jiraProjectKey !== '' && (
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
        Repository
        <input
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder="acme/mercury"
        />
        <span className="settings__hint">owner/name, or paste the URL from your browser.</span>
      </label>

      {github.length > 1 && repo !== '' && (
        <label>
          GitHub account
          <select value={githubConnectionId} onChange={(e) => setGithubConnectionId(e.target.value)}>
            {github.map((c) => (
              <option key={c.id} value={c.id}>
                {c.siteOrHost} — {c.accountLabel}
              </option>
            ))}
          </select>
        </label>
      )}

      <label>
        Local checkouts
        <textarea
          value={checkouts}
          onChange={(e) => setCheckouts(e.target.value)}
          rows={3}
          placeholder={'D:\\work\\mercury'}
        />
        <span className="settings__hint">
          One path per line. Read only — Ground Control never modifies your working tree, index or
          branches, and never runs a git command that touches the network.
        </span>
      </label>

      <label>
        Documentation link
        <input
          value={documentationUrl}
          onChange={(e) => setDocumentationUrl(e.target.value)}
          placeholder="https://…"
        />
        <span className="settings__hint">Stored and linked only. Never fetched or polled.</span>
      </label>

      <label>
        Ticket key pattern
        <input
          value={effectivePattern}
          onChange={(e) => setPattern(e.target.value)}
          spellCheck={false}
        />
        <span className="settings__hint">
          How a branch or pull request names its ticket. Defaults from the key above; edit it if
          your branches read differently. It needs one capture group around the key.
        </span>
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

/** Accepts `owner/name`, a browser URL, a clone URL, or an SSH remote. */
function parseRepo(raw: string): { owner: string; name: string } | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const match = /(?:^|[/:])([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(trimmed)
  const owner = match?.[1]
  const name = match?.[2]
  return owner === undefined || name === undefined ? null : { owner, name }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
