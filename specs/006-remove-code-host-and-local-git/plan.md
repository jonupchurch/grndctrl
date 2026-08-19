# Implementation Plan: removing the code host and local git

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19

**Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Tasks**: [tasks.md](./tasks.md)

---

## Summary

Remove the GitHub provider, the local git reader, and everything downstream of them, leaving a board that correlates **tickets and agent sessions** and reports where those two disagree. Sixty-odd source files across five packages are touched; five mirror tables and four project columns go; six of nine drift rules retire; nothing the operator has written is lost.

The plan's whole shape comes from one decision in [R7](./research.md#r7--in-what-order-can-this-be-done-so-that-every-commit-is-green): work **outside in**, renderer first, so that every commit builds and the resulting board can be looked at before the engine underneath it is dismantled.

---

## Technical Context

| | |
|---|---|
| **Language / runtime** | TypeScript 5.6, Node 22, Electron 33, React 19 — unchanged |
| **Storage** | `mirror.db` + `authored.db`, better-sqlite3 — unchanged in kind; both gain a migration |
| **Testing** | Vitest for units, Playwright + real Electron for end-to-end — unchanged |
| **Scale** | Smaller than before: one provider, one work lane |
| **Schema versions after this change** | mirror **4**, authored **2** |
| **Version** | Minor at least; see *Versioning* below |

**Nothing is added.** No new dependency, no new module, no new abstraction. The only files created are two migrations and their tests, plus rebuilt fixtures. Every other change is a deletion or a narrowing. A removal that grows the tree has misunderstood itself.

---

## Constitution Check

### Part II — product and architecture gates

| Gate | Verdict |
|---|---|
| **XI** — no secrets outside the OS credential store | **Strengthened.** FR-112 deletes the removed connections' secrets from the keychain rather than orphaning them. One provider's credentials remain. |
| **XII** — everything reachable through the registry | **Held.** Operations are removed from the registry, not bypassed. The three adapters stay three translations of one list. |
| **XIII** — mirrored and authored data separate, no cross-file reference | **Exercised, and this is the proof.** Five mirror tables drop with no cascade and no authored change, which is exactly what XIII was for. The authored migration is separate and touches nothing mirrored. |
| **XIV** — no provider data without its freshness | **Held and narrowed.** Freshness rows for retired resource kinds are deleted so the header cannot report a resource that no longer exists. |
| **XV** — degrade honestly, never blank | **Re-read carefully.** With one provider, "one lane failing must not blank the others" has less to bite on — but the session lane and Attention are still separately fallible, so the error boundaries stay. The removal must not be an excuse to remove them. |
| **XVI** — never hold write authority | **Held, trivially stronger.** Two write-shaped action kinds retire; the remaining ones still require per-action confirmation. |
| **XVII** — Windows first-class | **Held, and cheaper.** The largest source of Windows-specific complexity was the git path handling, which goes entirely. |
| **XVIII** — determinism | **Held.** Correlation stays a pure function of two stores; FR-107 and SC-007 assert it over the narrowed inputs. |

### Part I — process principles

- **Probe the gates.** Every new assertion in this plan — no child process, no code-host client, authored rows preserved, dismissals survive, four severities reachable — must be made to fail before it is relied on. A removal is the easiest possible place to write a test that passes because it tests nothing.
- **Report what does not work.** The capability table in the spec is the honest version; the completion report must lead with it.

### Gate verdict

**Pass.** No gate is weakened. Two are strengthened (XI, XIII). One (XV) needs deliberate care not to be quietly dropped along with the lanes it was written for.

---

## Project Structure

### Documentation (this feature)

```
specs/006-remove-code-host-and-local-git/
├── spec.md              # what changes and what it costs
├── plan.md              # this file
├── research.md          # the six questions, answered from the code
├── data-model.md        # entities before and after, and both migrations
├── quickstart.md        # how to verify each milestone
├── tasks.md             # the ordered work
├── contracts/
│   ├── operations.md    # registry delta
│   ├── mcp-tools.md     # agent surface delta
│   └── ipc-channels.md  # bridge delta
└── checklists/
    └── requirements.md
```

### Source code — what happens to each package

