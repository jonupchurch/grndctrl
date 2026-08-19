# Contract delta — The Operation Registry

**Feature**: `007-agent-console` · **Date**: 2026-08-19

Amends [001's operations contract](../../001-ground-control-v1/contracts/operations.md), on top of [006's delta](../../006-remove-code-host-and-local-git/contracts/operations.md).

**Eight new operations — the first additions since 001.** Gate XII means each arrives on IPC, loopback HTTP and MCP together, and each needs its `exposure` chosen rather than copied. An operation with the wrong exposure is how something reaches a surface it should not, and this contract adds eight chances to get that wrong.

---

## The exposure decisions, together

| Operation | Exposure | Why |
|---|---|---|
| `tickets.handedOff` | `all` | An agent asking what left the operator's hands is reasonable, and the data is no more sensitive than `work.list`. |
| `focus.get` | `all` | An agent needs to know what it is meant to be on. |
| `focus.set` | `all` | **The operator's own words were "populated by MCP".** This is the one that must not be `ui-only`. |
| `focus.clear` | `all` | Symmetric with set; an agent finishing should be able to clear. |
| `updates.list` | `all` | An agent reading what another agent said is the point of a shared board. |
| `updates.post` | `all` | The whole feature. |
| `prompts.list` | `all` | See the note below. |
| `prompts.record` | `all` | The whole feature. |
| `prompts.delete` | **`ui-only`** | Deleting the operator's recorded history is not an agent's business. Recording is; curating is not. |

**`prompts.list` is `all`, and that is a decision with an argument on both sides.** A prompt may contain anything an agent was told, including a secret somebody pasted, and exposing the list to *every* agent means one agent can read what another was given. Against that: they are all the operator's own agents on the operator's own machine, this is a local-first application with no remote surface, and an agent that can read the board can already read every ticket and note. **Chosen: `all`**, with the sensitivity recorded in the spec's edge cases. If that turns out to be wrong it is a one-word change.

---

## `tickets.handedOff`

```
input:  { projectId?: string | null }
output: envelope<Ticket[]>
mutates: false          providerDerived: true
```

Tickets that were the operator's, are not now, and changed hands inside the window.

An envelope, because it is provider-derived and gate XIV admits no exceptions — a lane of tickets with no freshness is exactly the kind of thing that looks current forever.

**No cap.** The set is bounded by construction: seven days of the operator's own reassignments. A cap would be the wrong instrument anyway — truncating *this* list hides the row worth seeing. The output does carry the window length so the lane can say what it covers (FR-126).

**Not `work.list` with a flag.** A parameter that switched `work.list` between two disjoint sets would make every caller's meaning depend on an argument, and the two sets differ in kind: one is work items with severity, staleness and ball-in-court, the other is tickets with none of those, because they are not the operator's problem any more (FR-124).

**The name is not `tickets.unassigned`.** These tickets are mostly assigned — to somebody else. Naming it for the empty case would mislead every future reader in the direction the screenshot label already misled once.

---

## `focus.get` / `focus.set` / `focus.clear`

```
focus.get    input: {}                         output: ActiveTicket | null
focus.set    input: { ticketKey: NaturalKey }  output: ActiveTicket      mutates: true
focus.clear  input: {}                         output: { cleared: boolean }  mutates: true
```

**`providerDerived: false` on all three.** The pointer is authored. The *ticket* it points at is provider-derived and arrives through `work.list` with its own envelope — which is why the panel composes two reads rather than one, and why FR-131's "the ticket is not in the mirror" case is expressible at all.

**`focus.set` validates the key's shape, not its existence.** A ticket key that is not in the mirror is legal (FR-131): an agent may set focus before the first sync that would fetch it, and refusing would make the order of operations matter for no reason.

**`setBy` is derived from the caller's context, never taken as input.** The registry knows whether a call arrived from the UI or from an agent, and an agent that could claim `setBy: 'operator'` would be lying about provenance in the operator's own store.

---

## `updates.list` / `updates.post`

```
updates.list  input: { sessionKey?, ticketKey?, limit? }  output: AgentUpdate[]
updates.post  input: { sessionKey, text }                 output: AgentUpdate   mutates: true
```

**`text` is bounded at the schema.** The panel's whole brief is terse (FR-134). A limit here is what makes "terse" a property of the data rather than a hope about agent behaviour — an agent that pastes a stack trace gets a validation error, not a panel with a stack trace in it.

**`agentId` and `ticketKey` are filled by the service**, from the session and from the current focus. An agent supplying its own `ticketKey` could attribute an update to work it was not doing.

**Pruning happens inside `updates.post`**, not in a separate operation, so it cannot be forgotten and has no scheduler to fail ([data-model](../data-model.md#agentupdate-authored-append-only)).

---

## `prompts.list` / `prompts.record` / `prompts.delete`

```
prompts.list    input: { projectId?, limit? }                  output: Prompt[]
prompts.record  input: { text, sessionKey?, projectId? }       output: Prompt   mutates: true
prompts.delete  input: { id }                                  output: { deleted: boolean }   mutates: true
```

**`prompts.list` returns full text, not a preview.** The renderer truncates for display; the store and the wire carry everything. A preview on the wire would make the truncation invisible until a paste (FR-138).

**Nothing here copies.** The clipboard is not an operation — see [ipc-channels.md](./ipc-channels.md#the-clipboard-is-not-an-operation). `prompts.list` is what the panel renders; the copy path goes through the shell.

---

## Operations narrowed

### `settings.get` / `settings.update`

Gain `collapsedRegions: Record<string, boolean>`. Unknown keys are accepted and ignored — a region id that no longer exists must not make settings unreadable.

---

## What the conformance test must now assert

1. **Every new operation declares an exposure, and the eight above match this table exactly.** Enumerated, so adding a ninth without deciding fails.
2. **`prompts.delete` is not reachable from MCP.** Asserted against the MCP server's own tool list, not against the descriptor — the descriptor is what the assertion would be reading from in the first place.
3. **`tickets.handedOff` returns an envelope**, like every other `providerDerived` operation.
4. **No operation accepts `setBy`, `agentId` or `postedAt` as input.** Provenance and time are the service's to determine; a caller that can supply them can lie about them.
