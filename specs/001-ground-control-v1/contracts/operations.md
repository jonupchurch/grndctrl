# Contract — The Operation Registry

**Feature**: `001-ground-control-v1` · **Date**: 2026-08-14

This is the service layer. Everything the product can do is an entry here. The
IPC adapter, the loopback HTTP adapter, and the MCP server are three
translations of this one list, and none of them may contain logic that is not
reachable through it — constitution gate **XII**, made mechanical.

---

## Shape of an entry

```ts
interface Operation<In, Out> {
  name: string                     // 'work.list' — dotted, domain-first
  input: ZodSchema<In>
  output: ZodSchema<Out>
  exposure: 'all' | 'ui-only' | 'agent-only'   // explicit; no default
  mutates: boolean                 // read operations are cache-safe
  handler(input: In, ctx: Ctx): Promise<Out>
}
```

`exposure` exists so that asymmetry between adapters is **declared and tested**
rather than accidental. Gate XII's failure mode is a capability that quietly
exists on one surface and not the other; a default value would reintroduce it.
There is exactly one non-`all` entry in v1, and it is argued for below.

### Conformance test (the gate)

Three assertions, run in CI:

1. Every registry entry whose `exposure` allows a surface is present on that
   surface. A new operation that is wired into IPC but not MCP fails the build.
2. No adapter module imports from `core/providers`, `core/store`,
   `core/correlation`, or `core/drift`. Adapters may import the registry and
   nothing below it.
3. Every operation's declared output schema round-trips through each adapter's
   serialisation without loss — so MCP and IPC cannot answer the same question
   differently (XII: "materially different answers … is a defect").

---

## The freshness envelope

Every operation returning provider-derived data returns `Envelope<T>`. This is a
**type-level** enforcement of constitution XIV: an operation physically cannot
return provider data without its freshness, because the output schema will not
validate.

```ts
interface Envelope<T> {
  data: T
  freshness: {
    [resourceKind: string]: {
      lastSuccessAt: string | null      // null ⇒ NEVER SYNCED — not "stale"
      lastFailureAt: string | null
      failureReason: 'auth' | 'rateLimit' | 'network' | 'notFound' | 'unknown' | null
      nextAttemptAt: string | null
      state: 'fresh' | 'stale' | 'failed' | 'never'
    }
  }
  partial: boolean       // true ⇒ at least one contributing provider failed (XV)
}
```

`state` is computed, not stored, and the four values are kept distinct on
purpose — collapsing `failed` into `stale` is the exact error XIV forbids. The
envelope is identical on the MCP surface: a context packet handed to an agent
states the age of what it contains.

---

## Errors

One taxonomy, all adapters. Never a raw provider error across a boundary.

| Code | Meaning | Typical cause |
|---|---|---|
| `invalid` | input failed schema validation | trust-boundary rejection (Principle II) |
| `not_found` | subject does not exist | stale key |
| `conflict` | optimistic concurrency lost | note revision mismatch; second claim |
| `precondition_failed` | operation not legal in current state | completing an unclaimed action |
| `unauthorized` | connection credential rejected | expired PAT |
| `provider_unavailable` | provider unreachable | network, 5xx |
| `rate_limited` | provider throttling; carries `retryAfter` | GitHub budget spent |
| `keychain_unavailable` | OS credential store unreachable | headless Linux, no libsecret |

`keychain_unavailable` is its own code rather than folded into `unauthorized`
because FR-006 requires the app to say *specifically* that it cannot reach the
credential store, and to refuse to fall back.

---

## Registry

### Settings and lifecycle

| Operation | In → Out | Notes |
|---|---|---|
| `settings.get` | `{}` → `Settings` | |
| `settings.update` | `Partial<Settings>` → `Settings` | validates intervals and thresholds |
| `app.status` | `{}` → `{ version, platform, dbVersions, runtimeAbi }` | ABI surfaces here for the packaging failure in R8 |

### Connections

| Operation | In → Out | Notes |
|---|---|---|
| `connections.list` | `{}` → `Connection[]` | **never** returns a secret |
| `connections.add` | `{ kind, siteOrHost, accountLabel, secret }` → `Connection` | secret goes straight to the keychain and is not echoed back |
| `connections.test` | `{ connectionId }` → `{ ok, viewerIdentity?, checks[] }` | for GitHub, `checks[]` includes the **compare** probe — a token can authenticate and still lack `repo` scope for ahead/behind (R3) |
| `connections.remove` | `{ connectionId }` → `{}` | deletes the keychain entry (FR-007) |

### Projects

| Operation | In → Out | Notes |
|---|---|---|
| `projects.list` | `{}` → `Project[]` | |
| `projects.upsert` | `ProjectInput` → `Project` | validates key pattern compiles, documentation URL is `https` |
| `projects.remove` | `{ projectId }` → `{}` | **does not** delete notes — they are keyed naturally and survive (XIII) |

### The board

