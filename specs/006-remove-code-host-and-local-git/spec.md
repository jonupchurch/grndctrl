# Feature Specification: A ticket-and-agent board — removing the code host, local git and drift

**Feature Branch**: `006-remove-code-host-and-local-git`

**Created**: 2026-08-19

**Status**: Draft — planning complete, implementation not started

**Input**: GitHub pull-request tracking is a nonstarter against the operator's company GitHub. Remove it entirely, remove local repository checking with it, and remove the Attention region — confirmed by the operator against a marked-up screenshot of their own board on 2026-08-19, which struck through three regions: the pull request lane, the open branches lane, and Attention in full.

> **Source of truth.** This spec amends [`001-ground-control-v1`](../001-ground-control-v1/spec.md) rather than replacing it. Where the two disagree about the code host, local git or drift, this one wins; everything 001 says about tickets, sessions, notes, freshness, persistence and platform still stands. Constitution v4.0.0 Part II (XI–XVIII) remain hard gates.
>
> **Sequenced with [`007`](../007-agent-console/spec.md).** This spec empties three regions of the board; 007 fills the space with four new ones and makes every section collapsible. They ship in one release. Read 006 for what goes and 007 for what arrives.

---

## The problem

Ground Control was built to answer one question — *what actually needs me right now?* — by joining five sources: a ticket tracker, a code host, CI, local git, and agent sessions. Three of those five are unreachable here. The operator's company GitHub cannot be read by this application, and without it the code-host half of the board is not degraded, it is **empty**.

An empty lane is not neutral. This application's own rule is that an absence must be a fact rather than a failure — a row with no branch reads as "nothing started yet". A *lane* with no rows, permanently, on every board, reads as an application that is broken or misconfigured, and the operator learns to ignore two thirds of the screen. The freshness header makes it worse, not better: it reports "never synced" forever, which is true and useless.

The local git reader goes with it, and not only because the operator asked. It exists to answer questions that only make sense next to a code host — *is this branch ahead of the base, did this merged PR leave uncommitted work behind, has this branch ever been pushed*. Ahead/behind cannot be computed without the code host at all (FR-018). Alone, local git can say "this checkout is dirty", which is a fact the operator already has in their own terminal.

Drift goes too, and that one is not forced by the missing provider — it is a judgement the operator made looking at their own board. Six of the nine rules needed a pull request or a workspace and were dying anyway. The three that survive compare a ticket against an agent session, and on a board with no agent sessions running two of them have nothing to say and the third (D3 — "in progress, nothing agrees") would fire on **every** in-progress ticket older than three days. A region that is empty most of the time and noisy the rest is worse than no region.

What remains is a board that shows the operator's own tickets and their agents, accurately and with their age attached. That is a real thing to want. It is not what 001 set out to build, and the spec says so plainly rather than pretending the scope is unchanged.

---

## What this costs, stated up front

This is a removal, and it removes real capability. Recording it here so that nobody rediscovers it during implementation and treats it as a defect:

| Lost | Detail |
|---|---|
| **Two of three work lanes** | Pull requests and open branches. The board becomes one lane plus the session lane. |
| **Drift detection, entirely** | All nine rules, the Attention region, finding dismissals, and the DRIFTING tile. Six of the nine needed a pull request or a workspace and would have died anyway; the operator struck the region itself, so the remaining three go with it. |
| **The only route from the board to the outbox** | An action was minted by confirming a drift finding's suggestion. With no findings, nothing in the interface enqueues one. See *The outbox question* below. |
| **Most of ball-in-court's evidence** | Three of its six inputs are pull-request facts. "Them" becomes reachable only through ticket assignment. |
| **Four of severity's six sources** | Pull-request and workspace contributions go. Drift, ticket, session and staleness remain — all four severity bands stay reachable (see FR-104). |
| **Two of four action kinds** | `request-review` and `cleanup-workspace` have nothing to act on. |
| **The differentiator, gone** | 001's User Story 2 — "catch the sources disagreeing" — was the reason to build this application. It does not survive. What remains is a board that shows the operator's tickets and their agents accurately and quickly, which is a real thing to want and is not the thing this was originally for. |
| **001's User Story 5, unreachable** | "Act on what you found" ran through Attention. The outbox survives as an agent-facing store; nothing in the interface produces an action for it. |

