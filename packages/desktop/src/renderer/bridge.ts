/**
 * The renderer's view of the preload bridge.
 *
 * Everything below the `declare global` is about turning the wire shape into
 * something the UI can branch on. The bridge hands back a discriminated union
 * rather than throwing, because `contextBridge` strips custom properties off a
 * thrown `Error` and the property that matters is `code` — three different
 * screens depend on it. So the union is unwrapped here, once, into an error that
 * still carries the code.
 */

export type BridgeResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

type Method = (input?: unknown) => Promise<BridgeResult>

export interface Bridge {
  readonly [namespace: string]: unknown
  open(request: { subjectKey: string; target?: string }): Promise<BridgeResult>
  /**
   * Store a provider credential. Not an operation — see `shared/channels.ts`.
   * Write-only: there is no counterpart that reads a secret back out.
   */
  credential(request: {
    kind: 'jira' | 'github'
    siteOrHost: string
    accountLabel: string
    secret: string
  }): Promise<{ ok: true; connection: unknown } | { ok: false; error: { code: string; message: string } }>
  on: {
    syncProgress(listener: (payload: unknown) => void): () => void
    freshnessTick(listener: (payload: unknown) => void): () => void
    outboxChanged(listener: (payload: unknown) => void): () => void
    sessionsChanged(listener: (payload: unknown) => void): () => void
  }
}

declare global {
  interface Window {
    readonly grndctrl?: Bridge
  }
}

export class BridgeError extends Error {
  readonly code: string
  /**
   * Whatever core attached to the failure. `unknown`, because this is the
   * bottom of the transport and the taxonomy's payload differs per code — a
   * `rate_limited` carries `retryAfterSec`, a `conflict` carries the current
   * row. Each screen narrows the one it expects; see `conflictingNote` below.
   */
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

/**
 * The note somebody else saved while this one was being edited.
 *
 * Narrowed here rather than at the call site because the shape of a conflict is
 * a property of the taxonomy, not of the notes modal, and a second screen that
 * loses a revision race should read it the same way. Returns null rather than
 * throwing on an unexpected shape: a conflict whose payload cannot be parsed is
 * still a conflict, and the operator is better served by the message alone than
 * by a crash inside the error handler.
 */
export function conflictingNote(error: unknown): { body: string; revision: number } | null {
  if (!(error instanceof BridgeError) || error.code !== 'conflict') return null

  const current = (error.details as { current?: unknown } | undefined)?.current
  if (typeof current !== 'object' || current === null) return null

  const { body, revision } = current as { body?: unknown; revision?: unknown }
  if (typeof body !== 'string' || typeof revision !== 'number') return null

  return { body, revision }
}

/**
 * Call an operation by its dotted name.
 *
 * The name is split and looked up rather than passed through, because there is
 * no method on the bridge to pass it to — each operation has its own. A name the
 * preload does not expose fails here, in the renderer, with a message that says
 * which name; the alternative is an unhandled rejection from Electron reading
 * "no handler registered for …", which is true but unhelpful.
 */
export async function call(operation: string, input?: unknown): Promise<unknown> {
  const bridge = window.grndctrl
  if (bridge === undefined) {
    throw new BridgeError('invalid', 'The application bridge is not available.')
  }

  const dot = operation.indexOf('.')
  const group = bridge[operation.slice(0, dot)] as Record<string, Method> | undefined
  const method = group?.[operation.slice(dot + 1)]

  if (typeof method !== 'function') {
    throw new BridgeError('not_found', `'${operation}' is not exposed to the interface.`)
  }

  const result = await method(input ?? {})
  if (!result.ok) {
    throw new BridgeError(result.error.code, result.error.message, result.error.details)
  }
  return result.data
}

/**
 * Hand a credential to main.
 *
 * Separate from `call` because it is not an operation and must never become
 * one: the registry it would otherwise join is served on the loopback API and
 * MCP as well as IPC. The secret makes one hop from here and is not held
 * afterwards — the caller is expected to drop it with the form state.
 */
export async function storeCredential(request: {
  kind: 'jira' | 'github'
  siteOrHost: string
  accountLabel: string
  secret: string
}): Promise<void> {
  const bridge = window.grndctrl
  if (bridge === undefined) {
    throw new BridgeError('invalid', 'The application bridge is not available.')
  }

  const result = await bridge.credential(request)
  if (!result.ok) throw new BridgeError(result.error.code, result.error.message)
}

export async function openSubject(subjectKey: string, target?: string): Promise<void> {
  const bridge = window.grndctrl
  if (bridge === undefined) {
    throw new BridgeError('invalid', 'The application bridge is not available.')
  }

  const result = await bridge.open(target === undefined ? { subjectKey } : { subjectKey, target })
  if (!result.ok) throw new BridgeError(result.error.code, result.error.message)
}
