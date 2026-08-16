import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { credentialRef, inMemoryKeychain, unavailableKeychain } from '../../src/auth/keychain.js'
import { connectionsService, type ConnectionsService } from '../../src/services/connections.js'
import { mirrorRepository, type MirrorRepository } from '../../src/store/mirror/repository.js'
import { openMirror } from '../../src/store/open.js'
import { isOperationError } from '../../src/registry/errors.js'

/**
 * The only path by which a secret enters the application.
 *
 * Constitution XI says credentials live in the OS keychain and nowhere else, and
 * FR-005 to FR-007 say what the operator can do with them. What is checked here
 * is mostly the *ordering* and the *refusals* — the parts that look like
 * paranoia until the day the keychain is unreachable and the application has
 * already told the operator it stored something.
 */

let dir: string
let db: Database
let mirror: MirrorRepository
let store: ReturnType<typeof inMemoryKeychain>
let connections: ConnectionsService

const JIRA = {
  kind: 'jira' as const,
  siteOrHost: 'acme.atlassian.net',
  accountLabel: 'jon@acme.com',
  secret: 'a-token',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-conn-'))
  db = openMirror({ dir }).db
  mirror = mirrorRepository(db)
  store = inMemoryKeychain()
  connections = connectionsService({ mirror, credentials: store, projects: () => [] })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('adding a credential', () => {
  it('puts the secret in the keychain and a handle in the row', () => {
    const connection = connections.add(JIRA)

    expect(store.get(credentialRef(connection.id))).toBe('a-token')
    expect(connection.credentialRef).toBe(`grndctrl/${connection.id}`)

    // The row is what a backup, a screenshot or a `git add .` could pick up, so
    // no field of it may carry any part of the secret (XI, SC-011).
    expect(JSON.stringify(connection)).not.toContain('a-token')
  })

  it('normalises a pasted URL to a host', () => {
    // The site is folded into every ticket's subject key, so getting it wrong
    // here is not a broken link — it is a migration.
    const connection = connections.add({ ...JIRA, siteOrHost: 'https://acme.atlassian.net/' })
    expect(connection.siteOrHost).toBe('acme.atlassian.net')
  })

  it('refuses a secret with surrounding whitespace rather than trimming it', () => {
    // Silently altering a secret is its own class of confusion: the operator
    // would be told it was stored, and it would authenticate as nobody.
    expect(() => connections.add({ ...JIRA, secret: 'a-token\n' })).toThrow(/whitespace/)
    expect(store.get(credentialRef('jira'))).toBeNull()
  })

  it('requires the account label, and says why per provider', () => {
    expect(() => connections.add({ ...JIRA, accountLabel: '' })).toThrow(/email plus token/)
    expect(() =>
      connections.add({ kind: 'github', siteOrHost: 'github.com', accountLabel: '', secret: 'x' }),
    ).toThrow(/pull requests/)
  })

  it('replaces the credential when the same account is re-authorized', () => {
    const first = connections.add(JIRA)
    const second = connections.add({ ...JIRA, secret: 'a-new-token' })

    // One connection, not two. A second row for the same account is
    // indistinguishable on screen and syncs twice (FR-007).
    expect(second.id).toBe(first.id)
    expect(mirror.listConnections()).toHaveLength(1)
    expect(store.get(credentialRef(first.id))).toBe('a-new-token')
  })

  it('keeps a resolved identity across a re-authorization', () => {
    const first = connections.add(JIRA)
    mirror.upsertConnection({
      ...first,
      viewerIdentity: { accountId: 'acct-1', displayName: 'Jon', email: null },
    })

    const again = connections.add({ ...JIRA, secret: 'rotated' })
    expect(again.viewerIdentity?.accountId).toBe('acct-1')
  })

  it('gives a second account of the same kind its own connection', () => {
    // FR-002: multiple provider accounts, and a project binds to one of them.
    const first = connections.add(JIRA)
    const second = connections.add({ ...JIRA, accountLabel: 'other@acme.com', secret: 'b' })

    expect(second.id).not.toBe(first.id)
    expect(mirror.listConnections()).toHaveLength(2)
    expect(store.get(credentialRef(first.id))).toBe('a-token')
    expect(store.get(credentialRef(second.id))).toBe('b')
  })

  it('writes no row when the keychain is unreachable', () => {
    // FR-006. A row written here would claim a configured connection whose
    // secret does not exist, and the failure would surface at the first sync
    // as an auth error — pointing the operator at the wrong problem.
    const refusing = connectionsService({
      mirror,
      credentials: unavailableKeychain(),
      projects: () => [],
    })

    expect(() => refusing.add(JIRA)).toThrow()
    expect(mirror.listConnections()).toEqual([])
  })

  it('writes no row when the keychain accepts but does not return the secret', () => {
    const amnesiac = { ...inMemoryKeychain(), get: () => null }
    const unreliable = connectionsService({ mirror, credentials: amnesiac, projects: () => [] })

    expect(() => unreliable.add(JIRA)).toThrow(/did not return it/)
    expect(mirror.listConnections()).toEqual([])
  })
})

describe('removing a connection', () => {
  it('deletes the credential as well as the row', () => {
    const connection = connections.add(JIRA)
    expect(connections.remove(connection.id)).toEqual({ removed: true })

    // FR-007. A row deleted without its secret leaves a credential in the OS
    // keychain that nothing references and no screen can reach.
    expect(store.get(credentialRef(connection.id))).toBeNull()
    expect(mirror.listConnections()).toEqual([])
  })

  it('reports an unknown connection rather than throwing', () => {
    expect(connections.remove('nope')).toEqual({ removed: false })
  })
})

describe('testing a connection', () => {
  it('reports a missing credential as its own check, not as an auth failure', async () => {
    mirror.upsertConnection({
      id: 'jira',
      kind: 'jira',
      siteOrHost: 'acme.atlassian.net',
      accountLabel: 'jon@acme.com',
      viewerIdentity: null,
      credentialRef: 'grndctrl/jira',
    })

    const result = await connections.test({ connectionId: 'jira' })

    expect(result.ok).toBe(false)
    expect(result.checks[0]?.name).toBe('credential')
  })

  it('reports an unreachable keychain separately from a bad token', async () => {
    // Different condition, different remedy (FR-006). Folding them together
    // sends the operator to re-issue a token that was never the problem.
    connections.add(JIRA)
    const refusing = connectionsService({
      mirror,
      credentials: unavailableKeychain(),
      projects: () => [],
    })

    const result = await refusing.test({ connectionId: 'jira' })
    expect(result.checks[0]?.name).toBe('credential store')
  })

  it('refuses to test a connection that does not exist', async () => {
    await expect(connections.test({ connectionId: 'ghost' })).rejects.toSatisfy(
      (e: unknown) => isOperationError(e) && e.code === 'not_found',
    )
  })

  it('says which repository it needs when GitHub has nothing bound', async () => {
    // A fine-grained token is scoped per repository, so "can it read a
    // repository" is not answerable without naming one — and the operator has
    // to be told that rather than shown a bare failure. Authentication has to
    // *succeed* for this to be the interesting case, so the viewer is stubbed.
    const fetcher = async () =>
      new Response(JSON.stringify({ data: { viewer: { id: 'u1', login: 'jon', name: 'Jon' } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })

    const stubbed = connectionsService({ mirror, credentials: store, projects: () => [], fetcher })
    stubbed.add({ kind: 'github', siteOrHost: 'github.com', accountLabel: 'jon', secret: 'x' })

    const result = await stubbed.test({ connectionId: 'github' })

    expect(result.checks.find((c) => c.name === 'authentication')?.ok).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.checks.find((c) => c.name === 'repository')?.detail).toMatch(
      /scoped per repository/,
    )
  })
})
