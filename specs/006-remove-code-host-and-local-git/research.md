# Phase 0 — Research: removing the code host and local git

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19 · **Spec**: [spec.md](./spec.md)

Six questions this change cannot be planned without answering. Each was settled by reading the code that exists today, not by recalling how it was designed — the two have disagreed before in this repository, and the disagreement is always in the direction of "the field exists on both sides and nothing connects it".

---

## R1 — What actually depends on the code host and local git?

**Method**: every file naming GitHub, a pull request, a check, a branch, a comparison or a workspace, read rather than counted.

**Answer**: 60+ source files across all five packages. They fall into four groups, and the groups matter more than the count because they need different treatment.

| Group | What it is | Treatment |
|---|---|---|
| **Pure code-host code** | `providers/github/*`, `providers/git/*`, their tests and fixtures | Delete. Nothing else lives in these files. |
| **Shared machinery holding code-host arms** | `services/sync.ts`, `correlation/{join,ball,severity,match}.ts`, `drift/rules.ts`, `services/links.ts`, `runtime/{providers,scheduler}.ts` | Narrow in place. Each is a working module with a code-host branch inside it. |
| **Type and schema surface** | `domain/types.ts`, both migration sets, `store/mirror/repository.ts`, `services/settings.ts` | Narrow, plus migrations. This is where the upgrade risk is. |
| **Presentation and adapters** | renderer lanes, settings screens, registry ops, MCP tools, CLI | Narrow. Mostly deletion of whole components. |

**Consequence for the plan**: the work is not one sweep. It is four passes with different failure modes, and the store pass is the only one that can lose data.

---

## R2 — Which drift rules survive? ⚠ CHANGES THE PRODUCT

**Method**: each of the nine rules read against the inputs it guards on.

| Rule | Guards on | Verdict |
|---|---|---|
| D1 — ticket not done, work is | `pullRequests.every(merged)` | **Dies** |
| D2 — work underway, ticket says new | PRs *or* workspaces *or* live sessions | **Survives, narrowed to sessions** |
| D3 — in progress, nothing agrees | no PRs, no workspaces, no sessions | **Survives, narrowed to sessions** |
| D4 — ticket done, PR open | open pull requests | **Dies** |
| D5 — PR merged, work stranded locally | merged PRs + dirty workspace | **Dies** |
| D6 — branch or PR names an unknown ticket | dangling references from matching | **Dies** |
| D7 — agent running, ticket never moved | live sessions + ticket status | **Survives unchanged** |
| D8 — in review, no reviewer requested | open non-draft PRs | **Dies** |
| D9 — real work with no ticket | PRs or pushed workspaces | **Dies** |

**Three of nine survive.** D2 and D3 lose two of their three evidence sources and keep the third; their summary strings must be rewritten, because both currently name branches and pull requests in text the operator reads.

**The identifier trap.** A finding's id is `drift:<rule>:<subjectKey>`, and a dismissal is keyed on that id with a hash of the evidence. If a future rule were numbered D1, every operator who had ever dismissed the old D1 on a ticket would find the new rule pre-dismissed on that ticket — silently, with no way to notice. **Retired identifiers are burned** (FR-114). The next rule is D10.

**D7's threshold is a live bug this change would create.** It reads `settings.laneThresholdHours.pulls` as "how long is too long for an agent to run" — a reasonable borrow while a pull-request lane existed to give that number meaning. Delete the field and D7 either fails to compile or, worse, gets defaulted to something nobody chose. It needs its own threshold (FR-103).

---

## R3 — What happens to severity and ball-in-court?

**Severity** keeps four of six sources: drift (`serious`), ticket blocked (`critical`), ticket awaiting other party (`warning`), session silent (`serious`), session needs-you (`warning`), and staleness (`warning`/`serious`/`critical` at 1×/2×/3× the threshold).

**All four bands stay reachable** — `critical` from a blocked ticket or 3× staleness, `serious` from drift, a silent agent or 2× staleness, `warning` from three sources, `good` from an item with nothing wrong. This matters beyond tidiness: FR-074 requires status to survive greyscale, and `greyscale.spec.ts` proves it by finding all four shapes on one board. Had a band become unreachable, that test would have had to be weakened, and weakening an accessibility guarantee to accommodate a removal is the wrong trade. It does not arise.

**Ball-in-court** loses three of its six inputs: `authoredPullRequests`, `reviewRequestedOfOperator`, `awaitingOthersReview`. What remains is an open question (→ you), ticket assigned to the operator and actionable (→ you), ticket assigned to someone else (→ them), a live session (→ agent).

**A consequence worth naming**: `them` becomes reachable only through ticket assignment. Previously a PR awaiting someone else's review put the ball in their court while the ticket stayed assigned to the operator — the common case for "I'm blocked on a review". That case is now invisible, and the ball reads `you`. The bias is documented as deliberate ("when the operator has anything to do, the answer is you"), so this errs in the direction the design already chose, but it errs harder.

---

## R4 — Can the authored store be narrowed without losing rows? ⚠ CHANGES THE DESIGN

**Method**: read the DDL, then check what SQLite will and will not do.

`projects` carries four columns to remove — `github_connection_id`, `repo_owner`, `repo_name`, `checkout_paths` — and a table constraint:

```sql
CHECK (jira_project_key IS NOT NULL OR repo_name IS NOT NULL)
```

