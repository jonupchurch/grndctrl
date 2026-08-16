# Contract — IPC and the preload bridge

**Feature**: `001-ground-control-v1` · **Date**: 2026-08-14

How the React renderer reaches the service layer. Like the MCP server, this is an
**adapter** over [operations.md](./operations.md) — the renderer is a client of
the same registry, not a privileged sibling with a private path to the data
(XII).

The renderer is treated as **untrusted**. It renders provider-supplied strings —
ticket titles, PR bodies, branch names — and must never hold anything worth
stealing.

---

## Window and bridge configuration

Not negotiable per window:

```
contextIsolation: true    nodeIntegration: false
sandbox: true             webSecurity: true
```

Renderer content loads from local files only. A CSP ships with it. No remote
URLs, no CDN, no `<webview>`.

---

## The preload surface

`contextBridge.exposeInMainWorld('grndctrl', …)` — **hand-enumerated, one method
per operation**:

```ts
window.grndctrl = {
  work:  { list, get },
  board: { summary },
  drift: { list, dismiss, undismiss },
  notes: { list, counts, questions, create, update, delete: … },
  sessions: { list },
  outbox:   { mintConfirmation, enqueue, list, cancel },
  links:    { resolve },
  sync:     { now, status },
  settings: { get, update },
  connections: { list, add, test, remove },
  projects:    { list, upsert, remove },
  on: { syncProgress, freshnessTick, outboxChanged },   // main → renderer push
}
```

**There is no `invoke(channel, ...args)`.** A generic passthrough hands the
renderer the entire IPC surface back and defeats the isolation the window config
just established. Every method above is written out, and the conformance test in
[operations.md](./operations.md#conformance-test-the-gate) fails the build when a
registry entry has no counterpart here.

`outbox.mintConfirmation` appears **only** on this surface — it is the one
`ui-only` operation, and this is the reason it exists.

---

## Channels

`grndctrl:<domain>:<verb>`, one per operation: `grndctrl:work:list`,
`grndctrl:notes:update`, `grndctrl:outbox:claim`.

**Request/response** — `ipcMain.handle` / `ipcRenderer.invoke`.

**Main → renderer push** — `webContents.send` / `ipcRenderer.on`:

| Event | Payload | Why push rather than poll |
|---|---|---|
| `grndctrl:sync:progress` | `{ connectionId, resourceKind, phase }` | a sync takes seconds; the board should show it moving |
| `grndctrl:freshness:tick` | `FreshnessRecord[]` | ages advance without any data changing (XIV) |
| `grndctrl:outbox:changed` | `{ actionId, state }` | an agent claims or completes out of band |

---

## Validation at the boundary

**Every payload is validated inside the handler** with the operation's own input
schema — the same schema the MCP adapter uses. The renderer is a trust boundary,
not a friend (Principle II), and revalidating in the handler means a compromised
or merely buggy renderer cannot reach a handler with a shape it does not expect.

Errors cross the bridge as the registry's typed taxonomy, never as a raw provider
error and never as a stack trace. A `rate_limited` from GitHub arrives as
`{ code: 'rate_limited', retryAfter }` — enough for the lane to render "retrying
in 4m" and nothing more.

---

## Renderer conventions

**TanStack Query over IPC-backed fetchers.** Polling, staleness, and manual
refresh map onto it directly, and `dataUpdatedAt` is what XIV needs to render —
it makes "when did we last actually hear this" a property of the cache rather
than something each component tracks.

Note the distinction the UI must not blur: `dataUpdatedAt` is when *this client*
last received the answer; the envelope's `lastSuccessAt` is when the *provider*
last answered. During an outage the first keeps advancing while the second does
not. **The envelope is what gets rendered.**

**One query and one error boundary per lane** (XV). Jira failing must leave the
PR, branch, and session lanes fully interactive — a lane that blanks itself
reads as "no work", which is the opposite of the truth.

**The renderer never** opens SQLite, sees a token, calls Jira or GitHub, imports
Node built-ins, or constructs a provider URL. Clicking a row calls
`links.resolve`, which returns a scheme-checked `https` URL; main then passes it
to `shell.openExternal`. Provider data supplies these URLs, so they are treated
as hostile at both ends (FR-077).

---

## Verifying the boundary is real

Part of the M4 exit criteria, not a code-review promise:

- `window.require`, `process`, and `module` are `undefined` in the renderer console.
- `window.grndctrl` has exactly the enumerated methods — no `invoke`, no extras.
- A handler rejects a malformed payload with `invalid` rather than throwing.
- A `file:`, `javascript:`, or custom-scheme URL returned by a stubbed provider
  is refused by `links.resolve` and never reaches `shell.openExternal`.
