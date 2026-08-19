import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialRefString,
  inMemoryKeychain,
  parseCredentialRef,
  type CredentialRef,
} from '../../src/auth/keychain.js'
import { MIRROR_MIGRATIONS } from '../../src/store/mirror/migrations.js'
import { migrate } from '../../src/store/migrate.js'
import { createCoreServices } from '../../src/runtime/services.js'
import { openMirror } from '../../src/store/open.js'

/**
 * FR-112: the secrets of connections the migration removed.
 *
 * A connection row holds a *handle* to where its secret lives, not the secret.
 * Migration 4 deletes the rows of every removed provider kind — and the moment
 * it does, the only record of where those secrets are is gone. What is left in
 * the operator's keychain is a live token that no screen can reach and no
 * operation can remove: unreachable, unremovable, and still a secret.
 *
 * **So the order is the guarantee**, and this file exists to hold it. The refs
 * are read in `openMirror` before `migrate` is called; the deletion happens in
 * `createCoreServices`, from what that read returned. Both halves are asserted,
 * and the ordering is asserted by breaking it — see the last test.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-orphans-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A `mirror.db` at version 3, with one connection of each kind. */
function seedV3(): void {
  const db = new Database(join(dir, 'mirror.db'))
  migrate(
    db,
    MIRROR_MIGRATIONS.filter((m) => m.version <= 3),
    () => '2026-08-14T12:00:00Z',
  )

  const insert = db.prepare(
    `INSERT INTO connections (id, kind, site_or_host, account_label, viewer_identity, credential_ref)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  )
  insert.run('jira', 'jira', 'acme.atlassian.net', 'jon@acme.com', 'grndctrl/jira')
  insert.run('github', 'github', 'github.com', 'jon', 'grndctrl/github')
  insert.run('github-2', 'github', 'ghe.acme.com', 'jon', 'grndctrl/github-2')

  db.close()
}

describe('the credential references a removed connection leaves behind', () => {
  it('are read before the migration drops the rows holding them', () => {
    seedV3()

    const opened = openMirror({ dir })
    try {
      expect(opened.orphanedCredentialRefs.sort()).toEqual([
        'grndctrl/github',
        'grndctrl/github-2',
      ])

      // And the rows really are gone by the time we look, so the read above
      // cannot have happened after.
      const kinds = (
        opened.db.prepare('SELECT kind FROM connections').all() as { kind: string }[]
      ).map((r) => r.kind)
      expect(kinds).toEqual(['jira'])
    } finally {
      opened.db.close()
    }
  })

  it('are empty on a database that has nothing to clean up', () => {
    // First run: no file at all. The read is guarded, and a missing
    // `connections` table is the ordinary case rather than a failure.
    const fresh = openMirror({ dir })
    expect(fresh.orphanedCredentialRefs).toEqual([])
    fresh.db.close()

    // And a second open of an already-migrated database asks nothing, because
    // the version guard has stopped applying.
    const again = openMirror({ dir })
    expect(again.orphanedCredentialRefs).toEqual([])
    again.db.close()
  })

  it('are deleted from the keychain, and only they are', () => {
    seedV3()

    const store = inMemoryKeychain()
    const ref = (handle: string): CredentialRef => parseCredentialRef(handle) as CredentialRef
    store.set(ref('grndctrl/jira'), 'jira-token')
    store.set(ref('grndctrl/github'), 'gh-token')
    store.set(ref('grndctrl/github-2'), 'ghe-token')

    const services = createCoreServices({ dir, credentials: store })
    try {
      expect(store.get(ref('grndctrl/github'))).toBeNull()
      expect(store.get(ref('grndctrl/github-2'))).toBeNull()

      // The surviving connection's secret is untouched. A cleanup that deleted
      // everything would leave the operator signed out of a provider that is
      // still in use, on a launch they did not ask anything of.
      expect(store.get(ref('grndctrl/jira'))).toBe('jira-token')
    } finally {
      services.close()
    }
  })

  /**
   * The probe, run as a test rather than by hand.
   *
   * If the refs were read *after* the migration, the query would find no rows
   * of a removed kind and hand back nothing — and the deletion loop would run
   * over an empty list, silently, leaving both tokens in the keychain. Nothing
   * would fail. No error would be logged. The test above would still pass,
   * because it only checks that the right secrets are gone *given* the refs.
   *
   * So this one asserts the property directly: the read has to happen against a
   * database that still has the rows. It is written as an inverted simulation
   * rather than by editing `open.ts` and re-running, because the wrong order is
   * a one-line change that somebody will make again.
   */
  it('finds nothing if the read is attempted after the migration', () => {
    seedV3()

    const opened = openMirror({ dir })
    try {
      // This is what a post-migration read would see. It is the whole failure
      // mode: an empty list, no error, and two live tokens left behind.
      const afterwards = (
        opened.db.prepare(`SELECT credential_ref FROM connections WHERE kind <> 'jira'`).all() as {
          credential_ref: string
        }[]
      ).map((r) => r.credential_ref)

      expect(afterwards).toEqual([])
      // And the real read, done before, found them both.
      expect(opened.orphanedCredentialRefs).toHaveLength(2)
    } finally {
      opened.db.close()
    }
  })

  it('ignores a malformed handle rather than deleting against an empty service', () => {
    seedV3()
    const db = new Database(join(dir, 'mirror.db'))
    db.prepare(`UPDATE connections SET credential_ref = 'nonsense' WHERE id = 'github'`).run()
    db.close()

    const store = inMemoryKeychain()
    store.set({ service: '', account: 'nonsense' }, 'should-not-be-touched')
    store.set(parseCredentialRef('grndctrl/github-2') as CredentialRef, 'ghe-token')

    const services = createCoreServices({ dir, credentials: store })
    try {
      expect(store.get({ service: '', account: 'nonsense' })).toBe('should-not-be-touched')
      expect(store.get(parseCredentialRef('grndctrl/github-2') as CredentialRef)).toBeNull()
    } finally {
      services.close()
    }
  })
})

describe('parseCredentialRef', () => {
  it('round-trips a handle', () => {
    const ref = { service: 'grndctrl', account: 'jira-1' }
    expect(parseCredentialRef(credentialRefString(ref))).toEqual(ref)
  })

  it('keeps an account id containing a slash whole', () => {
    // Splitting on the last separator, or on every one, would truncate it — and
    // a truncated account is a delete against the wrong entry.
    expect(parseCredentialRef('grndctrl/acme/jira')).toEqual({
      service: 'grndctrl',
      account: 'acme/jira',
    })
  })

  it('refuses anything that is not a handle', () => {
    for (const bad of ['', 'nonsense', '/leading', 'trailing/', '/']) {
      expect(parseCredentialRef(bad), `${bad} should not parse`).toBeNull()
    }
  })
})