**The alternative that was considered and rejected**: keeping the code host behind a per-project toggle, so the capability exists for anyone whose GitHub is reachable. Rejected because a disabled feature is still a live provider seam, a live set of tables, a live set of drift rules and a live set of lanes that must be kept correct with no board anywhere exercising them — and this codebase's recurring defect is precisely the field that both sides agree on and nothing connects. The capability is in the git history and can be restored from it; carrying it dark cannot be.

**One reversal is cheap and deliberately left open**: FR-099 keeps a plain repository *link* out of scope, but a project already stores `documentationUrl` as a stored-and-linked-only string. If the operator wants the repository reachable in one click, it is the same field shape and a one-line addition — not a re-litigation of this spec.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The board is about tickets and agents, and says so (Priority: P1)

The operator opens the board. There is one work lane — tickets assigned to them — with the headline counts above it and the session and ball-in-court panels beside it. Nothing on screen refers to a pull request, a branch, a check, a checkout, or a drift finding. The freshness header reports one provider, because there is one.

**Why this priority**: This is the whole change as the operator experiences it. Everything else in this spec is what has to be true underneath for this screen to be honest.

**Independent Test**: Launch against a seeded ticket-only scenario. The board renders exactly one work lane plus the session lane; no lane, heading, column, empty state, or settings field mentions a pull request, branch, check, repository or checkout; the freshness header names one provider and reports a real age.

**Acceptance Scenarios**:

1. **Given** a board with tickets on it, **When** the operator looks at the page, **Then** they see one work lane and the session lane, and no pull-request or branch lane exists in the DOM at all — not empty, not collapsed, not hidden.
2. **Given** a work item, **When** its row renders, **Then** the correlation badges show only the correlations that can still exist, and no slot is a permanent placeholder.
3. **Given** the settings screen, **When** the operator edits a project, **Then** there is no repository field and no checkout-path field, and the form does not ask for a GitHub connection.
4. **Given** the settings screen, **When** the operator opens connections, **Then** only ticket-tracker connections can be added, and no screen offers a GitHub token or names a GitHub permission.
5. **Given** the headline counts, **When** the operator reads them, **Then** the DRIFTING tile is gone and every remaining number is derived from tickets or sessions — nothing counts a row that no longer exists.
6. **Given** the board, **When** it is searched for an Attention region, a drift strip or a dismissal control, **Then** none exists.

---

### User Story 2 - Drift leaves without taking anything else with it (Priority: P2)

Drift detection is removed whole: nine rules, the Attention region, the dismissal store's readers and writers, the DRIFTING tile, and the confirm-and-dispatch route to the outbox. What must survive it is everything drift merely *touched* — the outbox's durable rows, the notes system, ball-in-court, and severity.

**Why this priority**: this is the removal most likely to take a bystander with it. Drift reaches into severity as an input, into the outbox as the thing that motivates an action, into notes through the question nudges Attention rendered, and into `authored.db` through the dismissals table. Each of those is a separate opportunity to delete something nobody asked to lose.

**Independent Test**: run the correlation engine over ticket-and-session fixtures and assert it produces no findings and has no rule to produce them with, while severity, ball-in-court and note counts are unchanged for the same inputs.

**Acceptance Scenarios**:

