# Phase 1 — Data Model: Ground Control v1

**Feature**: `001-ground-control-v1` · **Date**: 2026-08-14 · **Plan**: [plan.md](./plan.md)

Three tiers, and the boundaries between them are the point:

| Tier | Lives in | Lifecycle | Rule |
|---|---|---|---|
| **Mirrored** | `mirror.db` | disposable; delete and rebuild at will | never referenced by an authored row |
| **Authored** | `authored.db` | the user's; a sync must never touch it | references providers by **natural key** only |
| **Derived** | memory, per correlation pass | recomputed, never stored | pure function of the two above |

No foreign key crosses a database file. That is what makes "delete the mirror"
a file deletion rather than a careful cascade (XIII), and it means every
cross-tier join is written deliberately in code.

---

## Natural keys

The load-bearing idea in the whole model. An authored row survives the mirror
being rebuilt because it never pointed at a mirrored row in the first place —
it points at a string that the provider will produce again.

| Subject | Key format | Example |
|---|---|---|
| Jira issue | `jira:<siteId>/<ISSUEKEY>` | `jira:acme.atlassian.net/MERC-1184` |
| GitHub PR | `gh:<owner>/<repo>#<number>` | `gh:acme/mercury#451` |
| GitHub repository | `gh:<owner>/<repo>` | `gh:acme/mercury` |
| Branch | `repo:<canonicalRemote>#<branch>` | `repo:github.com/acme/mercury#feature/merc-1184` |
| Workspace | `ws:<canonicalRemote>#<branch>@<worktreeId>` | `ws:github.com/acme/mercury#merc-1184@main` |
| Agent session | `session:<agentId>/<sessionId>` | `session:claude-code/01J8XY…` |
| Check run | `check:<owner>/<repo>@<sha>/<checkName>` | `check:acme/mercury@a1b2c3/build` |

**Construction rules** — all in `core/src/domain/keys.ts`, all pure, all unit
tested:

- `canonicalRemote` strips scheme, credentials, `www.`, an explicit port, a
  trailing `.git`, and the SSH/HTTPS distinction, then **lowercases the whole
  remote**. `git@github.com:Acme/Mercury.git` and
  `https://github.com/Acme/Mercury` produce the same key. Without this, a note
  attached from an SSH checkout is invisible from an HTTPS one.

  > **Revised during implementation.** This originally said to lowercase the
  > host and *preserve the path's case*. That is wrong for every host this
  > product targets — GitHub, GitLab, and Bitbucket all treat owner and
  > repository names case-insensitively, so a local remote reading `acme/mercury`
  > and an API response reading `Acme/Mercury` are the same repository. Preserving
  > case would have given them different keys and silently orphaned every note on
  > one side, which is precisely the failure XIII exists to prevent.
- Branch names keep their case and their slashes; they are not path segments.
- `worktreeId` is `main` for the primary worktree, otherwise a stable hash of
  the worktree's canonical path — a path so that two worktrees on the same
  branch stay distinct, hashed so a drive letter change does not orphan notes.
- Keys are compared as opaque strings. Nothing parses a key to recover its parts;
  every consumer that needs the parts carries them separately.

---

## Mirrored entities (`mirror.db`)

Every mirrored table carries `connectionId`, `fetchedAt`, and its natural key.
Every one is safe to truncate.

### Connection

An authenticated provider endpoint. The unit of failure for XV.

| Field | Type | Notes |
|---|---|---|
| `id` | text, pk | stable, generated at configuration |
| `kind` | `jira` \| `github` | |
| `siteOrHost` | text | `acme.atlassian.net`, `github.com` |
| `accountLabel` | text | operator-facing name |
| `viewerIdentity` | json | resolved authenticated user (FR-033) |
| `credentialRef` | text | keychain *service/account* pair — **never the secret** |

> `credentialRef` is a lookup handle. A test asserts no column in either database
> ever holds a value that appears in the keychain (SC-011).

### FreshnessRecord

