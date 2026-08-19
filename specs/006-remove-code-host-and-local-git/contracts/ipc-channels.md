# Contract delta — IPC and the preload bridge

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19

Amends [001's IPC contract](../../001-ground-control-v1/contracts/ipc-channels.md). The bridge is an adapter over the registry (XII) and the renderer is treated as untrusted; neither changes.

---

## What does not change

- **The channel surface.** One invoke channel and one push channel. The bridge exposes operation names, not per-feature channels, so removing capability from the registry removes it from the bridge with no bridge edit at all.
- **Window configuration.** `contextIsolation`, `nodeIntegration: false`, `sandbox`, the CSP, and the `file:`-only load policy are untouched.
- **The preload surface test.** It asserts the exact set of properties reaching `window`. That set does not change, and the test staying green through this work is a small proof that the removal did not leak a new path.

---

## What changes

### Push events

Push exists so an agent's action reaches an open board without waiting for a poll. Its event kinds narrow with the resources that can change:

| Event | Disposition |
|---|---|
| tickets synced | ✓ |
| sessions changed | ✓ |
| notes changed | ✓ |
| outbox changed | ✓ |
| pull requests / checks / branches / comparisons / local synced | **removed** |

**The renderer's invalidation map must narrow with them.** A React Query key that nothing can invalidate any more is a stale entry that reads like a live subscription; the risk is not a bug today but a wrong belief about how the board refreshes.

### The renderer's type mirror

`packages/desktop/src/renderer/types.ts` narrows the domain types via `Pick`, which is exactly why it was written that way: a field core no longer has becomes a compile error here rather than a confident wrong string on screen. The `PullRequest`, `Workspace` and `Comparison` mirrors are deleted; `WorkItem` loses four fields; `AgentSession` loses `workspaceKey`.

This file is the single best early-warning system in the change. If it compiles after core narrows, the renderer is not reading anything that no longer exists.

---

## What must not be removed along with the lanes

**The per-lane error boundaries stay.**

They exist for constitution gate XV — a failure in one lane must not blank the others — and the obvious reading after this change is that a board with one work lane has nothing to isolate it from. That reading is wrong. The ticket lane, the session lane, the Attention region and the connection notice still fail independently, and Attention renders provider-supplied strings, which is the most likely thing on the page to arrive malformed.

Called out here because it is the kind of thing that gets deleted as "obviously now redundant" during a removal, by someone with good instincts and the wrong mental model of what the boundary was protecting.