1. **Given** any input at all, **When** correlation runs, **Then** no drift finding is produced, because there is no rule left to produce one.
2. **Given** a work item that would previously have earned `serious` from a drift finding, **When** severity is computed, **Then** the drift contribution is absent and the other contributions are unchanged — severity is narrowed, not rebalanced.
3. **Given** `authored.db` holds finding dismissals written before the upgrade, **When** the upgrade completes, **Then** those rows are still present and untouched. They are the operator's decisions; nothing here is entitled to tidy them away.
4. **Given** outbox actions in any state, **When** the upgrade completes, **Then** every one is still listed, still claimable if pending, and still reports its motivating finding identifier even though no finding can be produced for it any more.
5. **Given** an open `question-for-human` note, **When** the board renders, **Then** it still drives its work item's ball-in-court to the operator. The nudge's *display* moves to 007's agent panel; its effect on ball-in-court is not part of Attention and does not leave with it.

---

## The outbox question

Recorded as an open decision rather than answered here, because answering it inside a removal spec would be smuggling a second removal in.

The outbox is eleven operations, a durable authored table, an audit trail, four MCP tools and constitution gate XVI's whole implementation. Its only *producer* was the confirm dialog behind a drift finding's suggested action. After this change an agent can still list, claim, complete and fail actions; nothing in the interface can create one.

**Recommendation: keep it, and record the gap.** Three reasons. It is durable authored data with live agent-facing operations, so it is not dead code in the sense that matters. Removing two subsystems in one change compounds the risk on the one migration that can lose data. And [007](../007-agent-console/spec.md) adds an agent panel that is the natural place for an action to be raised from a ticket row later.

**The counter-argument, stated fairly**: a feature nothing can trigger is exactly the "declared but never wired" shape this codebase keeps finding bugs in, and keeping it means keeping eleven operations honest with no board exercising them. If the operator would rather it went, it is a separate, cleanly-scoped removal — and it should be a separate one.

---

### User Story 3 - Nothing the operator wrote is lost (Priority: P3)

The operator has been using this application. They have notes on tickets, notes on pull requests, agent sessions in history, outbox actions, and dismissed findings. The upgrade keeps all of it. Notes whose subject can no longer be shown are kept and remain readable through the agent interface, rather than being deleted because the row they used to hang on is gone.

**Why this priority**: The mirror is disposable by design and can be thrown away without ceremony. `authored.db` is the operator's own writing, and constitution XIII exists to keep a provider change from touching it. A removal that quietly deletes notes would be the single worst outcome of this work.

**Independent Test**: Take a database written by 0.3.0 containing projects (including one bound only to a repository), notes on every subject kind, sessions, outbox actions of all four kinds, and dismissals. Upgrade. Assert every authored row still present, by count and by content.

**Acceptance Scenarios**:

1. **Given** an `authored.db` from 0.3.0, **When** the application starts on the new version, **Then** every note, session, outbox action and dismissal is still there.
2. **Given** notes attached to a pull request or a branch, **When** the upgrade completes, **Then** those notes still exist and are still readable by key, and the application reports them as orphaned rather than deleting them.
3. **Given** a project bound to a repository and no Jira project, **When** the upgrade completes, **Then** the project still exists, is listed, and is shown as needing a ticket project bound before it can do anything.
4. **Given** an outbox action of a retired kind, **When** the upgrade completes, **Then** the row still reads back with its kind and history intact.
5. **Given** the upgrade has run, **When** it is run a second time, **Then** it is a no-op and nothing is written twice.

---

### User Story 4 - The application stops being able to reach a code host at all (Priority: P4)

Not "stops using". Stops being able. After this change there is no code-host client in the tree, no repository host in the egress allow-list, and no child process — the local git reader was the only thing this application ever spawned.

**Why this priority**: The operator's reason for the removal is that their company GitHub is not to be touched by this application. "We stopped calling it" is a claim about the current code; "there is no client" is a claim a test can hold.

**Independent Test**: The dependency and egress audits, run over the shipped tree, with the code-host host removed from the provider allow-list and no new allowance added to compensate.

**Acceptance Scenarios**:

1. **Given** the shipped tree, **When** the egress audit runs, **Then** the only provider host contacted is the ticket tracker's.
2. **Given** the shipped tree, **When** it is searched for process spawning, **Then** there is none.
3. **Given** the first-run download of the native module, **When** the egress audit runs, **Then** it is still allowed and still named as a first-run allowance rather than as a provider — removing the wrong entry here breaks installation, and the audit must keep the two apart.