Per connection **per resource kind** — not per app (FR-011, XIV).

| Field | Type | Notes |
|---|---|---|
| `connectionId` + `resourceKind` | composite pk | `tickets`, `pulls`, `checks`, `branches`, `comparisons` |
| `lastSuccessAt` | timestamp \| null | null ⇒ **never synced**, which is not "stale" |
| `lastFailureAt` | timestamp \| null | |
| `failureReason` | enum \| null | `auth` \| `rateLimit` \| `network` \| `notFound` \| `unknown` |
| `nextAttemptAt` | timestamp \| null | set by backoff; rendered as "retrying in…" (FR-015) |

**Three distinct states** (FR-013), and the model refuses to collapse them:
never synced (`lastSuccessAt` null) · stale (success old, no newer failure) ·
failed to refresh (`lastFailureAt` > `lastSuccessAt`).

### Ticket

| Field | Notes |
|---|---|
| `key` (natural) · `id` · `summary` · `assignee` · `reporter` | |
| `statusName` · `statusCategory` | category ∈ `new` \| `indeterminate` \| `done` — **rules read the category** (research R2) |
| `isBlocked` | from the project's blocked-status override, not a name match |
| `createdAt` · `updatedAt` | `updatedAt` is displayed, never used for staleness (FR-027) |
| `lastRealActivityAt` | computed from `TicketActivity`; null ⇒ **unknown**, rendered as such |
| `url` | provider-supplied; scheme-checked before use (FR-077) |

### TicketActivity

From the bulk changelog fetch. Exists so staleness is falsifiable.

| Field | Notes |
|---|---|
| `ticketKey` · `at` · `authorKind` (`human` \| `bot` \| `automation`) | |
| `field` | `status`, `assignee`, `comment`, … |
| `countsAsReal` | evaluated on ingest against FR-026/FR-027 and **stored**, so the rule that produced a staleness value is inspectable later |

### PullRequest

| Field | Notes |
|---|---|
| `key` (natural) · `number` · `title` · `author` · `headBranch` · `baseBranch` | |
| `state` | `open` \| `merged` \| `closed` |
| `isDraft` · `mergedAt` · `closedAt` | |
| `reviewDecision` | `approved` \| `changesRequested` \| `reviewRequired` \| null |
| `requestedReviewers` | json array — drives ball-in-court and drift D8 |
| `unresolvedThreadCount` | from `reviewThreads { isResolved, isOutdated }` — the reason GraphQL is required |
| `lastRealActivityAt` | commits, human reviews, human comments; bot comments excluded |

### CheckResult

| `key` (natural) · `sha` · `name` · `state` (`success`/`failure`/`pending`/`cancelled`/`skipped`) · `isRequired` · `url` · `completedAt` |

### BranchRef and Comparison

`BranchRef` is the code host's view: `key`, `name`, `headSha`, `updatedAt`, `url`.

`Comparison` is ahead/behind, kept separate because it is fetched separately and
costs separately (research R3):

| Field | Notes |
|---|---|
| `branchKey` + `baseRef` | composite pk |
| `aheadBy` · `behindBy` | **nullable — null means unknown, never zero** (FR-018) |
| `comparedAtSha` | skip the next comparison while the head SHA is unchanged |

### LocalWorkspace

What only local git knows (FR-016). Never a network read.

| Field | Notes |
|---|---|
| `key` (natural) · `repoPath` · `canonicalRemote` · `branch` · `worktreeId` | |
| `isPrimaryWorktree` · `worktreePresent` | absent worktree + live branch ⇒ drift |
| `hasUncommittedChanges` · `unpushedCommitCount` | |
| `headSha` · `upstreamRef` | `upstreamRef` null ⇒ never pushed ⇒ comparison stays unknown |
| `readAt` | local reads get freshness too |

---

## Authored entities (`authored.db`)

Never written by a sync. Never deleted by one.

### Project

The operator's unit of organisation (FR-001).

