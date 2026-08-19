# Tasks: removing the code host, local git and drift

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Quickstart**: [quickstart.md](./quickstart.md)

---

## Organization — outside in, every commit green

Six milestones, in the order argued in [R7](./research.md#r7--in-what-order-can-this-be-done-so-that-every-commit-is-green). The ordering is the plan's main claim and is not a matter of taste: a removal done inside-out leaves the tree red across a several-thousand-line change that cannot be reviewed or bisected, and puts the only data-losing step in the middle of a tree that does not build.

**Each milestone ends green** — `npm run verify` passes and the application launches — and each is separately verifiable in [quickstart.md](./quickstart.md).

## Format: `[ID] [P?] Description`

- **[P]** — may run in parallel with others marked `[P]` in the same group; different files, no ordering between them.
- Every task names the files it touches.
- **A task that adds an assertion must include making it fail.** For a removal this is not ceremony: an assertion that something is absent passes trivially when the selector is wrong, and a suite full of those is worse than no suite because it reports confidence.

---

## Phase 0: Setup

- **T001** Branch `006-remove-code-host-and-local-git` off `main`. *(done — this spec is on it)*
- **T002** Capture the baseline: `npm run verify` and the full end-to-end suite, recording the three known `greyscale.spec.ts` failures and their reason. Nothing in this change may be blamed on, or hidden behind, a failure that was already there.
- **T003** Take a copy of a real 0.3.0 `authored.db` — or construct one via the seed script plus manual inserts — containing a project of each shape (Jira+repo, Jira only, repo only), notes on all five subject kinds, sessions with and without a workspace key, outbox actions of all four kinds in several states, and dismissals for several of the retiring rules. This is M4's test fixture and it must exist before M4 starts, not during it.

---

## Phase 1: M1 — The board becomes what it will be

Renderer only. Core still fetches everything; nothing renders it.

### Lanes

- **T004** Delete the `PullRequests` and `Branches` components from `packages/desktop/src/renderer/lanes/Lanes.tsx`, with `severityOfPull`, `describePull`, `describeWorkspace` and `comparisonFor`.
- **T005** Remove their `LaneBoundary` wrappers from `App.tsx`. **Keep every remaining boundary** — see [ipc-channels.md](./contracts/ipc-channels.md#what-must-not-be-removed-along-with-the-lanes); this is the gate XV trap.
- **T006** Narrow `Row.tsx`: the correlation badge set loses `pull-request` and `check`, leaving `branch`… which also goes. Decide whether a correlation slot survives at all — with only `agent` left it is a one-badge column, and a column with one always-computable value may be better rendered as part of the court slot. **Look at it running before deciding.**
- **T007** Narrow `sort.ts`: no lane needs the `age` accessor removal or addition, but confirm the ticket lane's sortable set is still right with the lane count changed.

### Attention and the dispatch route

- **T008** Delete `components/Attention.tsx`, `components/ConfirmAction.tsx` and `components/ActionState.tsx` — the last of these existed only to render an action's state inside the confirm dialog. Remove their `LaneBoundary` and the `confirming` state from `App.tsx`.
- **T009** `StatTiles.tsx` — remove the DRIFTING tile. `stalled`, `yourCourt` and `agentsLive` stay; confirm each still counts something that exists rather than assuming it.
- **T010** **Check what the deletion took with it.** `App.tsx` also fed Attention the open `question-for-human` notes from `notes.questions`. That query and that filtering are *not* Attention's — ball-in-court reads the same set (FR-121), and [007](../007-agent-console/spec.md) gives the display a new home. Removing the query along with the component is the mistake this task exists to prevent.

### Panels

- **T011** [P] `BallInCourt.tsx` — the panel accounts for every item; with `them` now reachable only through ticket assignment, check the empty and all-one-bucket renderings still read sensibly.

### Settings

- **T012** [P] `settings/Projects.tsx` — remove the repository field, the checkout-paths field and the GitHub connection selector. The project summary line loses its repository and checkout rows.
- **T013** [P] `settings/Connections.tsx` — one provider kind. Remove the GitHub token flow and every reference to a GitHub permission (this is the screen 0.1.3 already had to correct once).

### Verify M1

- **T014** Update `board.spec.ts`, `golden-path.spec.ts`, `perf.spec.ts` and `degradation.spec.ts` for the lane and Attention change. `golden-path.spec.ts` loses its dispatch steps entirely — steps 6 onward drive a drift finding through the confirm dialog into the outbox. Each absence assertion pairs with a presence assertion in the same query.
- **T015** Launch it and look at it. One work lane plus sessions, three tiles, panels beside. **This is the thin board**, and it is the intended intermediate state — [007](../007-agent-console/tasks.md) fills it. Decide T006 here.

---

## Phase 2: M2 — The adapters stop offering what the board no longer shows

- **T016** `registry/ops/links.ts` + `services/links.ts` — remove the four link targets. A removed target is an explicit error, never a silent fallback to the ticket.
- **T017** `registry/ops/config.ts` — `projects.upsert`/`projects.list` lose four fields; `connections.test` loses `repo`. Add the "a project must name a ticket project" validation, with an error that names the field ([operations.md](./contracts/operations.md#projectsupsert--projectslist)).
- **T018** `registry/ops/sync.ts` + `registry/ops/work.ts` — provider and resource-kind narrowing; `board.summary` loses `drifting`, `pulls` and `branches`.
- **T018a** Delete `registry/ops/drift.ts` and its three operations, and `packages/mcp/src/tools` loses `grndctrl_list_drift`. **The eight outbox operations stay** — see [operations.md](./contracts/operations.md#operations-removed) and *The outbox question* in the spec. Removing them is a separate decision and must not be smuggled in here.
- **T019** [P] `packages/mcp/src/tools/sessions.ts` — remove `workspaceKey`; a caller sending it is rejected, not ignored (FR-115).
- **T020** [P] `packages/mcp/src/tools/read.ts` and `notes.ts` — rewrite the four descriptions per [mcp-tools.md](./contracts/mcp-tools.md#descriptions-that-must-change). The notes description must still say that notes on older subject kinds are readable by key.
- **T021** [P] `packages/cli/src/{probe,board,credential}.ts` — one provider to probe, one lane to print, one credential kind to import.
- **T022** Extend the registry conformance test with the three assertions in [operations.md](./contracts/operations.md#what-the-conformance-test-must-now-assert). **Probe each**: reintroduce a removed target and confirm the test fails.

---

## Phase 3: M3 — The engine narrows

The largest milestone. Behaviour changes here, not just presentation.

### Delete the providers

- **T023** Delete `packages/core/src/providers/github/` (2 files) and `packages/core/src/providers/git/` (3 files). Narrow `providers/index.ts` and `providers/seam.ts` — `CodeProvider` and `LocalGitProvider` go.
- **T024** Delete `packages/core/test/providers/{github,git-read,git-allowlist,git-windows}.test.ts`. Narrow `replay.test.ts` to the one provider that remains, **keeping its guard that an empty fixture directory fails rather than skips** — that guard is the reason the suite cannot rot into a green no-op, and it is easy to lose while deleting two of its three describes.
- **T025** Narrow `test/fixtures/record.ts` and `scripts/record-fixtures.ts`; delete `test/fixtures/record-git.ts`. Delete the local `fixtures/github/` and `fixtures/git/` directories (gitignored, so this is a local cleanup, not a commit).

### Sync and wiring

- **T026** `services/sync.ts` — delete `syncCode` and `syncLocal` and the `LOCAL_CONNECTION_ID` constant. `syncTickets` is untouched. Narrow `SyncTargets` and `SyncReport`.
- **T027** `runtime/providers.ts` — `buildSyncTargets` builds ticket providers only. The credential-handling and the `unavailable` reporting stay exactly as they are.
- **T028** `runtime/scheduler.ts` — one provider kind, one interval. The `'local'` pseudo-kind goes.
- **T029** `services/connections.ts` — one provider kind to test and to remove.

### Correlation

- **T030** `correlation/join.ts` — the largest single edit. Work items are built from tickets alone; the workspace-keyed fallback, the remote→project mapping, check grouping and the dangling-reference output all go. `WorkItem.ticket` stops being nullable (FR-106).
- **T031** Delete `correlation/match.ts` and its test — branch and PR key matching has nothing to match.
- **T032** `correlation/ball.ts` — remove the three pull-request inputs, keep the fixed evaluation order (FR-105). Update `ball.test.ts`, including a case asserting that `them` is still reachable.
- **T033** `correlation/severity.ts` — remove the pull-request and workspace source groups. Update `severity.test.ts`. *(The `inDrift` input goes in T037, with the rest of drift.)*
- **T034** `correlation/join.test.ts` and `determinism.test.ts` — narrow, keeping the determinism guarantee intact (FR-107, SC-007).
- **T035** `test/correlation/builders.ts` — delete the `pullRequest`, `workspace`, `branchRef`, `checkResult` and `comparison` builders. This file feeds most of the core suite, so it is the change that makes the rest of the phase compile.

### Drift

- **T036** Delete `packages/core/src/drift/` entirely — `rules.ts`, `dismiss.ts`, `id.ts`, `index.ts` — and `test/drift/`. Remove `services/board.ts`'s findings arm and the `findings` half of the board envelope.
- **T037** `correlation/severity.ts` — remove the `inDrift` input and its contribution. **Nothing else moves.** The test must show the remaining contributions unchanged for the same inputs (FR-120); a "tidy" rebalance of the other severities while in there would be an undocumented product change.
- **T038** **Write down that the D1–D9 namespace is spent**, in the store module that reads `finding_dismissals` — which is now the only place the identifiers still appear. Dismissal rows are retained by FR-122, so a future rule reusing a number arrives pre-dismissed, and the only defence is a note where somebody would be tempted.
- **T038a** Confirm the bystanders survived: the outbox's eight operations still registered, `notes.questions` still queried, an open question-for-human note still driving ball-in-court to the operator (FR-121). One test each. **This is the milestone's real risk** — not that drift fails to leave, but that it takes a passenger.

---

## Phase 4: M4 — Types and store

Smallest diff, highest risk. **T004's fixture must already exist.**

- **T039** `domain/types.ts` — delete `PullRequest`, `CheckResult`, `BranchRef`, `Comparison`, `LocalWorkspace` and their supporting unions; narrow `Project`, `AgentSession`, `WorkItem`, `Settings`, `ResourceKind`, `ProviderKind`, `ActionKind`.
- **T040** `domain/keys.ts` — delete the removed constructors. **`subjectKindOf` keeps every kind it can parse** ([data-model.md](./data-model.md#entities-removed-entirely)) — a note written before this change carries a key of a removed kind, and a parser that stopped recognising it would turn a retained note into an unreadable one. Update `keys.test.ts` to assert exactly that.
- **T041** `services/settings.ts` — reshape `pollIntervalSec` and `laneThresholdHours`; add `sessions` with the old `pulls` default.
- **T042** Mirror migration **4**, in the order [data-model.md](./data-model.md#migration--mirrordb-version-3--4) sets out: read credential refs first, then drop connection rows, rebuild `connections` with the narrowed CHECK, drop five tables, delete retired freshness rows. The migration returns the refs; it never touches the keychain itself.
- **T043** `store/mirror/repository.ts` — delete the five entities' read/write paths.
- **T044** Authored migration **2**: `projects` 12-step rebuild without the four columns and **without a replacement CHECK** ([R4](./research.md#r4--can-the-authored-store-be-narrowed-without-losing-rows--changes-the-design)); `agent_sessions` drop column; `settings` payload reshape, idempotent (FR-113). `notes`, `outbox_actions` and `finding_dismissals` are not opened.
- **T045** The keychain deletion (FR-112): the caller takes T042's refs and deletes each secret. **Order has its own test** — refs read before rows dropped, or there is nothing left to read.
- **T046** The migration test, against T003's database. Every authored row present after upgrade, by count and by content: the repo-only project still there, every dismissal row still there and untouched (FR-122), every outbox row still in its state. Running it twice is a no-op.
- **T047** **Probe T046**: make the `projects` copy step drop a row and confirm the test fails. Make the keychain deletion run before the ref read and confirm the ordering test fails. An untested migration test is the worst thing in this change.
- **T048** `packages/desktop/src/renderer/types.ts` — narrow the mirrors. If this compiles, the renderer reads nothing that no longer exists.

---

## Phase 5: M5 — Fixtures, tests, and the standing greyscale failure

- **T049** Rebuild `fixtures/scenarios/merged-pr-open-ticket.json` as a ticket-and-session scenario. It needs a new name — it is named for a correlation that can no longer exist. It is referenced by `board.spec.ts`, `golden-path.spec.ts`, `agent-push.spec.ts` and the seed script's default.
- **T050** Rebuild `fixtures/scenarios/every-severity.json` so all four severities come from ticket, session and staleness sources alone — drift is no longer one of them. **This is the FR-104 assertion made concrete**: `critical` from a blocked ticket or 3× staleness, `serious` from a silent agent or 2× staleness, `warning` from three sources, `good` from an item with nothing wrong.
- **T051** **Relative timestamps** (FR-118). Scenario timestamps become offsets resolved when the scenario is loaded — `scripts/seed.mjs` and `test/fixtures/record.ts` both read scenarios and both must resolve them the same way. This is the fix for the three `greyscale.spec.ts` failures that predate this change.
- **T052** **Probe T051**: set the machine clock forward a week — or advance the injected `now` — and confirm the severity scenario still produces all four. The current fixture fails this, which is the whole point.
- **T053** `packages/desktop/test/e2e/large-board.ts` — the 200-item generator loses pull requests, branches, checks and comparisons. `perf.spec.ts`'s floor stays; the board is smaller and must still be fast.
- **T054** `degradation.spec.ts` — rewritten. It demonstrated one provider failing while others rendered; with one provider it must demonstrate the ticket lane failing while the session lane, the panels and the connection notice still render (gate XV, still live).
- **T055** Full end-to-end run. **Green including greyscale** — that is SC-008, and it is the one result that shows this change left the suite better than it found it.

---

## Phase 6: M6 — Documentation, audits, release

- **T056** [P] `scripts/audit-egress.ts` — remove `api.github.com` from the **provider** allow-list. **Keep `github.com` and `objects.githubusercontent.com` in the first-run list, with their comment** ([R6](./research.md#r6--what-does-removing-local-git-buy-besides-the-lanes)). Removing them breaks every fresh install and the symptom appears nowhere near the cause.
- **T057** [P] Add the FR-100 assertion: no child process anywhere in the shipped tree. Probe it by planting a spawn and confirming it fails.
- **T058** [P] README, `docs/agents.md`, `.env.example`, and the `description` field of all four `package.json` files — none may still claim PR, CI, branch or checkout correlation (FR-101).
- **T059** [P] `resources/design` — check the design system references to the three-lane board.
- **T060** CHANGELOG entry, with the **breaking changes listed at the top** of it: three `drift.*` operations and `grndctrl_list_drift` removed, `sessions.start` loses a parameter, `links.resolve` loses four targets, `work.list` items lose four fields, `board.summary` loses `drifting`.
- **T061** STATUS.md — what the product is now, what it no longer does, and the greyscale failure recorded as fixed rather than quietly disappearing from the list.
- **T062** Version cut per [plan.md](./plan.md#versioning) — recommendation **0.4.0**, four manifests, cross-dependencies, two version constants, lockfile.
- **T063** Release: verify, dry-run the release workflow against the branch (the only way to exercise the client-reference audit over full history before the one-way door), merge, tag, push.

---

## Dependencies & Execution Order

### Phase dependencies

```
Phase 0 ─→ M1 ─→ M2 ─→ M3 ─→ M4 ─→ M5 ─→ M6
             │           │      ↑
             │           └──────┘  T035 (builders) unblocks most of M3's tests
             └─ T004 must precede M4, and is easiest to do at the very start
```

M1 and M2 are genuinely independent of each other in code — the renderer reads the registry, so narrowing the registry after the renderer means no window where the renderer asks for something gone. Doing M2 first would work too, but leaves the board showing empty lanes for a commit, which is the state this whole change exists to remove.

### Critical path

T005 → T015 (*look at it*) → T030 (join) → T039 (types) → T044 (authored migration) → T046/T047 (its test and its probe) → T055 (end-to-end green) → T063.

**T015 is a real decision point, not a checkpoint.** If the ticket-only board is not worth using, everything after it is wasted work, and M1 is one revert.

### Parallel opportunities

- T009–T013 (panels and settings) — different files.
- T019–T021 (MCP, CLI) — different packages.
- T056–T059 (audits and docs) — different files.

Nothing in M3 or M4 parallelises usefully; they are a chain through shared modules.

---

## Implementation Strategy

**Why not delete the providers first.** It is the obvious order and it is wrong here. It makes the first commit several thousand lines that cannot be reviewed or bisected, leaves the tree red until the last presentation change lands, and puts the authored-store migration — the only step that can lose the operator's data — in the middle of a tree that does not build. Outside-in costs one commit's worth of fetching data nothing renders, and buys a green tree at every point and an answerable question at T015.

**Why the fixtures come near the end.** They have to match the engine, and the engine is still moving until M4 closes. Rewriting them at M1 means rewriting them twice.

**What "done" looks like.** SC-001 through SC-012 in [spec.md](./spec.md#measurable-outcomes), each with a named check in [quickstart.md](./quickstart.md). The completion report leads with the capability table from the spec — two lanes, all nine drift rules, the Attention region and the interface's only route to the outbox are gone, and a report that opens with "removal complete, all tests green" would be true and misleading.

**006 is not shippable alone.** It ends with a board thin enough that the layout deserves a second look, which is what [007](../007-agent-console/tasks.md) is for. They release together.
