# Phase 1 — Data Model: after the removal

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19 · **Plan**: [plan.md](./plan.md)

The three tiers from [001](../001-ground-control-v1/data-model.md) are unchanged in kind. What changes is how much is in each of them.

| Tier | Lives in | Lifecycle | Rule |
|---|---|---|---|
| **Mirrored** | `mirror.db` | disposable; delete and rebuild at will | never referenced by an authored row |
| **Authored** | `authored.db` | the operator's; a sync must never touch it | references providers by **natural key** only |
| **Derived** | memory, per correlation pass | recomputed, never stored | pure function of the two above |

No foreign key crosses a database file. This change is the first real test of that rule: five mirrored tables are dropped outright, and not one authored row has to be touched to allow it.

---

## Entities removed entirely

| Entity | Tier | Where it lived |
|---|---|---|
| `PullRequest` | mirrored | `pull_requests` |
| `CheckResult` | mirrored | `check_results` |
| `BranchRef` | mirrored | `branch_refs` |
| `Comparison` | mirrored | `comparisons` |
| `LocalWorkspace` | mirrored | `local_workspaces` |
| `DanglingReference` | derived | correlation output |

Their natural-key constructors go with them: `repositoryKey`, `pullRequestKey`, `branchKey`, `workspaceKey`, `checkKey`, `canonicalRemote`, `worktreeId`, `parseRepositoryRef`.

**`subjectKindOf` keeps every kind it can parse.** It maps a natural key to a subject kind, and notes written before this change carry keys of removed kinds (FR-117). A parser that stopped recognising them would turn a retained note into an unreadable one. It keeps the kinds and loses only the ability to *construct* them.

---

## Entities narrowed

### Project *(authored)*

| Field | Before | After |
|---|---|---|
| `id`, `code`, `name`, `colorIndex` | ✓ | ✓ |
| `jiraConnectionId`, `jiraProjectKey` | ✓ | ✓ |
| `githubConnectionId` | ✓ | **removed** |
| `repoOwner`, `repoName` | ✓ | **removed** |
| `documentationUrl` | ✓ | ✓ — still stored-and-linked-only, never fetched |
| `ticketKeyPattern` | ✓ | ✓ |
| `checkoutPaths` | ✓ | **removed** |
| `statusOverrides` | ✓ | ✓ |