**SQLite will not drop a column named in a table CHECK.** `ALTER TABLE … DROP COLUMN` refuses. So this is a **12-step table rebuild**: create the new table, copy every row, drop the old, rename. That is the documented-safe path and it is the one to take — but it means the migration writes every project row, which is the one place in this change where authored data is genuinely at risk. It gets its own test with a database written by 0.3.0.

**The constraint's replacement is a real decision, not a translation.** The obvious new constraint is `CHECK (jira_project_key IS NOT NULL)` — and it is wrong. A project bound only to a repository is legal today, and that constraint would make its row unwritable: the migration would have to delete it, or fail. Deleting an operator's project row to satisfy a constraint we chose is exactly the behaviour FR-109 forbids.

**Decision: the rebuilt table carries no such constraint.** "A project needs a ticket project" is enforced at `projects.upsert`, where the operator is present and can be told why, and a legacy repo-only project survives as an incomplete row that the project list shows as incomplete (FR-110). The constraint moves from the schema to the surface, deliberately, because only one of those two places can hold a conversation.

**`settings` needs no DDL** — it is a single JSON payload row. Its migration is a payload rewrite, and it must be idempotent (FR-113).

**`outbox_actions.kind` has no CHECK at all**, which turns out to be lucky: retiring two action kinds is a TypeScript-level change and historical rows keep reading without a migration.

---

## R5 — What about the mirror, and about credentials?

**The mirror is disposable and this is the one place that pays off.** Five tables go — `pull_requests`, `check_results`, `branch_refs`, `comparisons`, `local_workspaces` — with their indexes. No authored row references any of them (constitution XIII guarantees it), so `DROP TABLE` is safe and needs no copy.

Two things are *not* automatic:

- **Freshness rows** for the retired resource kinds sit in a table that survives, keyed `(connection_id, resource_kind)`. They must be deleted, or the header will keep reporting a "checks" resource that no longer exists (FR-111).
- **Connection rows of the removed kind** must go, and `connections.kind` has a `CHECK (kind IN ('jira','github'))` that would let one be written again. Rebuild the table with the narrowed check: it is a disposable store, the rebuild is cheap, and a constraint that permits what the application cannot do is a constraint that lies.

**Credentials outlive the rows that reference them.** A connection row holds a `credential_ref`, and the secret lives in the OS keychain. Dropping the row leaves the secret in the keychain, referenced by nothing, visible on no screen, and therefore never removed by anyone. The upgrade must delete it (FR-112) — read the refs *before* dropping the rows, then delete each from the keychain. Order matters and is easy to get backwards.

---

## R6 — What does removing local git buy, besides the lanes?

**It removes the only child process this application has ever spawned.**

`providers/git/exec.ts` runs the operator's own `git`, and `providers/git/allowlist.ts` exists solely to make that safe — a list of permitted subcommands and arguments, with tests for Windows path handling, spaces and non-ASCII paths. That is a meaningful attack surface and a meaningful maintenance burden, and both go to zero.

This is the one part of the change that makes the product strictly safer rather than strictly smaller, and it is worth asserting rather than merely enjoying: FR-100 says no child process, and a test can hold that.

**One thing must not be removed along with it.** `github.com` and `objects.githubusercontent.com` appear in the egress audit's **first-run** allow-list, because that is where Electron's platform-specific native module is downloaded on first launch. They are not provider hosts and are already documented as separate. A tidy-up that removes every mention of GitHub from the audit breaks installation on every fresh machine, and the symptom appears far from the cause. `api.github.com` leaves the *provider* allow-list; the first-run entries stay (FR-099 scope, SC-002 assertion).

---

## R7 — In what order can this be done so that every commit is green?

Removal work is usually red for a long stretch: delete the provider and the whole tree stops compiling until the last presentation change lands. That is avoidable here, and the avoidance is worth the planning.

**Outside in, not inside out.**

1. **Renderer first.** Remove the two lanes, their columns and their settings fields. Core still fetches data nothing renders — wasteful for one commit, and green. The board becomes what it will be, which means the question *is a ticket-only board worth using?* gets answered at step one rather than step five.
2. **Adapters.** Registry operations, MCP tools, CLI stop exposing code-host data. Still green; the data is still fetched and still ignored.
3. **Engine.** Correlation, drift, severity, ball, links narrow. Providers and sync arms delete. This is the largest step and the first one where behaviour changes rather than presentation.
4. **Types and store.** Domain types shrink, migrations land, settings reshape. Smallest diff, highest risk, most tests.
5. **Fixtures, docs, audits.** Scenarios rebuilt with relative time (which fixes the standing greyscale failure), documentation restated, audits tightened.

The alternative — delete the providers first — was rejected: it makes step 1 a several-thousand-line commit that cannot be reviewed or bisected, and it puts the riskiest change (the store) in the middle of a tree that does not build.

---

## Sources

Read in this repository at commit `8956f2f`:

- `packages/core/src/drift/rules.ts` — the nine rules and their guards
- `packages/core/src/correlation/{severity,ball,join,match}.ts` — what feeds a row
- `packages/core/src/store/{authored,mirror}/migrations.ts` — the DDL and its constraints
- `packages/core/src/services/{sync,links,connections}.ts` — the arms to narrow
- `packages/core/src/runtime/{providers,scheduler}.ts` — the wiring
- `scripts/audit-egress.ts` — the allow-list and its first-run exception
- `specs/001-ground-control-v1/spec.md` — the 88 requirements this amends
