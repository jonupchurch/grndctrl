import { contextBridge, ipcRenderer } from 'electron'
import { channelFor, CREDENTIAL_CHANNEL, OPEN_CHANNEL, PUSH_CHANNELS } from '../shared/channels.js'
import { OPERATIONS } from './operations.js'

/**
 * The entire surface the renderer has.
 *
 * The argument for enumerating rather than forwarding is in `operations.ts`,
 * next to the list itself. What this file adds is the shape: a nested object of
 * bound functions, each closing over a channel string that the renderer never
 * supplies and cannot influence.
 *
 * Nothing else crosses. No `ipcRenderer`, no `process`, no module loader, no
 * `webContents` handle — `test/preload-surface.test.ts` and the isolation e2e
 * both assert the absence, because absence is the kind of property that
 * regresses without anyone editing the line that guaranteed it.
 */

/**
 * The result is handed back as a discriminated union rather than thrown.
 *
 * `contextBridge` cannot carry an `Error` subclass across the boundary — a
 * thrown error arrives as a plain message string with every custom property
 * stripped, and the property that would be lost is `code`. The UI needs it:
 * `conflict` opens the note modal's conflict state, `provider_unavailable`
 * degrades one lane, `keychain_unavailable` sends the operator to settings.
 * Three different screens from one string is not a distinction worth throwing
 * away for tidier call sites.
 *
 * **`details` is carried too**, and was not for a while. `ipcRenderer.invoke`
 * resolves whatever main sent, so at runtime it always arrived; the type here
 * stopped short of it, so nothing downstream could read it. What was lost by
 * that is the `current` note on a `conflict` — the row core deliberately
 * attaches so the operator can see what the other writer said *without* losing
 * the draft they are holding. The value was crossing the whole way and the
 * declaration was what dropped it.
 */
type Result =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

type Method = (input?: unknown) => Promise<Result>

const api: Record<string, Record<string, Method>> = {}

for (const operation of OPERATIONS) {
  const dot = operation.indexOf('.')
  const namespace = operation.slice(0, dot)
  const method = operation.slice(dot + 1)
  const channel = channelFor(operation)

  const group = (api[namespace] ??= {})
  // `channel` is closed over from the frozen list. Nothing the renderer passes
  // reaches `invoke`'s first argument, which is the whole point.
  group[method] = (input) => ipcRenderer.invoke(channel, input ?? {})
}

function subscribe(channel: string): (listener: (payload: unknown) => void) => () => void {
  return (listener) => {
    // The Electron event is dropped rather than forwarded: it carries a `sender`
    // handle to the `webContents`, which is a capability the renderer must never
    // hold — it would reach every other window in the app.
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('grndctrl', {
  ...api,

  /**
   * Open a row's provider page. Takes a subject, never a URL — main resolves it
   * through `links.resolve` and opens only what core returned (`main/links.ts`).
   */
  open: (request: { subjectKey: string; target?: string }) =>
    ipcRenderer.invoke(OPEN_CHANNEL, request),

  /**
   * Store a provider credential. The one path a secret takes, and it takes
   * exactly one hop: here to main to the OS keychain.
   *
   * Not among the enumerated operations, and deliberately so — see
   * `CREDENTIAL_CHANNEL`. Nothing reads a secret back out; there is no getter
   * here and no operation that returns one.
   */
  credential: (request: {
    kind: 'jira' | 'github'
    siteOrHost: string
    accountLabel: string
    secret: string
  }) => ipcRenderer.invoke(CREDENTIAL_CHANNEL, request),

  on: {
    syncProgress: subscribe(PUSH_CHANNELS.syncProgress),
    freshnessTick: subscribe(PUSH_CHANNELS.freshnessTick),
    outboxChanged: subscribe(PUSH_CHANNELS.outboxChanged),
  },
})

export type { Result }