| Field | Notes |
|---|---|
| `id` · `code` (3–4 chars) · `name` · `colorIndex` | beyond the palette ⇒ neutral chip (FR-080) |
| `jiraConnectionId` · `jiraProjectKey` | |
| `githubConnectionId` · `repoOwner` · `repoName` | |
| `documentationUrl` | stored and linked only — never fetched (FR-004) |
| `ticketKeyPattern` | defaults from `jiraProjectKey`; overridable (FR-003) |
| `checkoutPaths` | json array; may be empty — a project with no local checkout is valid |
| `statusOverrides` | json; maps status names to blocked/terminal where category is wrong |

**Validation**: `code` unique · at least one of the two provider bindings present ·
`documentationUrl` must parse and be `https` · `ticketKeyPattern` must compile
and must contain a capture group.

### Note

| Field | Notes |
|---|---|
| `id` · `subjectKey` (natural) · `type` (`decision` \| `gotcha` \| `question-for-human` \| `todo`) | |
| `body` · `authorKind` (`user` \| `agent`) · `authorId` | |
| `revision` | integer, incremented per write — the concurrency control (FR-055) |
| `createdAt` · `updatedAt` · `resolvedAt` | |

**Concurrency**: a write carries the revision it read. Mismatch ⇒ rejected with
`conflict`, carrying the current row so the caller can show both. Never merged,
never last-write-wins (spec Assumption 6).

**Orphaning**: a note whose `subjectKey` is absent from the mirror is *not*
deleted. It is returned with `orphaned: true` (FR-056). Because the key is
natural, a subject that reappears re-attaches with no repair step.

### AgentSession

| Field | Notes |
|---|---|
| `key` (natural) · `agentId` · `sessionId` · `projectId` · `workItemKey` · `workspaceKey` | |
| `reportedStatus` | free text from the agent, e.g. "Writing tests for the cold-start path" |
| `state` | `running` \| `silent` \| `needs-you` \| `done` \| `failed` |
| `startedAt` · `lastHeartbeatAt` · `lastRealActivityAt` · `endedAt` | |
| `heartbeatIntervalSec` | declared by the agent at start; the miss window is 3× |

**State machine** — `silent` is derived at read time from
`now - lastHeartbeatAt > 3 × interval`, never stored as a transition, so a
restart re-evaluates rather than trusting a stale flag (FR-046):

```
      start ──────────────► running ──── end(done) ─────► done
                            │   ▲        end(failed) ───► failed
        heartbeat missed ×3 │   │ heartbeat
                            ▼   │
                          silent┘
   running/silent ── question note attached ──► needs-you
   needs-you ──────── question resolved ──────► running
```

Sessions are authored data, not provider writes — XVI is untouched.

**Rules**: a start for an existing key is a **resumption**, not a new row
(FR-044) · timestamps in the future are clamped to receipt time (FR-045) · a
heartbeat alone does not advance `lastRealActivityAt`, so a zombie heartbeat
cannot make a dead session look busy (spec edge case).

### OutboxAction

| Field | Notes |
|---|---|
| `id` · `subjectKey` · `kind` (`transition-ticket` \| `request-review` \| `cleanup-workspace` \| `investigate`) | |
| `payload` | json; the requested change |
| `motivatingFindingId` | nullable — a dispatch may be manual |
| `state` | `pending` \| `claimed` \| `complete` \| `failed` \| `expired` \| `cancelled` |
| `confirmedAt` · `confirmedVia` | **required** — an action cannot exist unconfirmed (FR-059) |
| `claimedBy` · `claimedAt` · `claimExpiresAt` | |
| `result` · `failureReason` · `completedAt` | |
| `history` | append-only json log of every state change |

**State machine**:

```
   (user confirms) ──► pending ──claim──► claimed ──complete──► complete
                          ▲                  │    ──fail─────► failed
                          └─── claim expired ┘
        pending ──cancel──► cancelled
        pending ──ttl─────► expired
```

