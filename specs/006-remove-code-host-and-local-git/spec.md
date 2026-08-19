# Feature Specification: A ticket-and-agent board — removing the code host and local git

**Feature Branch**: `006-remove-code-host-and-local-git`

**Created**: 2026-08-19

**Status**: Draft — planning complete, implementation not started

**Input**: GitHub pull-request tracking is a nonstarter against the operator's company GitHub. Remove it entirely, and remove local repository checking with it.

> **Source of truth.** This spec amends [`001-ground-control-v1`](../001-ground-control-v1/spec.md) rather than replacing it. Where the two disagree about the code host or local git, this one wins; everything 001 says about tickets, sessions, notes, the outbox, freshness, persistence and platform still stands. Constitution v4.0.0 Part II (XI–XVIII) remain hard gates.

---

## The problem

Ground Control was built to answer one question — *what actually needs me right now?* — by joining five sources: a ticket tracker, a code host, CI, local git, and agent sessions. Three of those five are unreachable here. The operator's company GitHub cannot be read by this application, and without it the code-host half of the board is not degraded, it is **empty**.

An empty lane is not neutral. This application's own rule is that an absence must be a fact rather than a failure — a row with no branch reads as "nothing started yet". A *lane* with no rows, permanently, on every board, reads as an application that is broken or misconfigured, and the operator learns to ignore two thirds of the screen. The freshness header makes it worse, not better: it reports "never synced" forever, which is true and useless.

The local git reader goes with it, and not only because the operator asked. It exists to answer questions that only make sense next to a code host — *is this branch ahead of the base, did this merged PR leave uncommitted work behind, has this branch ever been pushed*. Ahead/behind cannot be computed without the code host at all (FR-018). Alone, local git can say "this checkout is dirty", which is a fact the operator already has in their own terminal.

What remains is a board that joins **tickets and agent sessions** and reports where those two disagree. That is a smaller product than 001 described, and the spec says so plainly rather than pretending the scope is unchanged.

---

## What this costs, stated up front

This is a removal, and it removes real capability. Recording it here so that nobody rediscovers it during implementation and treats it as a defect:

| Lost | Detail |
|---|---|
| **Two of three work lanes** | Pull requests and open branches. The board becomes one lane plus the session lane. |
| **Six of nine drift rules** | D1, D4, D5, D6, D8, D9 all require a pull request or a workspace. See *Drift* below. |
| **Most of ball-in-court's evidence** | Three of its six inputs are pull-request facts. "Them" becomes reachable only through ticket assignment. |
| **Four of severity's six sources** | Pull-request and workspace contributions go. Drift, ticket, session and staleness remain — all four severity bands stay reachable (see FR-104). |
| **Two of four action kinds** | `request-review` and `cleanup-workspace` have nothing to act on. |
| **The differentiator, narrowed** | 001's User Story 2 — "catch the sources disagreeing" — was the reason to build this. It survives, over two sources instead of five. |

**The alternative that was considered and rejected**: keeping the code host behind a per-project toggle, so the capability exists for anyone whose GitHub is reachable. Rejected because a disabled feature is still a live provider seam, a live set of tables, a live set of drift rules and a live set of lanes that must be kept correct with no board anywhere exercising them — and this codebase's recurring defect is precisely the field that both sides agree on and nothing connects. The capability is in the git history and can be restored from it; carrying it dark cannot be.

**One reversal is cheap and deliberately left open**: FR-099 keeps a plain repository *link* out of scope, but a project already stores `documentationUrl` as a stored-and-linked-only string. If the operator wants the repository reachable in one click, it is the same field shape and a one-line addition — not a re-litigation of this spec.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The board is about tickets and agents, and says so (Priority: P1)

The operator opens the board. There is one work lane — tickets assigned to them — with the Attention region beneath it, the headline counts above it, and the session and ball-in-court panels beside it. Nothing on screen refers to a pull request, a branch, a check, or a checkout. The freshness header reports one provider, because there is one.

**Why this priority**: This is the whole change as the operator experiences it. Everything else in this spec is what has to be true underneath for this screen to be honest.

**Independent Test**: Launch against a seeded ticket-only scenario. The board renders exactly one work lane plus the session lane; no lane, heading, column, empty state, or settings field mentions a pull request, branch, check, repository or checkout; the freshness header names one provider and reports a real age.

**Acceptance Scenarios**:

1. **Given** a board with tickets on it, **When** the operator looks at the page, **Then** they see one work lane and the session lane, and no pull-request or branch lane exists in the DOM at all — not empty, not collapsed, not hidden.
2. **Given** a work item, **When** its row renders, **Then** the correlation badges show only the correlations that can still exist, and no slot is a permanent placeholder.
3. **Given** the settings screen, **When** the operator edits a project, **Then** there is no repository field and no checkout-path field, and the form does not ask for a GitHub connection.
4. **Given** the settings screen, **When** the operator opens connections, **Then** only ticket-tracker connections can be added, and no screen offers a GitHub token or names a GitHub permission.
5. **Given** a headline count, **When** the operator reads it, **Then** every number it reports is derived from tickets, sessions, notes or drift — nothing counts a row that no longer exists.