**The table constraint does not survive as a constraint.** `CHECK (jira_project_key IS NOT NULL OR repo_name IS NOT NULL)` names a column being dropped, so SQLite requires a table rebuild — and its natural successor, `CHECK (jira_project_key IS NOT NULL)`, would make a legacy repository-only project unwritable and force the migration to delete it. The rebuilt table carries **no** constraint on this axis; the rule moves to `projects.upsert`, which can explain itself to the operator. See [R4](./research.md#r4--can-the-authored-store-be-narrowed-without-losing-rows--changes-the-design).

### Connection *(mirrored)*

`kind` narrows to one member. The table is rebuilt so `CHECK (kind IN ('jira'))` is true of what the application can actually store.

### AgentSession *(authored)*

Loses `workspaceKey`. The column is dropped; it is not named in any constraint, so `ALTER TABLE … DROP COLUMN` suffices.

### Settings *(authored, one JSON row)*

| Field | Before | After |
|---|---|---|
| `pollIntervalSec` | `{ github: 60, jira: 300 }` | `{ jira: 300 }` |
| `laneThresholdHours` | `{ tickets: 72, pulls: 24, branches: 24 }` | `{ tickets: 72, sessions: 24 }` |

`laneThresholdHours.sessions` is **new, and is not a rename**. It is the session lane's own staleness threshold. The old `pulls` value is carried across as its default so an operator who had tuned that number keeps it, but the two describe different things and the naming says so.

*(Drift rule D7 used to read `laneThresholdHours.pulls` as "how long is too long for an agent to run" — a borrow that would have become a live bug the moment the field was deleted. With drift removed the bug cannot occur, but the session lane still wants a threshold of its own, so the field lands anyway.)*

### WorkItem *(derived)*

Loses `workspaces`, `pullRequests`, `checks`, `comparisons`. `ticket` stops being nullable: with no workspace to key on, a work item without a ticket cannot be constructed (FR-106). `key` is always the ticket's key.

### DriftFinding, DriftEvidence, DriftRule *(derived)*

**Removed.** Drift detection goes whole.

**The identifier namespace D1–D9 is spent.** Stored dismissals are retained (below), and a dismissal is keyed on `drift:<rule>:<subject>` — so if drift ever returns, a rule numbered D1 would arrive pre-dismissed on every subject where the old D1 was ever dismissed, silently, with nothing to notice it by. Any future rule starts at D10.

### FindingDismissal *(authored)*

**Rows retained, untouched, with no reader and no writer.**

This is the one entity in this change that ends up inert rather than gone, and that is deliberate. The rows are the operator's decisions about their own board. A removal is not entitled to delete them, and "the table has no reader now" is an argument for leaving it alone, not for dropping it — the migration does not open it, and the migration test counts its rows to prove that.

### OutboxAction *(authored)*

Producible kinds narrow to `transition-ticket` and `investigate`. `request-review` and `cleanup-workspace` are retired. The column has no CHECK constraint, so historical rows keep reading and no migration is needed — an action the operator confirmed before the upgrade stays claimable and completable.

### ResourceKind *(mirrored, freshness)*

`'tickets' | 'pulls' | 'checks' | 'branches' | 'comparisons' | 'local'` → `'tickets'`. Rows for the retired kinds are deleted, or the header keeps reporting resources that no longer exist (FR-111).

---

## Entities unchanged

`Ticket`, `TicketActivity`, `Note`, `ActionHistoryEntry`, `ViewerIdentity`, `FreshnessRecord`, and the derived `Severity`, `StalenessBand`, `BallInCourt`.

`Severity` keeps its type and loses one of its *contributions* — `inDrift` goes as an input. `serious` stays reachable from a silent agent session and from 2× staleness, so no band is lost with it.

---

## Migration — `mirror.db`, version 3 → 4

Disposable, so this could be a file deletion. It is written as a migration anyway: an installed 0.3.0 has this file on disk, and a rebuild-on-launch would be a silent full resync at the worst moment — the launch where nothing else changed for the operator.

**Order is load-bearing.**

1. **Read the credential refs** of every connection of the removed kind. Before anything is dropped: after, there is nothing to read them from.
2. Delete those connections' rows.
3. Rebuild `connections` with `CHECK (kind IN ('jira'))`.
4. `DROP TABLE` × 5 — `pull_requests`, `check_results`, `branch_refs`, `comparisons`, `local_workspaces` — with their indexes.
5. `DELETE FROM freshness WHERE resource_kind <> 'tickets'`.

Step 1's refs are handed to the caller, which deletes each secret from the OS keychain (FR-112). The migration itself never touches the keychain — a migration that reached outside the database file would be doing something a migration cannot roll back, and could not be run against a test database without side effects.

---

## Migration — `authored.db`, version 1 → 2

The one that can lose data. Every step is a copy, in one transaction.

1. **`projects`** — 12-step rebuild. New table without the four removed columns and without the old CHECK; `INSERT INTO … SELECT` the retained columns for **every** row, including projects with no `jira_project_key`; drop the old; rename.
2. **`agent_sessions`** — `ALTER TABLE agent_sessions DROP COLUMN workspace_key`. No constraint names it.
3. **`settings`** — read the single payload row, reshape `pollIntervalSec` and `laneThresholdHours` (carrying `pulls` → `sessions`), write it back. Idempotent: a payload already in the new shape is left alone (FR-113).
4. **`notes`, `outbox_actions`, `finding_dismissals`** — untouched. Not "migrated with no changes": genuinely not opened. They hold keys, kinds and rule identifiers that no longer resolve, and that is the correct state (FR-109, FR-117, FR-122).

**What the test must hold**: a database written by 0.3.0 containing at least one project of each shape (Jira+repo, Jira only, repo only), notes on all five subject kinds, sessions with and without a workspace key, outbox actions of all four kinds, and a dismissal for a rule about to be retired. After the upgrade: every row present, every count equal, the repo-only project still there, the dismissal still suppressing.

---

## What becomes unreachable, and stays

Stated plainly because it is the one place this change leaves something worse than it found it.

A note the operator wrote on a pull request or a branch is **kept** — retained by natural key, readable through `notes.list` over MCP and the CLI, never deleted. But the board has no row to render it on, so it is invisible in the application's own interface. FR-109 keeps the data; nothing in this change makes it visible again. Building a view for it is [deferred](./plan.md#deferred-decisions), and the deferral is a decision rather than an oversight.