```
packages/core/src/
├── providers/
│   ├── github/          DELETE (2 files, 589 lines)
│   ├── git/             DELETE (3 files, 485 lines)
│   ├── seam.ts          NARROW — CodeProvider and LocalGitProvider go
│   └── index.ts         NARROW — three exports go
├── correlation/
│   ├── join.ts          NARROW — the largest single edit; work items become tickets
│   ├── match.ts         DELETE — branch/PR key matching has nothing to match
│   ├── ball.ts          NARROW — three of six inputs
│   ├── severity.ts      NARROW — two of six source groups
│   ├── activity.ts      KEEP — ticket activity only, already
│   └── staleness.ts     KEEP
├── drift/rules.ts       NARROW — six rules out, three rewritten
├── services/
│   ├── sync.ts          NARROW — syncCode and syncLocal go; syncTickets stays
│   ├── links.ts         NARROW — four link kinds go
│   ├── connections.ts   NARROW — one provider kind
│   ├── settings.ts      NARROW — FR-103 reshape
│   └── board.ts         NARROW
├── domain/
│   ├── types.ts         NARROW — five entities out, four fields off Project
│   └── keys.ts          NARROW — repository/pr/branch/workspace/check keys go
├── store/
│   ├── mirror/          migration 4 + repository narrowing
│   └── authored/        migration 2 (the risky one — see R4)
├── registry/ops/        NARROW — config, links, sync, work
└── runtime/             NARROW — providers, scheduler

packages/desktop/src/renderer/
├── lanes/Lanes.tsx      NARROW — PullRequests and Branches components go
├── components/Row.tsx   NARROW — correlation badges narrow
├── settings/Projects.tsx    NARROW — repository and checkout fields go
├── settings/Connections.tsx NARROW — one provider kind
└── types.ts             NARROW — mirrors core

packages/mcp/src/tools/  NARROW — read.ts descriptions, sessions.ts workspaceKey
packages/cli/src/        NARROW — probe.ts, board.ts, credential.ts

fixtures/
├── github/, git/        DELETE (gitignored; local only)
└── scenarios/*.json     REBUILD — ticket-only, relative timestamps (FR-118)

scripts/
├── audit-egress.ts      NARROW provider list; KEEP first-run entries (R6)
└── record-fixtures.ts   NARROW — two recorders go
```

---

## Milestones

Each is a commit or a small run of them, each green, each independently verifiable in [quickstart.md](./quickstart.md).

### M1 — The board becomes what it will be

Renderer only. Remove the pull-request and branch lanes, the repository and checkout fields from project settings, the GitHub arm of the connections screen. Core still fetches everything; nothing renders it.

**Why first**: it is the whole change as the operator sees it, and it is reversible in one revert. If a ticket-only board turns out to be too thin to be worth using, that is far better learned now than after the engine is gone.

**Verifiable**: launch on a seeded scenario; one work lane plus sessions; settings offers no repository field.

### M2 — The adapters stop offering what the board no longer shows

Registry operations, MCP tools, CLI. `links.resolve` loses four kinds; `sessions.start` loses `workspaceKey`; agent-facing descriptions stop promising pull-request state.

**Why here**: the adapters are the contract with agents. Narrowing them before the engine means an agent that asks for removed data gets a clean rejection rather than an empty answer from a half-dismantled engine.

### M3 — The engine narrows

Correlation, drift, severity, ball, links. Delete the GitHub and git providers, their sync arms, their fixtures and their tests. This is the largest milestone and the first where behaviour rather than presentation changes.

**The care point**: drift rule identifiers. D2, D3 and D7 keep their numbers and lose evidence; the other six are retired and burned.

### M4 — Types and store

Domain types shrink. Mirror migration 4 drops five tables, deletes retired freshness rows, rebuilds `connections` with a narrowed check, and deletes the removed connections' keychain secrets *before* dropping their rows. Authored migration 2 rebuilds `projects` without the four columns and without the constraint that named one of them.

**The risk point**: this is the only milestone that can lose the operator's data. It gets a test that starts from a database written by 0.3.0 and asserts every authored row by count and content, and the credential deletion gets its own ordering test.

### M5 — Fixtures, tests and the standing greyscale failure

Rebuild `fixtures/scenarios/*.json` ticket-only, with timestamps relative to load rather than absolute (FR-118). This closes a defect that predates this change: three `greyscale.spec.ts` tests have failed on `main` since 2026-08-17 because `every-severity.json` aged past the staleness thresholds it depends on.

**Why it belongs here and not in its own change**: the scenarios have to be rewritten anyway — every one of them carries pull requests and workspaces. Fixing the dating while rewriting costs nothing; fixing it separately means writing the same files twice.

### M6 — Documentation, audits, release

