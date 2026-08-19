import type { Connection } from '@grndctrl/core'

/**
 * The one path a secret takes, and it is not an operation.
 *
 * The operation registry is served on three surfaces — IPC, loopback HTTP, and
 * MCP. Keeping a secret off the latter two would rest entirely on an `exposure`
 * field being right, forever, in a file that several adapters read. That is a
 * property a bug can break silently, and the cost of breaking it is the
 * operator's provider token reaching third-party software.
 *
 * So this lives in the shell instead. It is reachable only from the window the
 * shell itself created, it is not in the registry, and no amount of getting an
 * exposure wrong can put it on a surface. The secret makes exactly one hop —
 * renderer to main to the OS keychain (XI, FR-005) — and nothing reads it back:
 * there is no getter here, and no operation returns one.
 *
 * What crosses back is a `Connection`, which by construction cannot carry a
 * secret; its `credentialRef` is a `service/account` lookup handle.
 */

export interface CredentialRequest {
  kind: 'jira'
  siteOrHost: string
  accountLabel: string
  secret: string
}

export interface CredentialStoreOptions {
  add(input: CredentialRequest): Connection
}

/** The shape the renderer sees. A discriminated union, matching the bridge. */
export type CredentialResult =
  | { ok: true; connection: Connection }
  | { ok: false; error: { code: string; message: string } }

export function credentialHandler(options: CredentialStoreOptions) {
  return function store(request: unknown): CredentialResult {
    if (!isRequest(request)) {
      return failure('invalid', 'That is not a credential this application can store.')
    }

    try {
      return { ok: true, connection: options.add(request) }
    } catch (e) {
      // Redacted against the secret before anything is returned or logged. This
      // is the only handler that holds one, so it is the only place an
      // over-helpful provider error could echo it back out.
      return failure(codeOf(e), redact(messageOf(e), request.secret))
    }
  }
}

/**
 * Validated here rather than with a schema, because a schema failure message
 * conventionally quotes the offending value — and one of these fields is a
 * secret. Five `typeof` checks that cannot quote anything are the safer trade.
 */
function isRequest(value: unknown): value is CredentialRequest {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>

  return (
    // Still an equality check rather than a `typeof`, and still exhaustive with
    // one member: a renderer sending `github` is refused here rather than
    // reaching core and being refused by a CHECK constraint, which would surface
    // as a store failure the operator cannot read.
    v['kind'] === 'jira' &&
    typeof v['siteOrHost'] === 'string' &&
    typeof v['accountLabel'] === 'string' &&
    typeof v['secret'] === 'string' &&
    v['secret'] !== ''
  )
}

const failure = (code: string, message: string): CredentialResult => ({
  ok: false,
  error: { code, message },
})

function codeOf(e: unknown): string {
  const code = (e as { code?: unknown }).code
  return typeof code === 'string' ? code : 'unknown'
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Belt and braces: core redacts too, and this is the wrong place to rely on it. */
function redact(message: string, secret: string): string {
  return secret === '' ? message : message.split(secret).join('[redacted]')
}
