# Tasks: removing the code host and local git

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
- **T003** Take a copy of a real 0.3.0 `authored.db` — or construct one via the seed script plus manual inserts — containing a project of each shape (Jira+repo, Jira only, repo only), notes on all five subject kinds, sessions with and without a workspace key, outbox actions of all four kinds, and a dismissal for a rule about to be retired. This is M4's test fixture and it must exist before M4 starts, not during it.

---

## Phase 1: M1 — The board becomes what it will be

Renderer only. Core still fetches everything; nothing renders it.

### Lanes

- **T004** Delete the `PullRequests` and `Branches` components from `packages/desktop/src/renderer/lanes/Lanes.tsx`, with `severityOfPull`, `describePull`, `describeWorkspace` and `comparisonFor`.
- **T005** Remove their `LaneBoundary` wrappers from `App.tsx`. **Keep every remaining boundary** — see [ipc-channels.md](./contracts/ipc-channels.md#what-must-not-be-removed-along-with-the-lanes); this is the gate XV trap.
- **T006** Narrow `Row.tsx`: the correlation badge set loses `pull-request` and `check`, leaving `branch`… which also goes. Decide whether a correlation slot survives at all — with only `agent` left it is a one-badge column, and a column with one always-computable value may be better rendered as part of the court slot. **Look at it running before deciding.**
- **T007** Narrow `sort.ts`: no lane needs the `age` accessor removal or addition, but confirm the ticket lane's sortable set is still right with the lane count changed.

### Panels and counts

- **T008** [P] `StatTiles.tsx` — confirm every tile still counts something that exists. `stalled`, `drifting`, `yourCourt`, `agentsLive` all survive; assert rather than assume.
- **T009** [P] `BallInCourt.tsx` — the panel accounts for every item; with `them` now reachable only through ticket assignment, check the empty and all-one-bucket renderings still read sensibly.
- **T010** [P] `Attention.tsx` — drift strips lose six of nine rule shapes. Check the evidence rendering with two-sided evidence where one side is a session.

### Settings

- **T011** [P] `settings/Projects.tsx` — remove the repository field, the checkout-paths field and the GitHub connection selector. The project summary line loses its repository and checkout rows.
- **T012** [P] `settings/Connections.tsx` — one provider kind. Remove the GitHub token flow and every reference to a GitHub permission (this is the screen 0.1.3 already had to correct once).

### Verify M1

- **T013** Update `board.spec.ts`, `golden-path.spec.ts`, `perf.spec.ts` and `degradation.spec.ts` for the lane change. Each absence assertion pairs with a presence assertion in the same query.
- **T014** Launch it and look at it. One work lane plus sessions, Attention beneath, panels beside. **Decide T006 here, and decide whether the two-column layout still holds** ([deferred in the plan](./plan.md#deferred-decisions)).

---

## Phase 2: M2 — The adapters stop offering what the board no longer shows

- **T015** `registry/ops/links.ts` + `services/links.ts` — remove the four link targets. A removed target is an explicit error, never a silent fallback to the ticket.
- **T016** `registry/ops/config.ts` — `projects.upsert`/`projects.list` lose four fields; `connections.test` loses `repo`. Add the "a project must name a ticket project" validation, with an error that names the field ([operations.md](./contracts/operations.md#projectsupsert--projectslist)).
- **T017** `registry/ops/sync.ts` + `registry/ops/work.ts` — provider and resource-kind narrowing; `board.summary` lanes.
- **T018** [P] `packages/mcp/src/tools/sessions.ts` — remove `workspaceKey`; a caller sending it is rejected, not ignored (FR-115).
- **T019** [P] `packages/mcp/src/tools/read.ts` and `notes.ts` — rewrite the four descriptions per [mcp-tools.md](./contracts/mcp-tools.md#descriptions-that-must-change). The notes description must still say that notes on older subject kinds are readable by key.
- **T020** [P] `packages/cli/src/{probe,board,credential}.ts` — one provider to probe, one lane to print, one credential kind to import.
- **T021** Extend the registry conformance test with the three assertions in [operations.md](./contracts/operations.md#what-the-conformance-test-must-now-assert). **Probe each**: reintroduce a removed target and confirm the test fails.

---

## Phase 3: M3 — The engine narrows

The largest milestone. Behaviour changes here, not just presentation.

### Delete the providers

- **T022** Delete `packages/core/src/providers/github/` (2 files) and `packages/core/src/providers/git/` (3 files). Narrow `providers/index.ts` and `providers/seam.ts` — `CodeProvider` and `LocalGitProvider` go.
- **T023** Delete `packages/core/test/providers/{github,git-read,git-allowlist,git-windows}.test.ts`. Narrow `replay.test.ts` to the one provider that remains, **keeping its guard that an empty fixture directory fails rather than skips** — that guard is the reason the suite cannot rot into a green no-op, and it is easy to lose while deleting two of its three describes.
- **T024** Narrow `test/fixtures/record.ts` and `scripts/record-fixtures.ts`; delete `test/fixtures/record-git.ts`. Delete the local `fixtures/github/` and `fixtures/git/` directories (gitignored, so this is a local cleanup, not a commit).

### Sync and wiring

- **T025** `services/sync.ts` — delete `syncCode` and `syncLocal` and the `LOCAL_CONNECTION_ID` constant. `syncTickets` is untouched. Narrow `SyncTargets` and `SyncReport`.
- **T026** `runtime/providers.ts` — `buildSyncTargets` builds ticket providers only. The credential-handling and the `unavailable` reporting stay exactly as they are.
- **T027** `runtime/scheduler.ts` — one provider kind, one interval. The `'local'` pseudo-kind goes.
- **T028** `services/connections.ts` — one provider kind to test and to remove.

### Correlation

- **T029** `correlation/join.ts` — the largest single edit. Work items are built from tickets alone; the workspace-keyed fallback, the remote→project mapping, check grouping and the dangling-reference output all go. `WorkItem.ticket` stops being nullable (FR-106).
- **T030** Delete `correlation/match.ts` and its test — branch and PR key matching has nothing to match.
- **T031** `correlation/ball.ts` — remove the three pull-request inputs, keep the fixed evaluation order (FR-105). Update `ball.test.ts`, including a case asserting that `them` is still reachable.
- **T032** `correlation/severity.ts` — remove the pull-request and workspace source groups. Update `severity.test.ts`, and **add the FR-104 assertion**: all four bands reachable from the remaining sources.
- **T033** `correlation/join.test.ts` and `determinism.test.ts` — narrow, keeping the determinism guarantee intact (FR-107, SC-007).
- **T034** `test/correlation/builders.ts` — delete the `pullRequest`, `workspace`, `branchRef`, `checkResult` and `comparison` builders. This file feeds most of the core suite, so it is the change that makes the rest of the phase compile.

### Drift

- **T035** `drift/rules.ts` — delete d1, d4, d5, d6, d8, d9 and the `dangling` input. Rewrite D2's and D3's summary strings and evidence, which currently name branches and pull requests in text the operator reads. Point D7 at the new `laneThresholdHours.sessions`.
- **T036** Narrow the `DriftRule` union to `'D2' | 'D3' | 'D7'` and **write the comment that burns the retired identifiers** (FR-114), where the union is declared. A future rule numbered D1 arrives pre-dismissed on every ticket where the old D1 was dismissed, and the only defence is a note at the point of temptation.
- **T037** `drift/rules.test.ts` — remove six rules' worth of cases, keep and narrow three. `dismiss.test.ts` gains a case: a dismissal recorded against a retired rule is inert and harmless.

---

## Phase 4: M4 — Types and store

Smallest diff, highest risk. **T003's fixture must already exist.**

- **T038** `domain/types.ts` — delete `PullRequest`, `CheckResult`, `BranchRef`, `Comparison`, `LocalWorkspace` and their supporting unions; narrow `Project`, `AgentSession`, `WorkItem`, `Settings`, `ResourceKind`, `ProviderKind`, `ActionKind`.
- **T039** `domain/keys.ts` — delete the removed constructors. **`subjectKindOf` keeps every kind it can parse** ([data-model.md](./data-model.md#entities-removed-entirely)) — a note written before this change carries a key of a removed kind, and a parser that stopped recognising it would turn a retained note into an unreadable one. Update `keys.test.ts` to assert exactly that.
- **T040** `services/settings.ts` — reshape `pollIntervalSec` and `laneThresholdHours`; add `sessions` with the old `pulls` default.
- **T041** Mirror migration **4**, in the order [data-model.md](./data-model.md#migration--mirrordb-version-3--4) sets out: read credential refs first, then drop connection rows, rebuild `connections` with the narrowed CHECK, drop five tables, delete retired freshness rows. The migration returns the refs; it never touches the keychain itself.
- **T042** `store/mirror/repository.ts` — delete the five entities' read/write paths.
- **T043** Authored migration **2**: `projects` 12-step rebuild without the four columns and **without a replacement CHECK** ([R4](./research.md#r4--can-the-authored-store-be-narrowed-without-losing-rows--changes-the-design)); `agent_sessions` drop column; `settings` payload reshape, idempotent (FR-113). `notes`, `outbox_actions` and `finding_dismissals` are not opened.
- **T044** The keychain deletion (FR-112): the caller takes T041's refs and deletes each secret. **Order has its own test** — refs read before rows dropped, or there is nothing left to read.
- **T045** The migration test, against T003's database. Every authored row present after upgrade, by count and by content; the repo-only project still there; the dismissal still suppressing; running it twice is a no-op.
- **T046** **Probe T045**: make the `projects` copy step drop a row and confirm the test fails. Make the keychain deletion run before the ref read and confirm the ordering test fails. An untested migration test is the worst thing in this change.
- **T047** `packages/desktop/src/renderer/types.ts` — narrow the mirrors. If this compiles, the renderer reads nothing that no longer exists.

---

## Phase 5: M5 — Fixtures, tests, and the standing greyscale failure

- **T048** Rebuild `fixtures/scenarios/merged-pr-open-ticket.json` as a ticket-and-session scenario. It needs a new name — it is named for a correlation that can no longer exist. It is referenced by `board.spec.ts`, `golden-path.spec.ts`, `agent-push.spec.ts` and the seed script's default.
- **T049** Rebuild `fixtures/scenarios/every-severity.json` so all four severities come from ticket, session, drift and staleness sources, per [R3](./research.md#r3--what-happens-to-severity-and-ball-in-court).
- **T050** **Relative timestamps** (FR-118). Scenario timestamps become offsets resolved when the scenario is loaded — `scripts/seed.mjs` and `test/fixtures/record.ts` both read scenarios and both must resolve them the same way. This is the fix for the three `greyscale.spec.ts` failures that predate this change.
- **T051** **Probe T050**: set the machine clock forward a week — or advance the injected `now` — and confirm the severity scenario still produces all four. The current fixture fails this, which is the whole point.
- **T052** `packages/desktop/test/e2e/large-board.ts` — the 200-item generator loses pull requests, branches, checks and comparisons. `perf.spec.ts`'s floor stays; the board is smaller and must still be fast.
- **T053** `degradation.spec.ts` — rewritten. It demonstrated one provider failing while others rendered; with one provider it must demonstrate the ticket lane failing while sessions, Attention and the connection notice still render (gate XV, still live).
- **T054** Full end-to-end run. **Green including greyscale** — that is SC-008, and it is the one result that shows this change left the suite better than it found it.

---

## Phase 6: M6 — Documentation, audits, release

- **T055** [P] `scripts/audit-egress.ts` — remove `api.github.com` from the **provider** allow-list. **Keep `github.com` and `objects.githubusercontent.com` in the first-run list, with their comment** ([R6](./research.md#r6--what-does-removing-local-git-buy-besides-the-lanes)). Removing them breaks every fresh install and the symptom appears nowhere near the cause.
- **T056** [P] Add the FR-100 assertion: no child process anywhere in the shipped tree. Probe it by planting a spawn and confirming it fails.
- **T057** [P] README, `docs/agents.md`, `.env.example`, and the `description` field of all four `package.json` files — none may still claim PR, CI, branch or checkout correlation (FR-101).
- **T058** [P] `resources/design` — check the design system references to the three-lane board.
- **T059** CHANGELOG entry, with the **breaking changes listed at the top** of it: `sessions.start` loses a parameter, `links.resolve` loses four targets, `work.list` items lose four fields.
- **T060** STATUS.md — what the product is now, what it no longer does, and the greyscale failure recorded as fixed rather than quietly disappearing from the list.
- **T061** Version cut per [plan.md](./plan.md#versioning) — recommendation **0.4.0**, four manifests, cross-dependencies, two version constants, lockfile.
- **T062** Release: verify, dry-run the release workflow against the branch (the only way to exercise the client-reference audit over full history before the one-way door), merge, tag, push.

---

## Dependencies & Execution Order

### Phase dependencies

```
Phase 0 ─→ M1 ─→ M2 ─→ M3 ─→ M4 ─→ M5 ─→ M6
             │           │      ↑
             │           └──────┘  T034 (builders) unblocks most of M3's tests
             └─ T003 must precede M4, and is easiest to do at the very start
```

M1 and M2 are genuinely independent of each other in code — the renderer reads the registry, so narrowing the registry after the renderer means no window where the renderer asks for something gone. Doing M2 first would work too, but leaves the board showing empty lanes for a commit, which is the state this whole change exists to remove.

### Critical path

T004 → T014 (*look at it*) → T029 (join) → T038 (types) → T043 (authored migration) → T045/T046 (its test and its probe) → T054 (end-to-end green) → T062.

**T014 is a real decision point, not a checkpoint.** If the ticket-only board is not worth using, everything after it is wasted work, and M1 is one revert.

### Parallel opportunities

- T008–T012 (panels and settings) — different files.
- T018–T020 (MCP, CLI) — different packages.
- T055–T058 (audits and docs) — different files.

Nothing in M3 or M4 parallelises usefully; they are a chain through shared modules.

---

## Implementation Strategy

**Why not delete the providers first.** It is the obvious order and it is wrong here. It makes the first commit several thousand lines that cannot be reviewed or bisected, leaves the tree red until the last presentation change lands, and puts the authored-store migration — the only step that can lose the operator's data — in the middle of a tree that does not build. Outside-in costs one commit's worth of fetching data nothing renders, and buys a green tree at every point and an answerable question at T014.

**Why the fixtures come near the end.** They have to match the engine, and the engine is still moving until M4 closes. Rewriting them at M1 means rewriting them twice.

**What "done" looks like.** SC-001 through SC-010 in [spec.md](./spec.md#measurable-outcomes), each with a named check in [quickstart.md](./quickstart.md). The completion report leads with the capability table from the spec — six drift rules, two lanes and four severity sources are gone, and a report that opens with "removal complete, all tests green" would be true and misleading.
