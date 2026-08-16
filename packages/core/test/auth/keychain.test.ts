import { describe, expect, it } from 'vitest'
import {
  credentialRef,
  credentialRefString,
  inMemoryKeychain,
  osKeychain,
  unavailableKeychain,
  type EntryFactory,
} from '../../src/auth/keychain.js'
import { isOperationError } from '../../src/registry/errors.js'

/** A double for `@napi-rs/keyring`'s Entry, including its throw-on-absent behaviour. */
function fakeKeyring(): { factory: EntryFactory; store: Map<string, string> } {
  const store = new Map<string, string>()
  const factory: EntryFactory = (service, account) => {
    const key = `${service}/${account}`
    return {
      setPassword: (password: string) => void store.set(key, password),
      getPassword: () => {
        if (!store.has(key)) throw new Error('No matching entry found in secure storage')
        return store.get(key) ?? null
      },
      deletePassword: () => store.delete(key),
    }
  }
  return { factory, store }
}

describe('the keychain seam', () => {
  it('round-trips a secret and then removes it', () => {
    const { factory } = fakeKeyring()
    const keychain = osKeychain(factory)
    const ref = credentialRef('c1')

    expect(keychain.get(ref)).toBeNull()

    keychain.set(ref, 'ghp_example_token')
    expect(keychain.get(ref)).toBe('ghp_example_token')

    expect(keychain.delete(ref)).toBe(true)
    expect(keychain.get(ref)).toBeNull()
    expect(keychain.delete(ref)).toBe(false)
  })

  // "No entry yet" and "the store is unreachable" are different situations, and
  // conflating them tells the user to fix the wrong thing. A connection that has
  // not been given a token is an ordinary state.
  it('reports an absent entry as null rather than as a failure', () => {
    const keychain = osKeychain(fakeKeyring().factory)
    expect(keychain.get(credentialRef('never-set'))).toBeNull()
  })

  it('keeps connections isolated from one another', () => {
    const keychain = osKeychain(fakeKeyring().factory)
    keychain.set(credentialRef('jira-work'), 'jira-secret')
    keychain.set(credentialRef('gh-personal'), 'gh-secret')

    expect(keychain.get(credentialRef('jira-work'))).toBe('jira-secret')
    expect(keychain.get(credentialRef('gh-personal'))).toBe('gh-secret')
  })

  it('stores a handle, not a secret', () => {
    expect(credentialRefString(credentialRef('c1'))).toBe('grndctrl/c1')
    expect(credentialRefString(credentialRef('c1'))).not.toContain('token')
  })
})

/**
 * FR-006 and constitution XI. The realistic failure is a headless Linux box
 * with no libsecret provider. The app must say so and stop — there is no
 * environment-variable escape hatch, because that is exactly the thing a
 * `git add .` picks up.
 */
describe('when the OS store is unreachable', () => {
  it('fails with keychain_unavailable rather than falling back', () => {
    const keychain = unavailableKeychain()

    for (const act of [
      () => keychain.get(credentialRef('c1')),
      () => keychain.set(credentialRef('c1'), 's'),
      () => keychain.delete(credentialRef('c1')),
    ]) {
      expect(act).toThrow()
      try {
        act()
      } catch (e) {
        expect(isOperationError(e) && e.code).toBe('keychain_unavailable')
      }
    }
  })

  it('surfaces a construction failure as keychain_unavailable, not a crash', () => {
    const keychain = osKeychain(() => {
      throw new Error('libsecret is not available on this system')
    })

    try {
      keychain.get(credentialRef('c1'))
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('keychain_unavailable')
      expect((e as Error).message).toMatch(/will not fall back/)
    }
  })

  // The one path that holds a secret. An underlying store that echoes the value
  // it was handed must not put it into a message that reaches a log.
  it('redacts the secret if the underlying error echoes it', () => {
    const secret = 'ghp_supersecrettoken'
    const keychain = osKeychain(() => ({
      setPassword: (password: string) => {
        throw new Error(`Failed to write value '${password}' to the store`)
      },
      getPassword: () => null,
      deletePassword: () => false,
    }))

    try {
      keychain.set(credentialRef('c1'), secret)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as Error).message).not.toContain(secret)
      expect((e as Error).message).toContain('[redacted]')
    }
  })
})

describe('the in-memory double', () => {
  it('behaves like the real store for the cases tests rely on', () => {
    const keychain = inMemoryKeychain()
    const ref = credentialRef('c1')

    expect(keychain.get(ref)).toBeNull()
    keychain.set(ref, 'secret')
    expect(keychain.get(ref)).toBe('secret')
    expect(keychain.delete(ref)).toBe(true)
    expect(keychain.delete(ref)).toBe(false)
  })
})
