import type { AdapterDescriptor } from '@grndctrl/core/registry'
import { isOperationError, OperationError } from '@grndctrl/core/registry'
import { channelFor } from '../shared/channels.js'

/**
 * The third adapter — one of three thin translations of the operation registry
 * (constitution XII), and the only one the renderer can reach.
 *
 * Two decisions carry most of the security weight here, and both are about what
 * is *absent* rather than what is checked:
 *
 * **One channel per operation, never one channel plus a name.** The obvious
 * shape is a single `invoke(name, input)` handler that looks the name up. It is
 * also the shape where a bug in the lookup — a missing exposure check, a
 * normalisation that strips a prefix — turns the whole registry into an open
 * surface, `ui-only` entries included. With a channel per operation the guard is
 * not a condition inside a handler; it is the absence of a handler. An operation
 * the registry does not expose to `ipc` has no channel, and Electron answers
 * "no handler registered" before any of this code runs.
 *
 * **The renderer supplies a payload, never an identity.** `authorKind` is
 * stamped `user` by the service host because the transport says so — the
 * renderer is the UI, by definition. Nothing in the payload can change it, so a
 * note an agent wrote over MCP can never be presented as the operator's, and a
 * compromised renderer cannot claim to be one either.
 *
 * The ESLint boundary rule stops this file importing anything below the
 * registry. If something here needs new behaviour, it is a new operation.
 */

/** What every channel answers with, matching the loopback API byte for byte. */
export type IpcResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

/**
 * The half of a Zod schema this adapter uses.
 *
 * Structural rather than `z.ZodType` so the adapter can be exercised with a
 * two-line fake, and so the shell does not take a direct dependency on the
 * validation library core happens to use.
 */
export interface PayloadSchema {
  safeParse(value: unknown): { success: boolean; error?: { issues: readonly unknown[] } }
}

/** Name and input schema. The handler stays with core; this half is portable. */
export interface OperationDescriptor {
  name: string
  input: PayloadSchema
}

/**
 * What the adapter is told about where a message came from.
 *
 * Both fields are structural facts about the frame rather than strings it
 * reports. An earlier version compared the sender's URL against the renderer
 * entry point, which looked stricter and was worse: `senderFrame.url` is not
 * reliably the final URL at the moment the *first* message arrives, so the app
 * refused its own renderer's opening call about one launch in two and showed
 * "this message did not come from the application window" instead of the board.
 * A security check with a race in it teaches people to remove security checks.
 */
export interface IpcSender {
  /** True when this is a window's top-level frame, not something it embedded. */
  isMainFrame: boolean
  /** True when the sending `webContents` belongs to a window this app created. */
  isOwnWindow: boolean
}

export interface IpcHost {
  handle(
    channel: string,
    listener: (sender: IpcSender, payload: unknown) => Promise<IpcResult>,
  ): void
  removeHandler(channel: string): void
}

export interface IpcAdapterOptions {
  host: IpcHost
  /** The operations the registry permits on this surface, with their schemas. */
  operations: readonly OperationDescriptor[]
  /** Run the operation. Supplied by the service host, so this file holds no registry. */
  dispatch(operation: string, payload: unknown): Promise<unknown>
  /**
   * Whether a message came from our own renderer.
   *
   * A `BrowserWindow` can host frames the operator never asked for — an iframe
   * inside provider-supplied content, a page reached by a navigation that got
   * through. Those frames share the preload bridge unless something refuses
   * them, and this is that something. Where the frame is *allowed to be* is a
   * separate question, answered by `will-navigate` and the load blocker in
   * `security.ts`; conflating the two is what put a race in this check.
   */
  isTrustedSender(sender: IpcSender): boolean
}

export interface IpcAdapter extends AdapterDescriptor {
  readonly surface: 'ipc'
  dispose(): void
}

export function registerIpcAdapter(options: IpcAdapterOptions): IpcAdapter {
  const registered: string[] = []

  for (const operation of options.operations) {
    const channel = channelFor(operation.name)

    options.host.handle(channel, async (sender, payload) => {
      if (!options.isTrustedSender(sender)) {
        // Not `unauthorized`: there is no credential to supply and no retry that
        // would help. Something is asking that should not exist.
        return failure(
          new OperationError('invalid', 'This message did not come from the application window.'),
        )
      }

      // Validated here even though the registry validates again before running
      // the handler, and the redundancy is the point. This is the last code that
      // runs while the payload is still in one process: today the second check
      // is belt and braces, and the day core moves to `utilityProcess.fork`
      // (decision 19) it is what stops a malformed payload being serialised and
      // shipped across a process boundary before anything rejects it.
      if (!operation.input.safeParse(payload).success) {
        return failure(
          new OperationError('invalid', `Invalid input for '${operation.name}'.`),
        )
      }

      try {
        return { ok: true, data: await options.dispatch(operation.name, payload) }
      } catch (e) {
        return failure(e)
      }
    })

    registered.push(operation.name)
  }

  return {
    surface: 'ipc',
    // Read from what was actually registered, not from the list that was asked
    // for. They are the same today; a future loop with a `continue` in it would
    // make them differ, and the conformance gate exists to notice that.
    exposedNames: () => [...registered],
    dispose: () => {
      for (const name of registered) options.host.removeHandler(channelFor(name))
    },
  }
}

/**
 * An error the renderer can act on, and nothing it cannot.
 *
 * An unexpected throw becomes opaque for the same reason it does over HTTP: the
 * throws most likely to carry a token in their message are the ones nobody
 * anticipated. The renderer gets a code it can branch on either way.
 */
function failure(e: unknown): IpcResult {
  const error = isOperationError(e)
    ? e
    : new OperationError('provider_unavailable', 'An unexpected internal error occurred.')

  return { ok: false, error: error.toJSON() }
}
