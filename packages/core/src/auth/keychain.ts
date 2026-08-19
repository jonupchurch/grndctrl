import { keychainUnavailable } from '../registry/errors.js'

/**
 * Credential storage, behind a seam.
 *
 * Constitution XI: credentials live in the OS keychain — never in a dotfile,
 * never in an environment file, never in SQLite, never in a log. A credential
 * must not be written anywhere a backup tool, a screenshot, or a `git add .`
 * could pick it up.
 *
 * The seam exists so OAuth can land later without touching call sites, and so
 * tests can run against an in-memory double. It does **not** exist to provide a
 * fallback: when the OS store is unreachable the app says so and stops. An
 * environment-variable escape hatch is precisely the thing XI forbids, and it
 * is the one that would get used.
 */

export interface CredentialRef {
  /** Namespace in the OS store. One per application. */
  service: string
  /** The connection this secret belongs to. */
  account: string
}

export interface CredentialStore {
  set(ref: CredentialRef, secret: string): void
  /** `null` when no entry exists — distinct from the store being unreachable. */
  get(ref: CredentialRef): string | null
  /** `true` if an entry was removed, `false` if there was nothing to remove. */
  delete(ref: CredentialRef): boolean
}

export const SERVICE = 'grndctrl'

export function credentialRef(connectionId: string): CredentialRef {
  return { service: SERVICE, account: connectionId }
}

/** The stored handle — `service/account`. Safe to persist; it is not the secret. */
export function credentialRefString(ref: CredentialRef): string {
  return `${ref.service}/${ref.account}`
}

/**
 * The stored handle, back into a reference.
 *
 * Needed by exactly one caller: the cleanup that deletes the secrets of
 * connections the mirror migration removed (FR-112). It works from the stored
 * `credential_ref` rather than from `credentialRef(connectionId)` on purpose —
 * by the time the cleanup runs the connection row is gone, and the handle the
 * row carried is the only evidence of where its secret actually lives.
 *
 * Splits on the **first** separator, so an account id containing a slash comes
 * back whole. Returns `null` for anything that is not a handle, because a
 * malformed one must not become a delete against `{ service: '', account: … }`.
 */
export function parseCredentialRef(handle: string): CredentialRef | null {
  const at = handle.indexOf('/')
  if (at <= 0 || at === handle.length - 1) return null
  return { service: handle.slice(0, at), account: handle.slice(at + 1) }
}

/** Minimal shape of `@napi-rs/keyring`'s Entry, so the seam does not depend on the package's types. */
interface KeyringEntry {
  setPassword(password: string): void
  getPassword(): string | null
  deletePassword(): boolean
}

export type EntryFactory = (service: string, account: string) => KeyringEntry

/**
 * The real OS keychain: Windows Credential Manager, macOS Keychain, Linux
 * libsecret.
 *
 * The factory is injected rather than imported at module load so that a
 * missing or unloadable native binding surfaces as `keychain_unavailable` from
 * a call, instead of throwing at import time and taking the whole process with
 * it. A user on a headless Linux box with no libsecret provider should get a
 * clear message about one connection, not a crash on launch.
 */
export function osKeychain(entryFactory: EntryFactory): CredentialStore {
  const entry = (ref: CredentialRef): KeyringEntry => {
    try {
      return entryFactory(ref.service, ref.account)
    } catch (e) {
      throw keychainUnavailable(
        `The OS credential store could not be reached (${describe(e)}). Ground Control stores ` +
          `credentials only in the OS keychain and will not fall back to a file, an environment ` +
          `variable, or its database.`,
      )
    }
  }

  return {
    set(ref, secret) {
      try {
        entry(ref).setPassword(secret)
      } catch (e) {
        // This is the only path holding the secret, so it is the only one where
        // an over-helpful underlying error could echo it into a message that
        // ends up in a log. Redact it explicitly rather than assume it is absent.
        throw asKeychainError(redact(e, secret), 'store a credential in')
      }
    },

    get(ref) {
      try {
        return entry(ref).getPassword()
      } catch (e) {
        // keyring-rs signals "no such entry" by throwing. That is an absence,
        // not a failure — a connection that has not been given a token yet is
        // an ordinary state, and conflating it with an unreachable keychain
        // would tell the user to fix the wrong thing.
        if (isNoEntry(e)) return null
        throw asKeychainError(e, 'read a credential from')
      }
    },

    delete(ref) {
      try {
        return entry(ref).deletePassword()
      } catch (e) {
        if (isNoEntry(e)) return false
        throw asKeychainError(e, 'remove a credential from')
      }
    },
  }
}

/** In-memory double for tests. Never reachable from application wiring. */
export function inMemoryKeychain(): CredentialStore {
  const store = new Map<string, string>()
  const k = (ref: CredentialRef) => credentialRefString(ref)

  return {
    set: (ref, secret) => void store.set(k(ref), secret),
    get: (ref) => store.get(k(ref)) ?? null,
    delete: (ref) => store.delete(k(ref)),
  }
}

/** A store that is always unreachable, for exercising the refusal path. */
export function unavailableKeychain(): CredentialStore {
  const fail = (): never => {
    throw keychainUnavailable(
      'The OS credential store is unavailable. Ground Control will not store credentials anywhere else.',
    )
  }
  return { set: fail, get: fail, delete: fail }
}

function isNoEntry(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e)
  return /no (matching )?entry|not found|NoEntry/i.test(message)
}

function asKeychainError(e: unknown, verb: string): Error {
  if (e instanceof Error && e.name === 'OperationError') return e
  return keychainUnavailable(
    `Could not ${verb} the OS credential store (${describe(e)}). Ground Control will not fall ` +
      `back to storing credentials in a file, an environment variable, or its database.`,
  )
}

function describe(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown error'
  return e.message.length > 200 ? e.name : `${e.name}: ${e.message}`
}

/** Replace a known secret wherever it appears in an error before it is quoted. */
function redact(e: unknown, secret: string): unknown {
  if (secret.length === 0 || !(e instanceof Error)) return e
  if (!e.message.includes(secret)) return e

  const scrubbed = new Error(e.message.split(secret).join('[redacted]'))
  scrubbed.name = e.name
  return scrubbed
}
