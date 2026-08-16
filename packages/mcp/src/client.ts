import { readHandshake, type Handshake } from '@grndctrl/core/handshake'

/**
 * How the MCP server reaches the running app.
 *
 * It is a separate process — started by an agent's client, not by Ground
 * Control — so it has no database handle, no registry, and no credentials. It
 * has a port and a token, read from a file only the current user can open, and
 * it POSTs to the loopback API. That is the whole of it.
 *
 * This module deliberately imports only `@grndctrl/core/handshake`, a subpath
 * that pulls in nothing else. Importing the core package proper would load
 * `better-sqlite3` into a process delivered by `npx`, which would need a native
 * binding it has no business having.
 */

export type AppState =
  | { running: true; handshake: Handshake }
  /** The app is not running, or not running in a way this process can talk to. */
  | { running: false; reason: string }

export interface AppClient {
  state(): AppState
  /** Dispatch an operation. Throws `AppNotRunning` or `OperationFailed`. */
  call(operation: string, input: unknown): Promise<unknown>
}

export class AppNotRunning extends Error {
  readonly code = 'app_not_running'
}

export class OperationFailed extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details: unknown) {
    super(message)
    this.name = 'OperationFailed'
    this.code = code
    this.details = details
  }
}

export interface ClientOptions {
  dir: string
  agentId?: string | undefined
  /** Injected in tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch | undefined
}

export function appClient(options: ClientOptions): AppClient {
  const doFetch = options.fetch ?? globalThis.fetch

  const state = (): AppState => {
    const handshake = readHandshake(options.dir)
    if (handshake === null) {
      return { running: false, reason: 'Ground Control is not running.' }
    }
    return { running: true, handshake }
  }

  return {
    state,

    async call(operation, input) {
      // Re-read on every call rather than caching. The app can be restarted
      // while an agent's session is open, and a cached port would send a token
      // to whatever now owns it.
      const current = state()
      if (!current.running) throw new AppNotRunning(current.reason)

      let response: Response
      try {
        response = await doFetch(`http://127.0.0.1:${current.handshake.port}/op/${operation}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${current.handshake.token}`,
            ...(options.agentId === undefined ? {} : { 'x-grndctrl-agent': options.agentId }),
          },
          body: JSON.stringify(input ?? {}),
        })
      } catch {
        // A refused connection means the handshake was stale — the app exited
        // without removing it, or was killed. Reported as "not running" rather
        // than as a network error, because that is what it means to the agent.
        throw new AppNotRunning('Ground Control is not reachable. It may have stopped.')
      }

      const payload = (await response.json().catch(() => null)) as
        | { ok: true; data: unknown }
        | { ok: false; error: { code: string; message: string; details: unknown } }
        | null

      if (payload === null) {
        throw new OperationFailed('provider_unavailable', 'Unreadable response from the app.', {})
      }

      if (!payload.ok) {
        throw new OperationFailed(payload.error.code, payload.error.message, payload.error.details)
      }

      return payload.data
    },
  }
}