---

### Edge Cases

- **A project bound only to a repository.** It survives, it is listed, and it is inert until a ticket project is bound. It is not deleted, and it does not silently start matching every ticket.
- **A note on a subject that can no longer be rendered.** Retained. Reachable by key through the agent interface and the CLI. Not shown on the board, because there is no row to show it on — and this is stated as a known gap rather than papered over.
- **A dismissal for a retired rule.** Retained, inert, and harmless: the rule never fires again, so the row never matches. Deleting them would be writing to the operator's database to tidy up after ourselves.
- **A running agent that reports a workspace key.** The field is gone from the agent interface. An agent that sends it gets a clear rejection rather than silent acceptance of a value nothing resolves.
- **An in-flight outbox action of a retired kind at upgrade time.** It stays claimable and completable. Retiring a kind stops it being *produced*; it does not invalidate one the operator already confirmed.
- **Two severities that used to come only from pull requests.** `critical` and `serious` both remain reachable from ticket, session and staleness sources, so the greyscale guarantee (FR-074) is not weakened. This is asserted, not assumed.
- **A second upgrade run, or a downgrade.** The upgrade is idempotent. A downgrade to 0.3.0 is not supported and must fail loudly on the schema version rather than half-work.

---

## Requirements *(mandatory)*

Numbering continues 001's single namespace, because the codebase cites these identifiers in code comments and test names. Requirements retired or amended by this change are listed in the table that follows, and **a retired identifier is never reused**.

### Removal

- **FR-099**: The system MUST NOT contain a code-host provider client, a local git reader, or any code path that reaches either. Removal, not disablement: no configuration, build flag, or environment variable may re-enable them.
- **FR-100**: The system MUST NOT spawn a child process for any purpose.
- **FR-101**: No screen, tool description, empty state, README, changelog header, or package description may claim that the system correlates pull requests, CI results, branches, or local checkouts.
- **FR-102**: A project MUST be defined as one ticket project, an optional documentation URL, a short code, and a ticket-key pattern. Repository binding and checkout paths MUST NOT be part of it.
- **FR-103**: Poll interval configuration MUST cover the one remaining provider. Lane threshold configuration MUST cover the ticket lane and the agent-session lane. The pull-request and branch thresholds MUST go with their lanes.
- **FR-119**: Drift detection MUST be removed entirely — every rule, the Attention region, the DRIFTING tile, the dismissal read and write paths, and the confirm-and-dispatch route that ran through a finding's suggested action.
- **FR-120**: Removing drift MUST NOT remove anything drift merely referenced. Severity loses its drift *contribution* and keeps every other source. Ball-in-court is unaffected. Note counts, the notes modal and the open-question effect on ball-in-court are unaffected.
- **FR-121**: An open `question-for-human` note MUST still drive its work item's ball-in-court to the operator. Attention was where such a note was *displayed*; that display moves to [007](../007-agent-console/spec.md), and the requirement that it be visible somewhere is met there, not dropped here.
- **FR-122**: Stored finding dismissals MUST be retained untouched. They are the operator's decisions about their own board, and no part of a removal is entitled to delete them.

### What must still be true

- **FR-104**: All four severity bands MUST remain reachable from the sources that remain — ticket, session and staleness, with drift now gone from that list too — and this MUST be asserted by a test over a fixture rather than argued.
- **FR-105**: Ball-in-court MUST continue to resolve to the operator, another person, or an agent, using only the evidence that remains, and MUST keep its fixed evaluation order so that the answer cannot depend on iteration order.
- **FR-106**: Work items MUST continue to be keyed on the ticket. With no workspace to fall back to, a work item without a ticket MUST NOT be constructible.
- **FR-107**: Correlation MUST remain deterministic and MUST remain executable without a display, a network, or a shell.
- **FR-108**: Freshness MUST continue to distinguish stale, failed and never-synced, per connection and per resource kind, over the resource kinds that remain.