| Operation | In → Out | Notes |
|---|---|---|
| `work.list` | `{ projectId?, mineOnly?, lane? }` → `Envelope<WorkItem[]>` | the board's primary read |
| `work.get` | `{ key }` → `Envelope<WorkItem>` | |
| `board.summary` | `{ projectId? }` → `Envelope<{ yourCourt, drifting, stalled, agentsLive }>` | the four stat tiles (FR-073) |
| `drift.list` | `{ projectId? }` → `Envelope<DriftFinding[]>` | excludes live dismissals |
| `drift.dismiss` | `{ findingId }` → `{}` | stores the evidence hash so it auto-expires (FR-038) |
| `drift.undismiss` | `{ findingId }` → `{}` | |
| `links.resolve` | `{ subjectKey, target }` → `{ url }` | **the only place a URL is produced.** Scheme-checked to `https` here, so no adapter can hand an unvalidated provider string to `shell.openExternal` (FR-077). Falls back to the repository page for an unpushed branch (FR-076) |

### Sync

| Operation | In → Out | Notes |
|---|---|---|
| `sync.now` | `{ connectionId? }` → `Envelope<SyncReport>` | manual refresh (FR-014) |
| `sync.status` | `{}` → `FreshnessRecord[]` | per connection **per resource kind** |

### Notes

| Operation | In → Out | Notes |
|---|---|---|
| `notes.list` | `{ subjectKey }` → `Note[]` | includes `orphaned` notes (FR-056) |
| `notes.counts` | `{ subjectKeys[] }` → `Record<key, number>` | one call for a whole lane's badges |
| `notes.questions` | `{ projectId? }` → `Note[]` | the Attention nudges (FR-053) |
| `notes.create` | `{ subjectKey, type, body }` → `Note` | `authorKind` from the calling adapter — not from the payload, so an agent cannot claim to be the user |
| `notes.update` | `{ id, body?, type?, revision }` → `Note` | `conflict` on revision mismatch, carrying the current row (FR-055) |
| `notes.delete` | `{ id, revision }` → `{}` | |

### Sessions

| Operation | In → Out | Notes |
|---|---|---|
| `sessions.start` | `{ agentId, sessionId, workItemKey?, workspaceKey?, heartbeatIntervalSec }` → `AgentSession` | existing key ⇒ resumption (FR-044) |
| `sessions.heartbeat` | `{ key, reportedStatus? }` → `AgentSession` | does **not** advance `lastRealActivityAt` |
| `sessions.activity` | `{ key, reportedStatus, at? }` → `AgentSession` | future `at` clamped to receipt (FR-045) |
| `sessions.end` | `{ key, outcome }` → `AgentSession` | |
| `sessions.list` | `{ projectId? }` → `AgentSession[]` | `silent` derived at read time |

### Outbox

| Operation | In → Out | Exposure | Notes |
|---|---|---|---|
| `outbox.mintConfirmation` | `{ subjectKey, kind, payload }` → `{ token, expiresAt }` | **`ui-only`** | see below |
| `outbox.enqueue` | `{ token }` → `OutboxAction` | `all` | requires a token; rejects expired or reused |
| `outbox.pending` | `{ agentCapabilities? }` → `OutboxAction[]` | `all` | what an agent polls |
| `outbox.claim` | `{ actionId, agentId, ttlSec }` → `OutboxAction` | `all` | atomic; second claimant gets `conflict` (FR-062) |
| `outbox.complete` | `{ actionId, agentId, result }` → `OutboxAction` | `all` | |
| `outbox.fail` | `{ actionId, agentId, reason }` → `OutboxAction` | `all` | the "agent lacks write access" path (spec edge case) |
| `outbox.cancel` | `{ actionId }` → `OutboxAction` | `all` | |
| `outbox.list` | `{ projectId?, state? }` → `OutboxAction[]` | `all` | drives the board's action states (FR-066) |

#### Why `mintConfirmation` is the one `ui-only` operation

FR-059 and constitution XVI require every dispatched action to be individually
confirmed by the user, and FR-060 forbids dispatch as a side effect of a sync, a
rule firing, or a timer. Splitting confirmation from enqueue is what makes that
**structural instead of procedural**:

- `outbox.enqueue` cannot run without a token.
- Only `mintConfirmation` mints one, it is reachable only from the UI adapter,
  and it is bound to the exact subject, kind, and payload — so a token cannot be
  minted for one action and spent on another.
- Tokens are single-use and short-lived.

The result is that no code path in sync, correlation, drift, or the scheduler can
enqueue an action even by mistake, because none of them can obtain a token. It is
the difference between "we do not dispatch automatically" as a claim and as a
property. The conformance test asserts this asymmetry is declared, and a second
test asserts no module under `core/services/sync`, `core/correlation`, or
`core/drift` can reach `mintConfirmation`.

---

## Read-only by type (XVI)

The provider seam exposes no write method. There is no `transitionIssue`, no
`createComment`, no `merge`.

```ts
interface TicketProvider {           // no counterpart with writes exists
  searchIssues(...): Promise<Ticket[]>
  fetchChangelogs(keys: string[]): Promise<TicketActivity[]>
}
```

A write is not blocked by a check that could be forgotten — the function is not
there to call. Likewise the git module accepts only an allow-listed subcommand
set, so "never fetch" is a property of one file, asserted by one test (R4).