README, `docs/agents.md`, the four package descriptions, `.env.example`, CHANGELOG, STATUS. Egress audit: remove `api.github.com` from the provider list, keep the first-run entries and their comment. Then the version cut.

---

## Versioning

**Minor at least — 0.4.0 — and the case for major is real.**

Semver is about the public contract, and this project publishes four packages with an MCP tool surface that agents call. `sessions.start` loses a parameter, `links.resolve` loses four enum values, and `work.list` returns items with four fewer fields. For a consumer of `@grndctrl/core` or `grndctrl-mcp`, that is breaking.

Against a major: the project is at 0.x, where the convention is that minor may break, and it has one operator.

**Recommendation: 0.4.0**, with the breaking changes listed explicitly at the top of the changelog entry rather than buried in it. If the operator would rather signal harder, 1.0.0 is available and costs nothing but a decision — but 1.0.0 also claims a stability this is not the moment to claim.

---

## Deferred decisions

Named here so they are decisions rather than oversights.

| Deferred | Why | Cost to revisit |
|---|---|---|
| **A repository link on a project** | Out of scope by FR-099; the operator asked for removal, not for a reduced version. | One field, same shape as `documentationUrl`. Trivial. |
| **A view for orphaned notes** | Notes on removed subjects are kept (FR-109) but have no row to hang on, so they are invisible on the board. Building a browser for them is a feature, not part of a removal. | A read-only list in Settings, or leave it to the CLI. |
| **Whether the session lane moves into the main column** | With one work lane, the two-column layout is thinner on the left. It still holds tickets plus Attention, which is substantial. | Layout only; no data change. Decide by looking at M1. |
| **Renaming the product's description** | "A local-first command station correlating tickets, PRs, CI, local git, and agent sessions" is now false and is fixed in M6. Whether the *product* wants a different name is a separate conversation. | None; M6 fixes the false claim regardless. |

---

## Complexity Tracking

### Tracked risks

| Risk | Why it is real here | Mitigation |
|---|---|---|
| **The authored migration loses a project row** | It is a 12-step table rebuild ([R4](./research.md#r4--can-the-authored-store-be-narrowed-without-losing-rows--changes-the-design)), which writes every row, on the one database that must never lose one. | A test that starts from a real 0.3.0 database, including a repo-only project. Probed by making the copy step drop a row and confirming the test fails. |
| **A dismissed finding comes back** | Dismissals key on `drift:<rule>:<subject>`. Any renumbering resurrects them. | Identifiers burned (FR-114); a test asserts a pre-upgrade dismissal still suppresses. |
| **Keychain secrets orphaned** | Dropping a connection row leaves its secret unreferenced and unreachable — no screen can show it, so nobody removes it. | Read refs before dropping rows; delete each. Ordering has its own test. |
| **Removing the wrong GitHub host from the egress audit** | `github.com` is in the *first-run* allowance for the Electron native module download. Removing it breaks every fresh install, and the symptom is far from the cause. | [R6](./research.md#r6--what-does-removing-local-git-buy-besides-the-lanes) states the distinction; SC-002 asserts both halves. |
| **A test that passes because it tests nothing** | Removal tests assert absence. An assertion that something is missing passes trivially if the selector was wrong. | Every absence assertion pairs with a presence assertion that must find something in the same query — the pattern already used by `board.spec.ts`. |
| **Green tests, dead board** | The end-to-end suite runs against seeded scenarios. If the scenarios are rewritten to match the implementation, both can be wrong together. | The change is looked at running, on a real board, at M1 and again at M6 — not only asserted. |

### Not tracked, deliberately

- **Losing the code-host implementation.** It is in git history at `8956f2f` and can be restored. Carrying it dark was the alternative, and [the spec](./spec.md#what-this-costs-stated-up-front) explains why it is worse.
- **Performance.** The board gets smaller and does less I/O. The 200-item performance test stays as a floor, not because it is at risk.

---

## Post-design constitution re-check

Re-run after the data model and contracts were written, which is where a design usually discovers it has broken a gate it passed on paper.

**Still passing.** One thing surfaced that the first pass missed: XV ("degrade honestly, never blank") was written for a board with several independently-failing providers, and it would be easy to remove the lane error boundaries along with the lanes, on the argument that a single-provider board has nothing to isolate. That is wrong — the session lane, the Attention region and the ticket lane still fail independently, and the boundaries stay. It is called out in M1's tasks explicitly so that it is a decision rather than an omission.
