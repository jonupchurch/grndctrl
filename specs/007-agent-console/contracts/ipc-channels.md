# Contract delta — IPC and the preload bridge

**Feature**: `007-agent-console` · **Date**: 2026-08-19

Amends [001's IPC contract](../../001-ground-control-v1/contracts/ipc-channels.md), on top of [006's delta](../../006-remove-code-host-and-local-git/contracts/ipc-channels.md).

**This is the first widening of the preload surface since 001.** Everything since has narrowed it or left it alone. `test/preload-surface.test.ts` asserts the exact set of properties reaching `window`, and that test is about to fail on purpose.

---

## The clipboard is not an operation

`channels.ts` already argues the distinction, for `OPEN_CHANNEL`:

> *Not an operation — opening the operator's browser is a host affordance of the shell, like the window itself. The URL it opens is not the renderer's: it comes from `links.resolve`, which is an operation and is on every surface.*

Copying is the same category. It is not a question about the domain and it has no meaning on the loopback HTTP surface or in MCP — an agent asking to put something on the operator's clipboard is not a capability this application should offer at all.

So: `COPY_CHANNEL`, beside `OPEN_CHANNEL`, in the shell alone.

### And the same discipline about what crosses

`open` takes a **subject key**, never a URL. `copy` takes a **prompt id**, never text.

```ts
copy: (request: { promptId: string }) => Promise<Result>
```

Main receives the id, reads that prompt from the authored store, and copies **what it read** (FR-139). The renderer never supplies the string that lands on the clipboard.

**Why that matters more than it looks.** The clipboard is pasted into terminals. A renderer that could name arbitrary text to place there is a renderer that could place anything there, and the renderer is the part of this application that displays strings from a provider. The indirection costs one lookup and removes the whole class.

**It also makes truncation impossible.** The renderer holds a shortened preview for display; it cannot copy the preview by accident, because it cannot copy a string at all (FR-138).

---

## The surface, before and after

```diff
  window.grndctrl = {
    ...operations,
    open:       (request) => …,
    credential: (request) => …,
+   copy:       (request: { promptId: string }) => …,
    on: {
      syncProgress, freshnessTick, outboxChanged, sessionsChanged,
+     focusChanged, updatesChanged, promptsChanged,
    },
  }
```

**The test is updated by naming the additions**, never by relaxing it to a subset check. This is written down because "the exact-set assertion failed, so I made it a subset assertion" is the single most likely wrong fix, it looks like a reasonable one in a diff, and it would silently permit every future addition too.

---

## Push events

Three new kinds, so the four new regions update without a poll (SC-013):

| Event | Fires when |
|---|---|
| `focusChanged` | the active ticket is set or cleared |
| `updatesChanged` | an update is posted |
| `promptsChanged` | a prompt is recorded or deleted |

All three follow the existing pattern: main watches the operation go past and pushes; the renderer invalidates the matching query key. The renderer learns *that* something changed, never *what* — it re-reads through the registry like every other refresh.

**`focusChanged` is the one that matters most**, because the active-ticket panel is the region an operator will be watching while an agent works. A panel that needed a poll to notice the agent had switched tickets would be wrong for up to the poll interval, at exactly the moment it is being read.

---

## Error boundaries

Four new regions, four new boundaries (XV). Each of the new panels has a way to fail that the others do not:

- **Active ticket** — a stored description that fails to render. The converter runs at ingest, so this should be impossible; the boundary is there because "should be impossible" is not a rendering strategy.
- **Agent updates** — an empty or failing store read.
- **Prompts** — the same, plus a failed copy, which is handled inline rather than by the boundary because the panel is fine and only the action failed.
- **The "no longer mine" lane** — a provider read, exactly like the ticket lane.

---

## What must not happen

**No new capability may be added to the surface for convenience while it is open.** The surface is widening for the first time in five releases, and the moment it is open is the moment `readFile`, `shell.showItemInFolder` and `app.getPath` all look reasonable. One property is being added. The test that asserts the exact set is the thing preventing the rest, and that is why it is being edited by hand rather than loosened.
