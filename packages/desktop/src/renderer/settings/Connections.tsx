import { useState, type FormEvent, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BridgeError, call, storeCredential } from '../bridge.js'

/**
 * Connections: add, test, re-authorize, remove (FR-005 to FR-007).
 *
 * Two rules shape this screen, and both are about what it must *not* do.
 *
 * **The secret is never read back.** There is no operation that returns one and
 * no bridge method that could — the field below starts empty every time, even
 * when re-authorizing an account that already has a working token, because the
 * alternative is a screen that holds a credential in renderer memory for as long
 * as it is open. The renderer is the process that renders provider-supplied
 * strings; it is the last one that should be holding a token.
 *
 * **Testing is separate from adding, and reports each check by name.** A GitHub
 * token can authenticate, read a repository, and still lack the scope `compare`
 * needs — and the only symptom is an ahead/behind column that is quietly empty
 * everywhere (research R3). Collapsing that into one tick would hide the single
 * failure most worth surfacing here.
 */

interface Connection {
  id: string
  kind: 'jira' | 'github'
  siteOrHost: string
  accountLabel: string
  viewerIdentity: { accountId: string; displayName: string | null } | null
  hasCredential: boolean
}

interface TestResult {
  ok: boolean
  viewerIdentity: { displayName: string } | null
  checks: { name: string; ok: boolean; detail: string }[]
}

export function Connections(): ReactElement {
  const client = useQueryClient()
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => call('connections.list') as Promise<Connection[]>,
  })

  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [failures, setFailures] = useState<Record<string, string>>({})

  const test = useMutation({
    mutationFn: (connectionId: string) =>
      call('connections.test', { connectionId }) as Promise<TestResult>,
    onSuccess: (result, connectionId) => setResults((r) => ({ ...r, [connectionId]: result })),
    onError: (error: Error, connectionId) =>
      setFailures((f) => ({ ...f, [connectionId]: error.message })),
  })

  const remove = useMutation({
    mutationFn: (connectionId: string) => call('connections.remove', { connectionId }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['connections'] }),
  })

  return (
    <section className="settings__section" aria-labelledby="connections-heading">
      <h2 id="connections-heading">Connections</h2>
      <p className="settings__note">
        Credentials are stored in your operating system’s keychain and nowhere else. Ground Control
        never writes one to a file, a database, or a log, and nothing here can read one back.
      </p>

      {connections.data?.length === 0 && (
        <p className="settings__empty">No connections yet. Add one below.</p>
      )}

      <ul className="settings__list">
        {(connections.data ?? []).map((connection) => (
          <li key={connection.id} className="settings__row">
            <div className="settings__row-main">
              <strong>{connection.siteOrHost}</strong>
              <span className="settings__meta">
                {connection.kind} · {connection.accountLabel}
                {connection.viewerIdentity !== null &&
                  ` · signed in as ${connection.viewerIdentity.displayName ?? connection.viewerIdentity.accountId}`}
              </span>
              {!connection.hasCredential && (
                <span className="settings__warn">
                  No credential stored — this connection cannot sync. Re-authorize it below.
                </span>
              )}
            </div>

            <div className="settings__row-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => test.mutate(connection.id)}
                disabled={test.isPending}
              >
                {test.isPending && test.variables === connection.id ? 'Testing…' : 'Test'}
              </button>
              <button type="button" className="ghost" onClick={() => remove.mutate(connection.id)}>
                Remove
              </button>
            </div>

            {failures[connection.id] !== undefined && (
              <p className="settings__warn" role="status">
                {failures[connection.id]}
              </p>
            )}

            {results[connection.id] !== undefined && (
              // Each check named and reported on its own line. `ok` and `not ok`
              // are words as well as marks, so the result survives greyscale and
              // colour-vision deficiency (FR-074).
              <ul className="settings__checks" role="status">
                {results[connection.id]?.checks.map((check) => (
                  <li key={check.name} data-ok={check.ok}>
                    <span aria-hidden="true">{check.ok ? '✓' : '✕'}</span>
                    <span className="settings__check-name">{check.name}</span>
                    <span>{check.ok ? '' : 'not ok — '}{check.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <AddConnection onAdded={() => void client.invalidateQueries({ queryKey: ['connections'] })} />
    </section>
  )
}

function AddConnection({ onAdded }: { onAdded(): void }): ReactElement {
  const [kind, setKind] = useState<'jira' | 'github'>('jira')
  const [siteOrHost, setSiteOrHost] = useState('')
  const [accountLabel, setAccountLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    setSaving(true)

    try {
      await storeCredential({ kind, siteOrHost, accountLabel, secret })
      // Dropped immediately on success. Holding it to pre-fill the field "in
      // case they need it again" is how a token ends up in a heap snapshot.
      setSecret('')
      setSiteOrHost('')
      setAccountLabel('')
      onAdded()
    } catch (e) {
      setError(e instanceof BridgeError ? e.message : 'Could not store that credential.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="settings__form" onSubmit={(e) => void submit(e)}>
      <h3>Add or re-authorize</h3>

      <div className="segmented" role="group" aria-label="Provider">
        <button type="button" aria-pressed={kind === 'jira'} onClick={() => setKind('jira')}>
          Jira
        </button>
        <button type="button" aria-pressed={kind === 'github'} onClick={() => setKind('github')}>
          GitHub
        </button>
      </div>

      <label>
        {kind === 'jira' ? 'Site' : 'Host'}
        <input
          value={siteOrHost}
          onChange={(e) => setSiteOrHost(e.target.value)}
          placeholder={kind === 'jira' ? 'acme.atlassian.net' : 'github.com'}
          required
        />
      </label>

      <label>
        {kind === 'jira' ? 'Account email' : 'Your GitHub login'}
        <input
          value={accountLabel}
          onChange={(e) => setAccountLabel(e.target.value)}
          placeholder={kind === 'jira' ? 'you@acme.com' : 'your-login'}
          required
        />
        <span className="settings__hint">
          {kind === 'jira'
            ? 'Jira Cloud authenticates as email plus token. Only the token is a secret.'
            : 'Not the organisation — your own login, so the board can tell your pull requests from everyone else’s.'}
        </span>
      </label>

      <label>
        {kind === 'jira' ? 'API token' : 'Personal access token'}
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <span className="settings__hint">
          {kind === 'jira'
            ? 'From id.atlassian.com → Security → API tokens. Use a scoped, read-only token if you are offered one.'
            : 'A fine-grained token, read-only on Metadata, Contents, Pull requests and Commit statuses. GitHub offers no “Checks” permission — CI results arrive with these. It is scoped to one owner, so pick the owner that holds the repositories you want.'}
        </span>
      </label>

      {error !== null && (
        <p className="settings__warn" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={saving}>
        {saving ? 'Storing…' : 'Store in keychain'}
      </button>
    </form>
  )
}