---

### User Story 2 - Drift still works, over the two sources that are left (Priority: P2)

The operator's tickets and their agents still disagree, and the application still says so: a ticket nobody moved out of Todo while an agent works on it, a ticket that has sat In Progress for days with nothing running, an agent that has been going for hours while its ticket never moved. Findings that used to come from pull requests simply stop being raised.

**Why this priority**: This is what is left of the reason the product exists. If it does not survive the removal cleanly — in particular if a dismissed finding comes back — the removal has done damage the operator will notice before they notice the missing lanes.

**Independent Test**: Run the correlation engine against ticket-and-session fixtures with no network and no shell, and assert the exact finding set, including the fixtures that must produce none.

**Acceptance Scenarios**:

1. **Given** a ticket in a backlog status with a live agent session, **When** correlation runs, **Then** D2 is raised naming the session as the work that has started.
2. **Given** a ticket in progress with no session and no activity past the lane threshold, **When** correlation runs, **Then** D3 is raised, and its wording claims only what is still knowable — nothing about branches or pull requests.
3. **Given** an agent running past the threshold on a ticket that has not moved, **When** correlation runs, **Then** D7 is raised.
4. **Given** a finding that the operator dismissed before the upgrade, **When** the application starts after it, **Then** that dismissal is still in force and the finding does not reappear.
5. **Given** any fixture at all, **When** correlation runs, **Then** no finding is produced carrying a retired rule identifier.
6. **Given** correlation runs twice over unchanged inputs, **When** the results are compared, **Then** they are identical, including identifiers — as before.

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
- **FR-103**: Poll interval configuration MUST cover the one remaining provider. Lane threshold configuration MUST cover the ticket lane and the agent-session threshold that drift rule D7 depends on — D7 currently borrows the pull-request threshold, and MUST NOT be left reading a setting that no longer describes anything.

### What must still be true

- **FR-104**: All four severity bands MUST remain reachable from the sources that remain, and this MUST be asserted by a test over a fixture rather than argued.
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
- **FR-114**: Retired drift rule identifiers MUST NOT be reused for any future rule, because a dismissal is keyed on the rule identifier and reuse would resurrect a dismissed finding under a new meaning.

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
| FR-035 (D1, D4, D5, D6, D8, D9) | **Retired** — each needs a pull request or a workspace. Identifiers burned by FR-114. |
| FR-035 (D2, D3, D7) | **Amended** — narrowed to the evidence that remains. Identifiers kept. |
| FR-041 | **Amended** by FR-115 — a session associates with a work item and a project, not a workspace. |
| FR-047 | **Amended** — sessions stand beside tickets; there are no PRs to stand beside. |
| FR-049 | **Amended** — notes attach to a ticket or a session going forward. Existing notes on other subjects are kept (FR-117). |
| FR-057 | **Unchanged and now trivially stronger** — read-only against providers, of which there is one. |
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
| **DriftFinding** | Rule union narrows to D2, D3, D7. |
| **OutboxAction** | Producible kinds narrow to `transition-ticket` and `investigate`. Stored rows of retired kinds still read. |
| **Settings** | `pollIntervalSec` and `laneThresholdHours` reshape (FR-103). |
| **Note** | Unchanged in shape. Gains permanently-orphaned instances. |

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The board renders one work lane and the session lane, and a full-text search of the rendered DOM for "pull request", "branch", "check", "repository" and "checkout" returns nothing.
- **SC-002**: The egress audit passes with exactly one provider host allowed, and the first-run download allowance still named separately.
- **SC-003**: A search of the shipped tree finds no process spawn and no code-host client.
- **SC-004**: An `authored.db` written by 0.3.0 upgrades with every row preserved, verified by count and content for all six tables.
- **SC-005**: A finding dismissed before the upgrade is still dismissed after it.
- **SC-006**: All four severity bands appear on a single seeded board, asserted from a fixture whose timestamps are relative to the run — which also returns `greyscale.spec.ts` to green.
- **SC-007**: Correlation over unchanged fixtures is byte-identical across two runs, including finding identifiers.
- **SC-008**: `npm run verify` is green, and the end-to-end suite is green **including** the three greyscale tests that fail on `main` today.
- **SC-009**: Every removed line is removed rather than commented out or guarded: no dead module, no unreferenced export, no `if (false)`.
- **SC-010**: The operator can complete the quickstart in [quickstart.md](./quickstart.md) against a real Jira project with no GitHub credential present anywhere on the machine.

---

## Assumptions

1. **The ticket tracker stays.** This removal is about the code host and local git only. Jira remains reachable and remains the source of tickets.
2. **The agent surface stays and matters more, not less.** With one provider left, agent sessions are half of what the board correlates.
3. **No operator is relying on the removed lanes today.** The application is used on one machine by one person, who asked for the removal. If that changes, the git history holds the implementation.
4. **`mirror.db` may be dropped without ceremony.** It is disposable by construction and rebuilt from the provider. Only `authored.db` needs care.
5. **A downgrade is not supported.** Schema versions move forward. A 0.3.0 binary meeting a post-removal database must refuse to start rather than half-read it.
