---

description: "Task breakdown for Ground Control v1"
---

# Tasks: Ground Control v1

**Input**: Design documents from `/specs/001-ground-control-v1/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Included and non-negotiable. Constitution XVIII makes correlation tests
a merge gate, and every drift rule needs a firing test *and* a declining test.

## Organization — milestones, not story order

Phases follow the four milestones from [research R10](./research.md#r10--build-sequence),
because v1 is sequenced **headless-first**: the correlation engine is both the
differentiator and the only place a subtle bug produces confident wrong output,
so it is proven before the expensive shell is built.

Story labels still ride on every task that serves one, so traceability to
`spec.md` is intact. **What that costs, stated plainly**: no user story is fully
demonstrable until M4, on a product whose value is visual. Two mitigations are
built into the plan rather than hoped for — `packages/cli` makes US1 and US2
demonstrable at M2, and the MCP inspector makes US3, US4, and US5 demonstrable at
M3, both with no UI in existence.

| Milestone | Delivers | Stories it makes verifiable |
|---|---|---|
| M1 Skeleton | two databases, migrations, registry, keychain | — (foundation) |
| M2 The engine | providers, correlation, drift, freshness | US1, US2, US6 — via the CLI |
| M3 Agent surface | notes, sessions, outbox, MCP | US3, US4, US5 — via the MCP inspector |
| M4 The shell | Electron, React, the board, packaging | all six, as specified |

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different files, no dependency on an incomplete task
- **[Story]**: the user story served (US1–US6). Infrastructure tasks carry none.
- Every task names its file path.

## Path conventions

npm workspaces monorepo per [plan.md](./plan.md#source-code-repository-root).
`packages/core` is framework-free and must never import `electron`, `react`, or
the DOM — enforced by lint rule T009, not by discipline.

---

## Phase 1: Setup

**Purpose**: The monorepo and the guardrails, before any behaviour.

- [x] T001 Initialize npm workspaces monorepo with root `package.json` declaring `packages/*`
- [x] T002 [P] Create `packages/core/package.json` with zero Electron and zero React dependencies
- [x] T003 [P] Create `packages/desktop/package.json` with Electron and React 19
- [x] T004 [P] Create `packages/mcp/package.json` with `@modelcontextprotocol/sdk`
- [x] T005 [P] Create `packages/launcher/package.json` with near-zero dependencies (it installs before Electron exists)
- [x] T006 [P] Create `packages/cli/package.json` depending only on `core`
- [x] T007 Configure TypeScript strict ESM in root `tsconfig.base.json` and per-package `tsconfig.json` with project references
- [x] T008 [P] Configure ESLint and Prettier in `eslint.config.js` and `.prettierrc`
- [x] T009 Add the boundary lint rule to `eslint.config.js`: `packages/core/**` may not import `electron`, `react`, `react-dom`, or DOM libs — **this rule is what makes XVIII testable**
- [x] T010 [P] Add the adapter boundary lint rule: adapter modules may import `core/registry` but never `core/providers`, `core/store`, `core/correlation`, or `core/drift` (gate XII)
- [x] T011 [P] Configure Vitest workspace in `vitest.workspace.ts` with per-package projects
- [x] T012 Configure CI in `.github/workflows/ci.yml` running typecheck, lint, and tests on **Windows, macOS, and Linux** — Windows first in the matrix (XVII)

---

## Phase 2: M1 — Skeleton (Foundational)

**Purpose**: Storage, identity, and the service contract. **Blocks everything.**

**⚠️ CRITICAL**: No milestone work can begin until this phase is complete.

### Domain and natural keys

- [x] T013 Implement natural-key construction in `packages/core/src/domain/keys.ts` for all seven subject kinds per [data-model.md](./data-model.md#natural-keys)
- [x] T014 Implement `canonicalRemote` normalization in `packages/core/src/domain/keys.ts` — strip scheme, credentials, `www.`, trailing `.git`; lowercase host, preserve path case
- [x] T015 [P] Unit test key construction in `packages/core/test/domain/keys.test.ts` — assert SSH and HTTPS remotes for the same repo produce an identical key, since a note attached from one checkout must be visible from the other
- [x] T016 [P] Define entity types in `packages/core/src/domain/types.ts` for every mirrored, authored, and derived entity

### The two stores

- [x] T017 Implement `mirror.db` connection and WAL setup in `packages/core/src/store/mirror/db.ts`
- [x] T018 Implement `authored.db` connection and WAL setup in `packages/core/src/store/authored/db.ts`
- [x] T019 Implement the forward-only migration runner in `packages/core/src/store/migrate.ts` with an independent version table per database
- [x] T020 [P] Write mirror schema migration 001 in `packages/core/src/store/mirror/migrations/001_init.sql` — connections, freshness, tickets, ticket_activity, pulls, checks, branch_refs, comparisons, local_workspaces
- [x] T021 [P] Write authored schema migration 001 in `packages/core/src/store/authored/migrations/001_init.sql` — projects, notes, sessions, outbox_actions, finding_dismissals, settings
- [x] T022 Add the cross-file constraint test in `packages/core/test/store/separation.test.ts` — assert no foreign key or join in either schema references the other database

### The registry

- [x] T023 Define `Operation`, `Ctx`, and the registry container in `packages/core/src/registry/types.ts` with an **explicit, non-defaulted** `exposure` field
- [x] T024 Implement the `Envelope<T>` schema in `packages/core/src/registry/envelope.ts` with the four-state freshness computation — `fresh` / `stale` / `failed` / `never`
- [x] T025 [P] Implement the error taxonomy in `packages/core/src/registry/errors.ts` including `keychain_unavailable` as its own code, per [contracts/operations.md](./contracts/operations.md#errors)
- [x] T026 Implement registry registration and dispatch in `packages/core/src/registry/index.ts`
- [x] T027 Write the **adapter conformance test** in `packages/core/test/registry/conformance.test.ts` — assert every entry is present on every surface its exposure allows. Must pass with zero operations registered, or it is not a gate

### Credentials and settings

- [x] T028 Implement the keychain seam in `packages/core/src/auth/keychain.ts` over `@napi-rs/keyring` `Entry`
- [x] T029 Implement `keychain_unavailable` handling in `packages/core/src/auth/keychain.ts` — report and refuse; **no environment-variable fallback** (FR-006)
- [x] T030 [P] Write the keychain round-trip check in `packages/core/test/auth/keychain.test.ts`, verified on Windows Credential Manager first
- [x] T031 Implement `settings.get` and `settings.update` in `packages/core/src/services/settings.ts` with interval and threshold validation
- [x] T032 Implement `app.status` in `packages/core/src/services/app.ts` returning version, platform, database versions, and **runtime ABI** (the packaging failure needs a place to surface)

### The XIII proof

- [x] T033 Write the mirror-rebuild test in `packages/core/test/store/mirror-rebuild.test.ts` — seed a note, delete `mirror.db`, relaunch, assert the note survives with content intact (SC-007)
- [x] T034 Write the credential-leak test in `packages/core/test/store/no-secrets.test.ts` — assert no column in either database holds a value present in the keychain (SC-011)
- [x] T035 Write the authored-migration safety harness in `packages/core/test/store/authored-migration.test.ts` — seed prior schema, migrate, assert zero row loss. **Every future authored migration adds a case here**

**Checkpoint M1**: Two separate database files, migrations run, keychain round-trips on Windows, the registry conformance gate is green, and deleting the mirror provably preserves authored data.

---

## Phase 3: M2 — The engine

**Goal**: Correlation, drift, severity, staleness, and freshness — proven with **Electron uninstalled**.

**Independent Test**: `npm run test -w packages/core` passes with no network, no display, and Electron unresolvable; `npx grndctrl-cli board --fixtures …` prints the board as text.

### Provider seam and fixtures

- [x] T036 Define the provider seam in `packages/core/src/providers/seam.ts` — **read-only by type**: no `transitionIssue`, no `createComment`, no `merge` exists to call (XVI)
- [x] T037 [P] Build the fixture recorder in `packages/core/test/fixtures/record.ts` — capture real payloads, scrub identifiers and titles
- [x] T038 [P] [US1] Record Jira fixtures in `fixtures/jira/` — recorded from a live connection by `scripts/record-fixtures.ts` and replayed through the real provider by `packages/core/test/providers/replay.test.ts`. **Gitignored by decision**: scrubbed payloads from a real client's tracker do not belong in a published tree, so CI skips these and the protection is local to a machine that has recorded its own
- [x] T039 [P] [US1] Record GitHub fixtures in `fixtures/github/` — recorded and replayed the same way. **Known gap, stated rather than implied**: the recorded repository has zero open pull requests, so the recording exercises branches and *not* PRs — `reviewDecision` normalisation, review threads and check runs remain covered only by hand-written payloads. Re-record against a repository with open PRs to close it
- [x] T040 [P] [US1] Record git fixtures in `fixtures/git/` — `packages/core/test/fixtures/record-git.ts` wraps the `GitRunner` seam the way `record.ts` wraps `fetch`, and `replay.test.ts` runs the real parser against recorded porcelain. Scrubs checkout paths **and the remote**, longest-match first, since a remote names an organisation directly. Gitignored like the others. The CRLF/spaces/non-ASCII cases this task names stay covered by `git-windows.test.ts` (T056); what the recording adds is the porcelain shapes nobody thought to hand-write

### Jira provider

- [x] T041 [US1] Implement Jira search in `packages/core/src/providers/jira/search.ts` against `POST /rest/api/3/search/jql` with **`nextPageToken` pagination and no `total`** ([R2](./research.md#r2--jira-acquisition--changes-the-design))
- [x] T042 [US1] Implement bulk changelog fetch in `packages/core/src/providers/jira/changelog.ts` against `POST /rest/api/3/changelog/bulkfetch`, batched over the keys from each search page
- [x] T043 [US1] Implement status-category mapping with per-project overrides in `packages/core/src/providers/jira/status.ts` — **rules read the category, never the name**, so "Done" spelled differently does not break D1
- [x] T044 [US1] Implement `currentUser()` viewer resolution in `packages/core/src/providers/jira/viewer.ts` (FR-033)
- [x] T045 [P] [US1] Test Jira paging and changelog merge in `packages/core/test/providers/jira.test.ts` against fixtures, asserting no dependence on `expand=changelog`

### GitHub provider

- [x] T046 [US1] Implement the per-repo GraphQL document in `packages/core/src/providers/github/query.ts` — PRs, `reviewThreads { isResolved, isOutdated }`, `statusCheckRollup`, requested reviewers
- [x] T047 [US1] Implement **aliased multi-branch comparison** in `packages/core/src/providers/github/compare.ts` — several `Ref.compare` selections in one document, not one request per branch ([R3](./research.md#r3--github-acquisition--changes-the-design))
- [x] T048 [US1] Implement comparison skipping in `packages/core/src/providers/github/compare.ts` — skip while a branch head SHA is unchanged since the last success
- [x] T049 [US1] Implement rate-limit budget tracking and backoff in `packages/core/src/providers/github/limits.ts`, surfacing remaining budget (FR-015)
- [x] T050 [US1] Implement the connection test in `packages/core/src/providers/github/probe.ts` with a **separate compare probe** — a token can authenticate and still lack `repo` scope for ahead/behind
- [x] T051 [P] [US1] Test GitHub parsing and comparison aliasing in `packages/core/test/providers/github.test.ts`, asserting `aheadBy`/`behindBy` stay **null, never zero**, for an unpushed branch

### Local git provider

- [x] T052 [US1] Implement the git spawn module in `packages/core/src/providers/git/exec.ts` — argument arrays only, `-C <path>`, never a shell string
- [x] T053 [US1] Implement the **subcommand allow-list** in `packages/core/src/providers/git/allowlist.ts` — `status`, `rev-list`, `rev-parse`, `worktree`, `for-each-ref`, `remote get-url`. Nothing else is reachable
- [x] T054 [US1] Implement local state reads in `packages/core/src/providers/git/read.ts` — dirty state, unpushed count, worktree list, branch heads
- [x] T055 [P] [US1] Test the allow-list in `packages/core/test/providers/git-allowlist.test.ts` — assert `fetch`, `pull`, `push`, and `remote update` are unreachable and that adding one fails (FR-017)
- [x] T056 [P] [US1] Test CRLF, spaces, non-ASCII, and cross-drive worktrees in `packages/core/test/providers/git-windows.test.ts` (XVII, FR-087)

### Correlation — pure functions

- [x] T057 [US1] Implement the join in `packages/core/src/correlation/join.ts` — ticket ↔ workspace ↔ PR ↔ commits ↔ CI, keyed on the ticket where one exists, else the workspace
- [x] T058 [US1] Implement key matching in `packages/core/src/correlation/match.ts` — branch name, then PR title, then PR body, in that precedence (FR-021)
- [x] T059 [US1] Implement fan-out handling in `packages/core/src/correlation/join.ts` — one ticket with three PRs is **one** work item (FR-020)
- [x] T060 [US1] Implement `lastRealActivityAt` in `packages/core/src/correlation/activity.ts` with the FR-026 inclusion list and the FR-027 exclusion list — bot comments, label changes, automation touches, unchanged CI re-runs
- [x] T061 [P] [US1] Implement the five-band staleness gauge in `packages/core/src/correlation/staleness.ts` (FR-028)
- [x] T062 [US1] Implement severity in `packages/core/src/correlation/severity.ts` — the max over the six contributions in the FR-029 table, **threshold-relative**, kept distinct from the absolute staleness bands
- [x] T063 [US1] Implement ball-in-court in `packages/core/src/correlation/ball.ts`, evaluated in FR-032's stated order so the outcome is deterministic when several conditions hold
- [x] T064 [US1] Implement partial resolution in `packages/core/src/correlation/join.ts` — a work item whose ticket failed to fetch still renders its branches, PRs, and notes, marked `partial` (XV)
- [x] T065 [P] [US1] Test severity as a table in `packages/core/test/correlation/severity.test.ts` — one case per contribution, plus the max-of-several case
- [x] T066 [P] [US1] Test ball-in-court in `packages/core/test/correlation/ball.test.ts` including the ordering cases
- [x] T067 [P] [US1] Test fan-out, unlinked work, and unknown keys in `packages/core/test/correlation/join.test.ts`

### Drift rules

- [x] T068 [US2] Implement rules D1–D9 in `packages/core/src/drift/rules.ts` per the FR-035 table, each returning evidence from both sides with timestamps
- [x] T069 [US2] Implement stable finding identity in `packages/core/src/drift/id.ts` as `drift:<rule>:<subjectKey>` (FR-039) — the reason dismissals survive restarts
- [x] T070 [US2] Implement evidence hashing and dismissal expiry in `packages/core/src/drift/dismiss.ts` — a dismissal expires when evidence changes, not when a sync merely runs (FR-038)
- [x] T071 [US2] Write **eighteen** drift tests in `packages/core/test/drift/` — for each of D1–D9, one that fires it and one that correctly declines. A rule with only a firing test can fire on everything and still pass (XVIII, SC-003)
- [x] T072 [P] [US2] Test auto-clearing in `packages/core/test/drift/clearing.test.ts` — a finding disappears when the underlying evidence resolves, with no user action

### Freshness and sync

- [x] T073 [US6] Implement per-connection-per-resource-kind freshness records in `packages/core/src/runtime/freshness.ts` (FR-011)
- [x] T074 [US6] Implement the poll scheduler in `packages/core/src/runtime/scheduler.ts` — 60s GitHub, 5min Jira, configurable, with per-connection backoff
- [x] T075 [US6] Implement per-connection sync isolation in `packages/core/src/services/sync.ts` — one connection failing must not touch another's state (XV)
- [x] T076 [US6] Implement the Jira changelog degradation path in `packages/core/src/services/sync.ts` — if bulk changelog fails, the lane reads **"activity unknown"** and says so, rather than silently falling back to `updated`
- [x] T077 [P] [US6] Test per-provider degradation in `packages/core/test/services/degradation.test.ts` — kill each provider in turn, assert other lanes stay populated (SC-005)
- [x] T078 [P] [US6] Test the three freshness states in `packages/core/test/runtime/freshness.test.ts` — never / stale / failed stay distinct (FR-013)

### Registry operations for the board

- [x] T079 [US1] Register `work.list`, `work.get`, and `board.summary` in `packages/core/src/registry/ops/work.ts`, all returning `Envelope<T>`
- [x] T080 [US2] Register `drift.list`, `drift.dismiss`, `drift.undismiss` in `packages/core/src/registry/ops/drift.ts`
- [x] T081 [US1] Register `connections.*` and `projects.*` in `packages/core/src/registry/ops/config.ts`, with `connections.list` asserted never to return a secret
- [x] T082 [US6] Register `sync.now` and `sync.status` in `packages/core/src/registry/ops/sync.ts`
- [x] T083 [US1] Implement `links.resolve` in `packages/core/src/registry/ops/links.ts` — **the only place a URL is produced**, scheme-checked to `https`, falling back to the repo page for an unpushed branch (FR-076, FR-077)
- [x] T084 [P] [US1] Test `links.resolve` in `packages/core/test/registry/links.test.ts` — assert `file:`, `javascript:`, and custom schemes from a hostile stubbed provider are refused

### Determinism and the text board

- [x] T085 [US1] Write the determinism test in `packages/core/test/correlation/determinism.test.ts` — ten consecutive runs produce byte-identical output including finding identifiers (SC-004)
- [x] T086 [US1] Implement the text board in `packages/cli/src/board.ts` — lanes with severity, staleness, and ball-in-court
- [x] T087 [P] [US1] Implement `providers:probe` in `packages/cli/src/probe.ts` — prints "fetched N (no server-side total)" for Jira and runs the GitHub compare probe

**Checkpoint M2**: The fixture suite is green with Electron uninstalled. Every drift rule has both tests. Ten runs are byte-identical. `grndctrl-cli board` prints a correlated board — US1, US2, and US6 are demonstrable with no UI in existence.

---

## Phase 4: M3 — The agent surface

**Goal**: Notes, sessions, and the outbox, reachable by an agent with **no UI in existence**.

**Independent Test**: MCP inspector against `npx grndctrl-mcp` — read the board, write a note, run a session to silent and back, claim and complete an action queued before the agent existed.

### Notes

- [x] T088 [US4] Implement the notes store in `packages/core/src/store/authored/notes.ts`, keyed on **natural key only** (FR-050)
- [x] T089 [US4] Implement revision-based conflict rejection in `packages/core/src/services/notes.ts` — a stale write returns `conflict` carrying the current row; **never merge, never last-write-wins** (FR-055)
- [x] T090 [US4] Implement orphan handling in `packages/core/src/services/notes.ts` — a note whose subject vanished is returned with `orphaned: true`, never deleted (FR-056)
- [x] T091 [US4] Register `notes.list`, `notes.counts`, `notes.questions`, `notes.create`, `notes.update`, `notes.delete` in `packages/core/src/registry/ops/notes.ts`, stamping `authorKind` **from the adapter, never the payload**
- [x] T092 [US4] Wire `question-for-human` notes into Attention and ball-in-court in `packages/core/src/correlation/ball.ts` (FR-053)
- [x] T093 [P] [US4] Test note durability in `packages/core/test/services/notes-durability.test.ts` — every type on every subject type survives a full mirror rebuild (SC-007)
- [x] T094 [P] [US4] Test conflict rejection and re-attachment in `packages/core/test/services/notes-conflict.test.ts` — including a branch deleted and recreated with the same name

### Sessions

- [x] T095 [US3] Implement the sessions store in `packages/core/src/store/authored/sessions.ts`
- [x] T096 [US3] Implement **read-time** silence derivation in `packages/core/src/services/sessions.ts` — `now - lastHeartbeatAt > 3 × interval`, never stored, so a restart re-evaluates rather than trusting a stale flag (FR-046)
- [x] T097 [US3] Implement resumption on duplicate start and future-timestamp clamping in `packages/core/src/services/sessions.ts` (FR-044, FR-045)
- [x] T098 [US3] Implement the heartbeat/activity split in `packages/core/src/services/sessions.ts` — a heartbeat does **not** advance `lastRealActivityAt`, so a zombie heartbeat cannot make a dead session look busy
- [x] T099 [US3] Register `sessions.start`, `heartbeat`, `activity`, `end`, `list` in `packages/core/src/registry/ops/sessions.ts`
- [x] T100 [P] [US3] Test the session state machine in `packages/core/test/services/sessions.test.ts` — running → silent → running with no duplicate row, and survival across restart

### The outbox

- [x] T101 [US5] Implement the outbox store with an append-only `history` column in `packages/core/src/store/authored/outbox.ts`
- [x] T102 [US5] Implement single-use confirmation tokens in `packages/core/src/services/outbox.ts` — bound to exact subject, kind, and payload, short-lived
- [x] T103 [US5] Register `outbox.mintConfirmation` with exposure **`ui-only`** in `packages/core/src/registry/ops/outbox.ts` — the one declared asymmetry in the registry
- [x] T104 [US5] Register `outbox.enqueue` requiring a valid token, rejecting expired and reused ones (FR-059)
- [x] T105 [US5] Implement **atomic** claim in `packages/core/src/services/outbox.ts` — a conditional update, so a second claimant changes zero rows and gets `conflict` (FR-062)
- [x] T106 [US5] Implement claim expiry returning an action to `pending` with the attempt recorded in `history`, never silently (FR-063)
- [x] T107 [US5] Register `outbox.pending`, `claim`, `complete`, `fail`, `cancel`, `list` in `packages/core/src/registry/ops/outbox.ts`
- [x] T108 [US5] Write the **no-auto-dispatch test** in `packages/core/test/services/no-auto-dispatch.test.ts` — assert no module under `services/sync`, `correlation`, or `drift` can reach `mintConfirmation` (FR-060, XVI)
- [x] T109 [US5] Write the durability test in `packages/core/test/services/outbox-durability.test.ts` — confirm with no agent connected, restart, then claim and complete (SC-008)
- [x] T110 [P] [US5] Test double-claim and expiry paths in `packages/core/test/services/outbox-claim.test.ts`

### Transport

- [x] T111 Implement the loopback HTTP adapter in `packages/core/src/adapters/http.ts` — `127.0.0.1`, ephemeral port, bearer token, registry dispatch only
- [x] T112 Implement the handshake file in `packages/core/src/runtime/handshake.ts` — `{ port, token, pid, version }`, `0600` on POSIX, user-only DACL on Windows, deleted on exit
- [x] T113 [P] Test handshake file permissions on Windows and POSIX in `packages/core/test/runtime/handshake.test.ts`
- [x] T114 Implement the MCP server in `packages/mcp/src/server.ts` — reads the handshake, returns `app_not_running` cleanly when absent, and **does not launch the app**
- [x] T115 [US3] Implement session tools in `packages/mcp/src/tools/sessions.ts` — `grndctrl_start_session`, `_heartbeat`, `_report_activity`, `_end_session`
- [x] T116 [US4] Implement note tools in `packages/mcp/src/tools/notes.ts` — `grndctrl_list_notes`, `_add_note`, `_update_note`
- [x] T117 [US1] Implement read tools in `packages/mcp/src/tools/read.ts` — `grndctrl_get_board`, `_get_work_item`, `_get_drift`, `_get_freshness`, each carrying the freshness envelope with **absolute timestamps**, never relative strings
- [x] T118 [US5] Implement outbox tools in `packages/mcp/src/tools/outbox.ts` — list, claim, complete, fail. **`grndctrl_enqueue_action` must not exist**
- [x] T119 [US5] Implement `resources.subscribe` and `notifications/resources/updated` for `grndctrl://outbox/pending` in `packages/mcp/src/resources.ts` — an accelerator, never the contract (FR-065)
- [x] T120 Write the MCP conformance test in `packages/mcp/test/conformance.test.ts` — every registry entry with `all` exposure has a tool, and `mintConfirmation` has none
- [x] T121 [P] Test the envelope on every MCP read in `packages/mcp/test/freshness.test.ts` — assert `never` is distinguishable from `stale` (XIV)

**Checkpoint M3**: An agent starts a session, writes a note that moves ball-in-court to the operator, and claims an action confirmed before it connected — all with no UI. US3, US4, and US5 are demonstrable.

---

## Phase 5: M4 — The shell

**Goal**: The Electron application and the board as designed.

**Independent Test**: The golden path in [quickstart.md](./quickstart.md#m4--the-shell), run on Windows first.

### Main process and the bridge

- [x] T122 Implement app lifecycle and window creation in `packages/desktop/src/main/index.ts` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`
- [x] T123 Host core and the HTTP adapter from the main process in `packages/desktop/src/main/service.ts`, instantiated so a later move to `utilityProcess.fork` touches only this file
- [x] T124 Implement the IPC adapter in `packages/desktop/src/main/ipc.ts` — one channel per operation, **payload revalidated inside every handler** with the operation's own schema (Principle II)
- [x] T125 Implement the **hand-enumerated** contextBridge surface in `packages/desktop/src/preload/index.ts` — one method per operation, and **no generic `invoke`**
- [x] T126 Implement push events in `packages/desktop/src/main/push.ts` — `sync:progress`, `freshness:tick`, `outbox:changed`
- [x] T127 Implement `shell.openExternal` gated on `links.resolve` output in `packages/desktop/src/main/links.ts` — a URL is never opened without passing through core's scheme check
- [x] T128 [P] Ship a CSP and local-file-only loading in `packages/desktop/src/main/security.ts`

### Renderer foundation

- [x] T129 [P] Port design tokens to `packages/desktop/src/renderer/styles/tokens.css` from `resources/design/Ground Control Design System.dc.html`, including the real dark palette
- [x] T130 [P] Implement theme selection in `packages/desktop/src/renderer/theme.tsx` — system default plus explicit override (FR-078)
- [x] T131 [P] Implement comfortable and compact density in `packages/desktop/src/renderer/theme.tsx` — 34px and 28px rows (FR-079)
- [x] T132 Configure TanStack Query over IPC fetchers in `packages/desktop/src/renderer/query.ts`, rendering the **envelope's `lastSuccessAt`**, not the cache's `dataUpdatedAt` — during an outage the two diverge and only one is true
- [x] T133 Implement the status mark in `packages/desktop/src/renderer/components/StatusMark.tsx` — shape **and** label, not colour alone (FR-074)
- [x] T134 Implement the 34px row primitive in `packages/desktop/src/renderer/components/Row.tsx` with its fixed slots
- [x] T135 Implement the staleness gauge in `packages/desktop/src/renderer/components/StaleBar.tsx` — five bands from last **real** activity
- [x] T136 Implement project chips with neutral fallback beyond the palette in `packages/desktop/src/renderer/components/ProjectChip.tsx` (FR-080)

### The board

- [x] T137 [US1] Implement the single-page layout in `packages/desktop/src/renderer/App.tsx` — tiles, Attention, three lanes, sessions, ball in court
- [x] T138 [US1] Implement project filtering as a filter, not navigation, in `packages/desktop/src/renderer/filter.ts`, rendering the project header when narrowed to one (FR-070)
- [x] T139 [US1] Implement the four stat tiles in `packages/desktop/src/renderer/components/StatTiles.tsx`, with the operator's-court tile acting as a toggle (FR-073)
- [x] T140 [US1] Implement the ticket, PR, and branch lanes in `packages/desktop/src/renderer/lanes/`, each with its own count, threshold, and empty state
- [x] T141 [US1] Give each lane its own query and its own error boundary in `packages/desktop/src/renderer/lanes/LaneBoundary.tsx` — one failing provider must not blank the others (XV)
- [x] T142 [US3] Implement the agent sessions lane in `packages/desktop/src/renderer/lanes/Sessions.tsx` with live, silent, and needs-you states
- [x] T143 [US1] Implement the ball-in-court panel in `packages/desktop/src/renderer/components/BallInCourt.tsx` with you/them/agent glyphs
- [x] T144 [US2] Implement the Attention region in `packages/desktop/src/renderer/components/Attention.tsx` — drift strips and question nudges with age and action
- [x] T145 [US6] Implement per-lane degraded states in `packages/desktop/src/renderer/components/LaneStatus.tsx` — **stale, failed, and never-synced visibly distinct**, with the failure reason and retry time (FR-013, FR-015)
- [x] T146 [US1] Implement universal row launching in `packages/desktop/src/renderer/launch.ts` — every row type opens its provider page and the app does not navigate (FR-075)
- [x] T147 [US1] Implement the empty state in `packages/desktop/src/renderer/components/EmptyState.tsx` — explains what a project is; not an error, not a blank page

### Notes modal and configuration

- [x] T148 [US4] Build the modal primitive in `packages/desktop/src/renderer/components/Modal.tsx` from `--raised` tokens — **the design system has no dialog primitive**, so this is new
- [x] T149 [US4] Implement the notes modal in `packages/desktop/src/renderer/components/NotesModal.tsx` — read, add, edit, delete, with conflict surfacing on a stale revision
- [x] T150 [US4] Add note count badges to the row in `packages/desktop/src/renderer/components/Row.tsx` — **decision 18 settled: the reserved trailing slot, displacing nothing.** The row became a `<div>` holding a covering button, because a `<button>` inside a `<button>` is invalid and the badge is a second action
- [x] T151 [US5] Implement the drift action confirmation flow in `packages/desktop/src/renderer/components/ConfirmAction.tsx` — mints the token, enqueues, then shows the action's state
- [x] T152 [US5] Implement outbox state display in `packages/desktop/src/renderer/components/ActionState.tsx` — when nothing is listening, **say so** rather than implying delivery (FR-066)
- [x] T153 Implement connection and project configuration screens in `packages/desktop/src/renderer/settings/`, with the GitHub compare probe reported separately from authentication
- [x] T154 Persist window geometry, appearance, density, and filters in `packages/desktop/src/main/persistence.ts` (FR-082)
- [x] T176 Add an **always-on-top** toggle to the titlebar in `packages/desktop/src/renderer/Titlebar.tsx`, persisted with the rest of the window state — **operator request, 2026-08-15, not in the spec.** A command station is a thing you glance at while working in something else, and a window that disappears behind the editor is one you stop glancing at. Pairs with T154: it is window state, so it belongs to the same `Settings` field and the same persistence path, and the toggle needs `BrowserWindow.setAlwaysOnTop` in main — the renderer cannot reach it, so it needs a route through the bridge like any other main-process affordance

### End-to-end

- [x] T155 Write the golden-path Playwright test in `packages/desktop/test/e2e/golden-path.spec.ts` — configure, render, click each row type, open the modal, confirm a dispatch
- [x] T156 [P] Write the isolation test in `packages/desktop/test/e2e/isolation.spec.ts` — `window.require`, `process`, and `module` undefined; `window.grndctrl` has exactly the enumerated methods and no `invoke`
- [x] T157 [P] [US6] Write the degradation e2e in `packages/desktop/test/e2e/degradation.spec.ts` — revoke a token mid-session, assert other lanes stay interactive
- [x] T158 [P] Write the greyscale legibility check in `packages/desktop/test/e2e/greyscale.spec.ts` — every severity distinguishable by shape and label alone (SC-015)
- [x] T159 [P] Write the filter performance test in `packages/desktop/test/e2e/perf.spec.ts` — 200 work items across 6 projects, filter under 100ms (SC-013)

**Checkpoint M4**: The golden path passes on Windows. All six user stories are demonstrable as specified.

---

## Phase 6: Packaging

**Purpose**: The riskiest path in the project ([R8](./research.md#r8--packaging-highest-risk-in-the-project)). It fails on a *user's* machine, not in CI.

- [x] T160 Implement the launcher bin in `packages/launcher/bin/grndctrl.js` — resolve runtime, spawn app
- [x] T161 Implement runtime download from GitHub releases with **checksum verification** in `packages/launcher/src/runtime.ts`
- [x] T162 Implement per-machine versioned runtime caching in `packages/launcher/src/cache.ts`
- [x] T163 ~~Configure `@electron/rebuild` and publish `better-sqlite3` prebuilds~~ — **closed as not needed, on evidence.** `packages/desktop/scripts/fetch-native.mjs` fetches an Electron-ABI build from upstream, and `.github/workflows/packaging.yml` proves it works: on Windows, macOS and Linux the app boots from a packed tarball and `app.status` reads both databases, which cannot happen unless the native module loaded. Publishing our own prebuilds would solve a problem no shipped platform has. **Reopen if** a platform/arch upstream does not cover is added (darwin-x64, linux-arm64 and win32-arm64 are untested — nothing ships to them yet)
- [x] T164 Implement the launch-time ABI check in `packages/launcher/src/abi.ts` — fail with a message naming **expected and actual runtime**, not a raw Node error
- [x] T165 Write the ABI guard test in `packages/launcher/test/abi-guard.test.ts` — deliberately mismatch, assert the actionable message
- [x] T166 Verify `npx` from a packed tarball on a **clean machine with a cleared runtime cache** — Windows
- [x] T167 [P] Verify the same on macOS — automated in `.github/workflows/packaging.yml`
- [x] T168 [P] Verify the same on Linux — automated; found that npx could not start at all (SUID sandbox), fixed in `packages/launcher/src/sandbox.ts`

---

## Phase 7: Privacy audits and polish

**Purpose**: The promises that cost the most to break.

- [x] T169 Implement the secret audit script in `scripts/audit-secrets.ts` — search app data, both databases, all logs, and the handshake file for a sentinel token. **Zero hits is the only pass** (SC-011)
- [x] T170 Implement the egress audit in `scripts/audit-egress.ts` — 30 minutes of use reaches only configured provider hosts plus the GitHub releases host on first run (SC-010)
- [x] T171 [P] Assert no telemetry, analytics, crash-reporting, or update-ping dependency in `scripts/audit-deps.ts` (XI)
- [ ] T172 [P] Run the full quickstart validation end to end on all three platforms per [quickstart.md](./quickstart.md)
- [x] T173 [P] Write the README with install, first-run configuration, and the MCP setup snippet
- [x] T174 [P] Document the agent integration in `docs/agents.md` — tools, the polling contract, and why push is not one
- [ ] T175 Update `STATUS.md` and `CHANGELOG.md` at each milestone checkpoint, not at the end

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 Setup** — no dependencies. T009 and T010 (the boundary lint rules) should land before any `core` code, or the boundary they protect is already violated.
- **Phase 2 M1** — depends on Setup. **Blocks everything.**
- **Phase 3 M2** — depends on M1. Provider tracks (Jira T041–T045, GitHub T046–T051, git T052–T056) are independent of one another and can run in parallel.
- **Phase 4 M3** — depends on M2 for correlation output. Notes, sessions, and outbox are independent of one another.
- **Phase 5 M4** — depends on M3 for the registry surface. Renderer foundation (T129–T136) can start once T125 exists.
- **Phase 6 Packaging** — depends on M4. Start T163 (prebuilds) **early**; it has the longest feedback loop.
- **Phase 7 Audits** — depends on a working app, except T171 which can run from day one.

### Critical path

```
T001 → T009 → T013 → T017/T018 → T019 → T023 → T026 → T036
     → T057 → T062 → T068 → T079 → T101 → T111 → T122 → T155
```

### Parallel opportunities

- Setup: T002–T006, T008, T010, T011 all in parallel
- M2: the three provider tracks in parallel; all fixture recording (T037–T040) in parallel
- M2: correlation tests T065–T067 in parallel once their subjects exist
- M3: notes (T088–T094), sessions (T095–T100), and outbox (T101–T110) in parallel
- M4: renderer foundation T129–T136 in parallel; e2e tests T156–T159 in parallel
- Packaging: T167 and T168 in parallel after T166

---

## Implementation Strategy

### Why not MVP-by-story

The template's default is to ship User Story 1 first. This plan deliberately does
not, and the reason is specific rather than stylistic: US1's value is a *rendered
board*, so shipping it first means building the Electron shell before the
correlation engine that fills it — spending the most expensive component on the
least proven one. The engine is simultaneously the differentiator and the only
place a subtle bug produces confident, plausible, wrong output. It is also the
cheapest thing here to test properly.

So the increments are milestones, and each is independently verifiable:

1. **M1** → storage and contract proven. Delete the mirror; notes survive.
2. **M2** → the engine proven. Fixtures green with Electron uninstalled; the CLI
   prints a real board. **US1, US2, US6 demonstrable.**
3. **M3** → the agent surface proven. An agent works the board with no UI.
   **US3, US4, US5 demonstrable.**
4. **M4** → the shell. All six stories as specified.
5. **Packaging + audits** → shippable.

### Where to stop and check

After M2. If correlation is wrong, everything downstream renders wrong
confidently — and that is the failure mode the whole product exists to prevent.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task
- Commit atomically per task or per logical group; each commit builds and passes (Principle IX)
- Update `STATUS.md` at every checkpoint, not at the end
- Three tasks are gates that fail the build rather than reporting a finding: **T027** (adapter conformance, XII), **T071** (eighteen drift tests, XVIII), **T108** (no auto-dispatch, XVI). Treat a failure in any of them as a design problem, not a test to adjust.