### The upgrade

- **FR-109**: Upgrading MUST preserve every row in `authored.db` — projects, notes, sessions, outbox actions, finding dismissals and settings. The upgrade MUST NOT delete an authored row for any reason, including that its subject can no longer be displayed.
- **FR-110**: A project that has no ticket project bound MUST survive the upgrade, MUST appear in the project list, and MUST be presented as incomplete rather than as working.
- **FR-111**: The mirror MUST drop the tables and indexes that held code-host and local data, and MUST NOT report freshness for a resource kind that no longer exists.
- **FR-112**: Stored credentials for removed connections MUST be deleted from the operating system credential store as part of the upgrade, not merely unreferenced. A secret nothing can reach and no screen can show is a secret nobody will ever remove.
- **FR-113**: The upgrade MUST be idempotent, and a database already upgraded MUST NOT be written again.
- **FR-114**: The drift rule identifier namespace MUST be treated as spent. If drift ever returns, its rules MUST NOT be numbered D1–D9: a dismissal is keyed on `drift:<rule>:<subject>` and stored dismissals are retained by FR-122, so a new rule reusing an old number would arrive pre-dismissed on every subject where the old one was ever dismissed — silently, with nothing to notice it by.

### The agent surface

- **FR-115**: The agent interface MUST NOT accept a session field that no longer resolves to anything. A caller sending one MUST get an explicit rejection rather than silent acceptance.
- **FR-116**: Agent-facing tool descriptions MUST describe the world as it is: an agent told it can read pull-request state will plan around data that will never arrive.
- **FR-117**: Notes MUST remain readable and writable by natural key through the agent interface for every subject kind that has ever existed, including subjects the board can no longer render.

### Test material

- **FR-118**: Scenario fixtures MUST express their timestamps relative to the moment the scenario is loaded, not as absolute dates. This closes a defect that already exists: `every-severity.json` carries 2026-08-14 timestamps, severity derives partly from staleness, and the scenario has aged out of producing the severities it is named for — which is why three greyscale tests fail on `main` today.

### Retired and amended from 001

| 001 requirement | Disposition |
|---|---|
| FR-001 | **Amended** by FR-102 — a project loses its repository and checkouts. |
| FR-010 | **Amended** by FR-103 — one provider interval, not two. |
| FR-016, FR-017, FR-018 | **Retired** — local git is gone, and with it ahead/behind. |
| FR-019, FR-020, FR-021, FR-022, FR-023 | **Retired** — nothing is left to join to a ticket, so branch/PR matching, many-to-many relations, worktree modelling and the dangling-key rule all go. Superseded by FR-106. |
| FR-029 | **Amended** — severity keeps four of its six sources. Bounded by FR-104. |
| FR-030 | **Amended** by FR-103 — thresholds for pulls and branches have no lanes. |
| FR-032 | **Amended** by FR-105 — three of six inputs retire. |
| FR-034, FR-035 (all nine rules), FR-036, FR-037, FR-039 | **Retired** — drift detection is removed whole (FR-119). Six rules needed a code host; the operator struck the region the other three appeared in. Identifier namespace spent by FR-114. |
| FR-038 | **Retired as a capability, honoured as data** — nothing can be dismissed because nothing is found, and existing dismissals are retained untouched (FR-122). |
| FR-041 | **Amended** by FR-115 — a session associates with a work item and a project, not a workspace. |
| FR-047 | **Amended** — sessions stand beside tickets; there are no PRs to stand beside. |
| FR-049 | **Amended** — notes attach to a ticket or a session going forward. Existing notes on other subjects are kept (FR-117). |
| FR-053 | **Amended** — a question-for-human note keeps its effect on ball-in-court (FR-121); its display leaves Attention for 007's agent panel. |
| FR-057 | **Unchanged and now trivially stronger** — read-only against providers, of which there is one. |
| FR-058–FR-068 | **Unchanged in code, unreachable from the interface.** The outbox keeps every operation and every row; nothing on the board produces an action any more. See *The outbox question*. |
| FR-072 | **Retired** — the Attention region is removed. |
| FR-073 | **Amended** — the DRIFTING tile goes; the other three headline counts stand. |
| FR-069 | **Amended** — one work lane plus the session lane. |
| FR-075 | **Amended** — tickets open at the tracker; there are no other provider objects. |
| FR-076 | **Retired** — no branch, no repository fallback. |
| FR-081 | **Unchanged in wording, weaker in force** — one lane cannot be isolated from the others by definition. Kept because the session lane and Attention are still separately fallible. |

