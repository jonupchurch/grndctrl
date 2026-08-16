/**
 * One error taxonomy for every adapter.
 *
 * A raw provider error must never cross a boundary — not to the renderer, not
 * to an agent. Two reasons, and the second is the one that bites: a provider
 * error leaks internals (URLs, tokens in headers, stack traces), and it is
 * unusable by the caller, who cannot distinguish "retry in four minutes" from
 * "your token is dead" without parsing prose.
 */

export type ErrorCode =
  /** Input failed schema validation at a trust boundary (Principle II). */
  | 'invalid'
  /** The subject does not exist — usually a stale key. */
  | 'not_found'
  /** Optimistic concurrency lost: a note revision, or a second claim. */
  | 'conflict'
  /** Legal operation, illegal right now — completing an unclaimed action. */
  | 'precondition_failed'
  /** The connection's credential was rejected. */
  | 'unauthorized'
  /** Provider unreachable: network, 5xx. */
  | 'provider_unavailable'
  /** Provider throttling. Carries `retryAfterSec`. */
  | 'rate_limited'
  /**
   * The OS credential store is unreachable. Its own code rather than folded
   * into `unauthorized`, because FR-006 requires saying *specifically* that the
   * keychain cannot be reached — and that the app will not fall back.
   */
  | 'keychain_unavailable'

export interface ErrorDetails {
  /** Seconds until a retry is worth attempting. Set for `rate_limited`. */
  retryAfterSec?: number
  /** The connection a failure is scoped to. Failure is per connection (XV). */
  connectionId?: string
  /** For `conflict`: the current state, so the caller can show both sides. */
  current?: unknown
}

export class OperationError extends Error {
  readonly code: ErrorCode
  readonly details: ErrorDetails

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message)
    this.name = 'OperationError'
    this.code = code
    this.details = details
  }

  /** The wire form. Identical across IPC, HTTP, and MCP. */
  toJSON(): { code: ErrorCode; message: string; details: ErrorDetails } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export const invalid = (message: string, details?: ErrorDetails) =>
  new OperationError('invalid', message, details)

export const notFound = (message: string, details?: ErrorDetails) =>
  new OperationError('not_found', message, details)

export const conflict = (message: string, current?: unknown) =>
  new OperationError('conflict', message, current === undefined ? {} : { current })

export const preconditionFailed = (message: string, details?: ErrorDetails) =>
  new OperationError('precondition_failed', message, details)

export const unauthorized = (message: string, connectionId?: string) =>
  new OperationError('unauthorized', message, connectionId === undefined ? {} : { connectionId })

export const providerUnavailable = (message: string, connectionId?: string) =>
  new OperationError(
    'provider_unavailable',
    message,
    connectionId === undefined ? {} : { connectionId },
  )

export const rateLimited = (message: string, retryAfterSec: number, connectionId?: string) =>
  new OperationError('rate_limited', message, {
    retryAfterSec,
    ...(connectionId === undefined ? {} : { connectionId }),
  })

export const keychainUnavailable = (message: string) =>
  new OperationError('keychain_unavailable', message)

export function isOperationError(e: unknown): e is OperationError {
  return e instanceof OperationError
}

/**
 * Last line of defence at an adapter boundary.
 *
 * Anything that is not already an `OperationError` becomes an opaque `unknown`
 * failure. The original is not attached: an unexpected throw from a provider
 * client is exactly the thing most likely to be carrying a URL with a token in
 * it, and adapters serve an untrusted renderer and third-party agents.
 */
export function toOperationError(e: unknown): OperationError {
  if (isOperationError(e)) return e
  return new OperationError('provider_unavailable', 'An unexpected internal error occurred.')
}
