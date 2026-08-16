# Contract — `grndctrl-mcp` (the agent surface)

**Feature**: `001-ground-control-v1` · **Date**: 2026-08-14

An MCP stdio server, spawned by the agent's own client, that reaches a running
Ground Control over loopback HTTP. It is an **adapter**: every tool below maps to
exactly one entry in [operations.md](./operations.md), and the server contains no
correlation, no provider calls, and no business logic of its own (XII).

Agents are a first-class audience here, not a bolt-on. The two things this
contract is built around: an agent must be able to see the world *with its age
attached*, and an agent must be able to pick up work that was queued before it
existed.

---

## Startup and discovery

```
agent's MCP client ──spawns──► npx grndctrl-mcp ──loopback HTTP──► running app
```

1. Read the handshake file from the per-user data directory: `{ port, token,
   pid, version }`. Created `0600` on POSIX, user-only DACL on Windows, deleted
   on app exit (research [R1](../research.md#r1--service-placement-and-adapter-shape-closes-constitution-gate-xii)).
2. If it is absent or its `pid` is not alive, every tool returns a clean
   `app_not_running` error telling the operator to start Ground Control.
   It does **not** try to launch the app — an MCP server that starts a GUI
   because an agent asked a question is a surprise nobody wants.
3. Send `Authorization: Bearer <token>` on every request. A rejected token means
   the app restarted; re-read the file once, then fail.

The token authenticates a local process. It grants no provider credentials —
no operation can return one (see `connections.list` in the registry).

---

## Tools

Names are `grndctrl_*` so they read unambiguously in an agent's tool list.

### Reading the world

| Tool | Maps to | Purpose |
|---|---|---|
| `grndctrl_get_board` | `work.list` | The whole correlated board, optionally filtered by project or to the operator's court. The context packet an agent should read before acting. |
| `grndctrl_get_work_item` | `work.get` | One work item in full: ticket, workspaces, PRs, checks, sessions, notes. |
| `grndctrl_get_drift` | `drift.list` | Current disagreements, with both sides of the evidence. |
| `grndctrl_get_freshness` | `sync.status` | Per connection per resource kind. Lets an agent decide whether the board is fresh enough for what it is about to do. |

**Every response carries the freshness envelope** (XIV), including the `never`
state. This is the clause that matters most on this surface: an agent acting
confidently on hour-old branch state does real damage, and it has no other way
to know. Responses state age in absolute timestamps, never "5 minutes ago" —
a relative string is wrong the moment it is quoted into a later turn.

### Notes — the shared channel

| Tool | Maps to | Purpose |
|---|---|---|
| `grndctrl_list_notes` | `notes.list` | Read context on a subject before working on it. |
| `grndctrl_add_note` | `notes.create` | Record a decision or a gotcha; ask the operator a question. |
| `grndctrl_update_note` | `notes.update` | Requires the `revision` that was read. |

`authorKind` is stamped `agent` by this adapter from the transport, never taken
from the payload — an agent cannot post as the user.

A note of type `question-for-human` is how an agent gets the operator's
attention: it surfaces in Attention, drives the session to `needs-you`, and moves
ball-in-court to the operator (FR-053). That is the whole escalation path, and it
works whether or not the agent is still running when the operator reads it.

**Conflicts are real.** `update` returns `conflict` with the current row when the
revision is stale. The agent must re-read and decide — appending is usually right,
overwriting the human's edit is not (FR-055).

### Sessions — telling Ground Control you exist

| Tool | Maps to | Purpose |
|---|---|---|
| `grndctrl_start_session` | `sessions.start` | Declare what is being worked on and a heartbeat interval. |
| `grndctrl_heartbeat` | `sessions.heartbeat` | "Still alive." Does **not** count as activity. |
| `grndctrl_report_activity` | `sessions.activity` | "Here is what I actually did." Advances the staleness clock. |
| `grndctrl_end_session` | `sessions.end` | Outcome recorded; stops counting as live. |

The heartbeat/activity split is deliberate: a process that is alive but stuck is
exactly the case the operator needs to see (FR-042, and the zombie-heartbeat edge
case). An agent that only heartbeats will show as running-but-stale rather than
healthy.

Sessions are authored local data. Reporting one is not a provider write, so XVI
is untouched.

### Work dispatch — claiming what the operator queued

| Tool | Maps to | Purpose |
|---|---|---|
| `grndctrl_list_pending_actions` | `outbox.pending` | Poll for work. **This is the contract.** |
| `grndctrl_claim_action` | `outbox.claim` | Exclusive claim with a TTL. |
| `grndctrl_complete_action` | `outbox.complete` | Report success; the effect appears on the board via the next normal sync, never by writing to the mirror. |
| `grndctrl_fail_action` | `outbox.fail` | Report why — including "I do not have write access to that provider", which is a legitimate and expected outcome. |

**`grndctrl_enqueue_action` does not exist**, and its absence is the design. Only
the operator can confirm an action into the outbox, via a UI gesture that mints a
single-use token (see [operations.md](./operations.md#why-mintconfirmation-is-the-one-ui-only-operation)).
An agent may *propose* one — by adding a `todo` or `question-for-human` note —
but it cannot queue work for itself. That is what keeps XVI's guarantee honest:
every provider write traces back to a human confirmation.

The claiming agent acts with **its own credentials and its own authority**.
Ground Control lends none, and holds none that could be lent.

---

## Push, and its exact limits

The server declares `resources.subscribe` and exposes one resource,
`grndctrl://outbox/pending`. When an action is confirmed, subscribed clients
receive `notifications/resources/updated`.

Three things that notification is **not**:

- It carries no payload. It means "re-read", nothing more.
- It only reaches a client that chose to subscribe, and client support for
  subscriptions is uneven across implementations.
- It cannot reach an agent that is not running.

So push is an accelerator and never the contract (FR-065). A correct agent polls
`grndctrl_list_pending_actions`; a subscribed agent additionally gets there
sooner. Any design where the notification is load-bearing breaks invisibly the
day the operator switches agents — which is why the durable outbox is the
substrate and this is a garnish on top (research
[R6](../research.md#r6--agent-transport-what-mcp-can-and-cannot-promise)).

---

## Errors

The registry taxonomy passes through unchanged, plus one that is specific to
this transport:

| Code | Meaning |
|---|---|
| `app_not_running` | no handshake file, or its process is gone |

`conflict`, `precondition_failed`, and `rate_limited` reach the agent verbatim,
with enough context to retry sensibly. Errors are returned as MCP tool errors
with a human-readable message, because the consumer is a model that will read it
and decide what to do — a bare code teaches it nothing.