---

## Key Entities

| Entity | Change |
|---|---|
| **Ticket** | Unchanged. |
| **Project** | Loses `githubConnectionId`, `repoOwner`, `repoName`, `checkoutPaths`. |
| **Connection** | Only one kind remains. |
| **PullRequest, CheckResult, BranchRef, Comparison, LocalWorkspace** | Removed. |
| **WorkItem** | Loses `workspaces`, `pullRequests`, `checks`, `comparisons`. Always has a ticket. |
| **AgentSession** | Loses `workspaceKey`. |
| **DriftFinding, DriftEvidence, DriftRule** | Removed. |
| **FindingDismissal** | Rows retained untouched; nothing reads or writes them (FR-122). |
| **OutboxAction** | Producible kinds narrow to `transition-ticket` and `investigate`. Stored rows of retired kinds still read. |
| **Settings** | `pollIntervalSec` and `laneThresholdHours` reshape (FR-103). |
| **Note** | Unchanged in shape. Gains permanently-orphaned instances. |

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The board renders one work lane and the session lane, and a full-text search of the rendered DOM for "pull request", "branch", "check", "repository", "checkout" and "drift" returns nothing.
- **SC-002**: The egress audit passes with exactly one provider host allowed, and the first-run download allowance still named separately.
- **SC-003**: A search of the shipped tree finds no process spawn and no code-host client.
- **SC-004**: An `authored.db` written by 0.3.0 upgrades with every row preserved, verified by count and content for all six tables.
- **SC-005**: Every finding dismissal written before the upgrade is still in `authored.db` after it, byte for byte.
- **SC-011**: No input to the correlation engine produces a drift finding, and there is no rule in the tree that could produce one.
- **SC-012**: Every outbox row survives the upgrade in its existing state, and an action that was pending before it is still claimable after it.
- **SC-006**: All four severity bands appear on a single seeded board, asserted from a fixture whose timestamps are relative to the run — which also returns `greyscale.spec.ts` to green.
- **SC-007**: Correlation over unchanged fixtures is byte-identical across two runs, including finding identifiers.
- **SC-008**: `npm run verify` is green, and the end-to-end suite is green **including** the three greyscale tests that fail on `main` today.
- **SC-009**: Every removed line is removed rather than commented out or guarded: no dead module, no unreferenced export, no `if (false)`.
- **SC-010**: The operator can complete the quickstart in [quickstart.md](./quickstart.md) against a real Jira project with no GitHub credential present anywhere on the machine.

---

## Assumptions

1. **The ticket tracker stays.** Jira remains reachable and remains the source of tickets.
2. **The agent surface stays and matters more, not less.** With one provider left, agent sessions are half of what the board correlates.
3. **No operator is relying on the removed regions today.** The application is used on one machine by one person, who marked up their own board to ask for this. If that changes, the git history holds the implementation.
6. **The space these removals free is filled by [007](../007-agent-console/spec.md).** This spec is not a plan for a board with three holes in it. If 007 does not proceed, the resulting board is thin enough that the layout deserves a second look before release.
4. **`mirror.db` may be dropped without ceremony.** It is disposable by construction and rebuilt from the provider. Only `authored.db` needs care.
5. **A downgrade is not supported.** Schema versions move forward. A 0.3.0 binary meeting a post-removal database must refuse to start rather than half-read it.