**Invariants, and each one is a test**: `confirmedAt` is non-null at insert ·
a claim is an atomic conditional update, so a second claimant gets zero rows
changed and a `conflict` (FR-062) · an expired claim returns to `pending` with
the attempt recorded in `history`, never silently (FR-063) · `history` is
append-only.

### FindingDismissal, Settings

`FindingDismissal`: `findingId` · `dismissedAt` · `evidenceHash`. The hash is of
the finding's evidence tuple, so the dismissal auto-expires when the evidence
changes rather than when a sync merely runs (FR-038, spec Assumption 7).

`Settings`: appearance · density · poll intervals · lane thresholds · grace and
heartbeat windows · active project filter · court filter · window geometry
(FR-082). Single row, schema-versioned.

---

## Derived entities (memory only)

Output of the correlation pass. Never persisted — persisting them would create a
third place for truth to live and a fourth to invalidate.

### WorkItem

| Field | Notes |
|---|---|
| `key` | the ticket key where one exists, else the workspace key (FR-019) |
| `projectId` · `ticket?` · `workspaces[]` · `pullRequests[]` · `checks[]` · `sessions[]` · `noteCount` | |
| `severity` · `staleness` · `ballInCourt` · `lastRealActivityAt` | |
| `resolution` | `full` \| `partial` — partial when a provider failed (XV); the item still renders |
| `freshness` | per contributing resource kind, so a row can be fresh in one dimension and stale in another |

**Fan-out rule** (FR-020): one ticket with three PRs is one WorkItem with three
entries. A key matching no known ticket produces **no** WorkItem — it produces a
finding (FR-022). Work with no key at all keys on the workspace and is marked
unlinked.

### DriftFinding

| Field | Notes |
|---|---|
| `id` | `drift:<rule>:<subjectKey>` — stable across restarts (FR-039), which is what makes dismissals durable |
| `rule` | `D1`…`D9` |
| `subjectKey` · `evidence` (both sides, each with its timestamp) · `ageSec` | |
| `suggestedAction` · `dispatchable` | |

### Severity, staleness, ball-in-court

Pure functions, each with its own test table, each taking plain data:

- `severity(inputs) → good | warning | serious | critical` — the max over the six
  contributions in FR-029.
- `staleness(lastRealActivityAt, now) → band` — five absolute bands (FR-028).
  Distinct from the *threshold-relative* comparison severity uses; conflating
  them was the bug this separation prevents.
- `ballInCourt(inputs) → you | them | agent` — FR-032, evaluated in the listed
  order so the outcome is deterministic when several conditions hold.

---

## Entity relationships

```
Connection ─┬─► Ticket ──► TicketActivity
            ├─► PullRequest ──► CheckResult
            └─► BranchRef ──► Comparison
                              LocalWorkspace   (no connection — local only)

Project ──► binds one Jira project + one repo + checkout paths

                  ┌── ticket (0..1)
   WorkItem ──────┼── workspaces (0..n)
   (derived)      ├── pullRequests (0..n)
                  ├── sessions (0..n)
                  └── notes (0..n, by natural key)

   DriftFinding ──► subjectKey ──► WorkItem or a dangling key
   OutboxAction ──► subjectKey, motivatingFindingId?
```

Authored rows (`Note`, `AgentSession`, `OutboxAction`, `FindingDismissal`) attach
by natural key **across the file boundary**. Nothing in the diagram crosses it as
a foreign key, and nothing may.

---

## Migrations

Two independent, forward-only chains — `mirror.db` and `authored.db` — each with
its own version table.

A **mirror migration may be replaced by a drop-and-resync**: if a schema change is
awkward, deleting the file is a legitimate migration strategy, and the app must
survive it because XIII already requires that on any given launch.

An **authored migration may never lose data**. Every authored migration ships a
test that seeds the prior schema, migrates, and asserts every row survives with
its content intact. There is no server-side copy to restore from — Principle XI
means a data-losing migration is unrecoverable, not merely embarrassing.
