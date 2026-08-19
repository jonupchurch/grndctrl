# Contract delta — The Operation Registry

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19

Amends [001's operations contract](../../001-ground-control-v1/contracts/operations.md). The registry's shape, exposure model and envelope rules are unchanged; what changes is the list and four of the signatures.

Gate **XII** is what makes this list the whole surface: the IPC bridge, the loopback HTTP adapter and the MCP server are three translations of it, so an operation removed here is removed from all three, and none of them may keep a private path to data the registry no longer offers.

---

## Operations removed

Three, all of them drift.

| Operation | Why |
|---|---|
| `drift.list` | Nothing produces a finding. |
| `drift.dismiss` | Nothing to dismiss. |
| `drift.undismiss` | Nothing to restore. |

The other 34 survive. That is worth stating rather than assuming — the removal is deep but mostly about *what the operations return*, not about which questions can be asked.

**The eight outbox operations survive with no producer.** `outbox.mintConfirmation` and `outbox.enqueue` were reached from the confirm dialog behind a drift finding; nothing in the interface reaches them now. They stay because they are the agent-facing half of a durable store holding the operator's confirmed actions — see *The outbox question* in [spec.md](../spec.md). It is recorded as a gap, not as an oversight.

---

## Operations narrowed

### `links.resolve`

`target` loses four of its seven members.

| Target | Before | After |
|---|---|---|
| `default` | ✓ | ✓ |
| `ticket` | ✓ | ✓ |
| `documentation` | ✓ | ✓ |
| `pull-request` | ✓ | **removed** |
| `repository` | ✓ | **removed** |
| `branch` | ✓ | **removed** |
| `check` | ✓ | **removed** |

The `fellBack` field on the result stays in the schema and is now always `false`. It existed for FR-076 — a branch the code host had never seen falling back to the repository page — and there is no longer a case that sets it.

**Decision: keep the field.** It costs a boolean and it is the difference between "this is the page you asked for" and "this is the nearest page we could find", which is a distinction a future link kind will want again. A caller that reads it gets a truthful `false`.

*Counter-argument recorded*: a field that is always one value is a field that will be assumed away. It is documented here as permanently false so that assumption is at least written down.

### `projects.upsert` / `projects.list`

Input and output lose `githubConnectionId`, `repoOwner`, `repoName`, `checkoutPaths`.

**`projects.upsert` gains a validation it did not have**: a project must name a ticket project. This was previously a table CHECK that also accepted a repository ([R4](../research.md#r4--can-the-authored-store-be-narrowed-without-losing-rows--changes-the-design)); it moves here because this is where the operator is present to be told why, and because the schema must stay permissive enough to hold a legacy repository-only row (FR-110).

The error is a validation error naming the field, not a constraint violation surfacing as a store failure.

### `connections.test`

`repo` input parameter removed. The `checks` array — which existed so that "the token authenticates", "it can read the repository" and "it can run a comparison" could be reported separately — narrows to the ticket-tracker probes.

**The array shape stays.** It exists because folding several probes into one boolean hides the failure worth naming, and that reasoning does not depend on how many probes there are.

### `work.list` / `work.get`

The returned work item loses `workspaces`, `pullRequests`, `checks` and `comparisons`, and its `ticket` is no longer nullable.

The output schema is `z.custom<WorkItem>` by design — 001 chose not to restate fourteen entity shapes at the boundary, because two definitions of the domain drift and the second one truncates a field it forgot. That choice pays here: the narrowing is a TypeScript change and the boundary follows it automatically.

### `sync.now` / `sync.status`

`provider` narrows to the one remaining kind. `sync.status` reports one resource kind per connection instead of six.

### `settings.get` / `settings.update`

`pollIntervalSec` and `laneThresholdHours` reshape as in [data-model.md](../data-model.md#settings-authored-one-json-row). `laneThresholdHours.sessions` is new and is not a rename of `pulls` — it is the session lane's own staleness threshold, which takes the old `pulls` value as its default so a tuned number is not lost.

### `board.summary`

`lanes` loses `pulls` and `branches`, keeping `tickets` and `sessions`.

**`drifting` is removed with the tile it fed.** `stalled`, `yourCourt` and `agentsLive` keep their meaning exactly — each counts work items or sessions, and both still exist. The numbers get smaller; the definitions do not move.

---

## Operations unchanged

`notes.*` (6), `sessions.*` (5), `outbox.*` (8), `connections.list`, `connections.remove`, `projects.remove`, `app.status`.

`drift.*` is gone; see above.

---

## What the conformance test must now assert

The registry has a conformance descriptor that every adapter is checked against. Three additions:

1. **No operation names a removed target, kind or field.** Enumerated, not pattern-matched — a regex over the schema would pass on a field the pattern did not anticipate.
2. **Every `providerDerived` operation still returns an envelope.** Unchanged rule, re-asserted: it would be easy to lose an envelope while narrowing a handler that used to merge freshness from several resource kinds and now merges one.
3. **`links.resolve` refuses a removed target with a clear error**, not a fallback. A caller asking for a pull-request link must be told the target does not exist, not quietly handed the ticket.
