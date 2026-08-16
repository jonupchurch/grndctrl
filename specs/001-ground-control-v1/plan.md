# Implementation Plan: Ground Control v1

**Branch**: `001-ground-control-v1` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ground-control-v1/spec.md`

---

## Summary

Build a local-first desktop command station that joins Jira tickets, GitHub PRs
and CI, local git state, and AI agent sessions into one board, detects when those
sources disagree, and dispatches confirmed actions to agents.

The technical approach is **one core package with three thin adapters**. All
behaviour lives in a framework-free `core` that imports nothing from Electron,
React, or the DOM, and exposes a typed **operation registry**. An IPC adapter
serves the renderer, a loopback HTTP adapter serves the MCP server, and the MCP
server exposes the same operations to agents. A conformance test asserts all
three adapters cover the registry, which turns constitution gate XII from a rule
people remember into a build failure.

Work is sequenced **headless-first** (research [R10](./research.md#r10--build-sequence)):
skeleton, then the correlation engine proven against fixtures with Electron
uninstalled, then the agent surface, then the Electron shell. The differentiating
and riskiest component is finished before the expensive one starts.

---

## Technical Context

**Language/Version**: TypeScript 5.x, strict, ESM, on Node 22+

**Primary Dependencies**: Electron (desktop shell) · React 19 + TanStack Query
(renderer) · `better-sqlite3` (storage) · `@napi-rs/keyring` (credentials) ·
`@modelcontextprotocol/sdk` (agent surface) · Zod (schemas at every trust
boundary) · Vitest (tests) · Playwright (end-to-end)

**Storage**: Two SQLite databases in the per-user app data directory —
`mirror.db` (disposable provider cache) and `authored.db` (the user's own data).
WAL mode, versioned forward-only migrations per database, no foreign key spans
the two ([R7](./research.md#r7--storage)).

**Testing**: Vitest for unit, integration, and adapter-conformance tests;
Playwright against the packaged Electron build for the golden path. Provider
tests run against recorded HTTP fixtures, never live APIs ([R9](./research.md#r9--testing)).

**Target Platform**: Windows 11, macOS 14+, Linux (GTK). **Windows is the primary
development machine and the first target verified** (XVII).

**Project Type**: Desktop application with a headless core and a separate MCP
server process, delivered over npm as `npx grndctrl`.

**Performance Goals**: Project filter re-render under 100 ms at 200 work items
(SC-013) · full correlation pass under 250 ms at 500 work items · board first
paint under 2 s from a warm cache · a silent session reflected within one
heartbeat interval (SC-014).

**Constraints**: No inbound listener reachable off-machine (FR-009) · no network
call to any non-provider host (FR-008) · no git command that touches the network
(FR-017) · no provider write with the app's credentials (FR-057) · correlation
runs with no display, no network, and Electron uninstalled (XVIII) · GitHub
ahead/behind costs one comparison per tracked branch, so poll cost scales with
branch count ([R3](./research.md#r3--github-acquisition--changes-the-design)).

**Scale/Scope**: One operator, one machine. Design target 10 projects, 500 work
items, 40 tracked branches per repository, 6 concurrent agent sessions. 87
functional requirements across 4 milestones.

---

## Constitution Check

*GATE: evaluated before Phase 0, re-evaluated after Phase 1 design. Constitution
v4.0.0.*

### Part II — product and architecture gates

| Gate | Verdict | How the design satisfies it |
|---|---|---|
| **XI** Local-first, single-user | ✅ Pass | All state in two local SQLite files. Credentials only via `@napi-rs/keyring` ([R5](./research.md#r5--credentials)); no environment-variable fallback. Outbound HTTP allow-list is the configured provider hosts plus the GitHub releases host used once to fetch the runtime; a test asserts no other host is reachable from core. No telemetry, analytics, crash reporting, or update ping. |
| **XII** One service layer; adapters thin | ✅ Pass — **this plan closes it** | The operation registry in `core` is the single service layer; `adapter-ipc`, `adapter-http`, and `adapter-mcp` translate transport only. A conformance test fails the build if any adapter omits a registry entry, and adapters may not import providers, stores, or correlation directly ([R1](./research.md#r1--service-placement-and-adapter-shape-closes-constitution-gate-xii)). |
| **XIII** Mirrored vs authored separate | ✅ Pass | Two database *files*, not two schemas. Authored records reference provider entities by natural key only. Deleting `mirror.db` is a supported operation with a test that asserts every note, session, outbox entry, and setting survives it (SC-007). |
| **XIV** Freshness always shown | ✅ Pass | Every read operation in the registry returns a `freshness` envelope — `lastSuccessAt`, `lastFailureAt`, `failureReason`, `nextAttemptAt` — enforced by the output schema, so an operation *cannot* return provider data without it. This applies identically to MCP responses; a contract test asserts the envelope on every provider-derived payload. |
| **XV** Degrade per-provider | ✅ Pass | Sync is per connection with independent failure state. Correlation accepts partial inputs and marks work items partially resolved rather than hiding them. Each renderer lane has its own query and its own error boundary. |
| **XVI** Read-only credentials; writes dispatched | ✅ Pass | Provider clients expose no write methods at the type level — there is no function to call. Git access goes through one module with a subcommand allow-list ([R4](./research.md#r4--local-git-read-only)). Outbox entries require an explicit confirmation token minted by a user gesture; no sync, rule, or timer path can produce one. |
| **XVII** Cross-platform, Windows first-class | ✅ Pass | No hardcoded separators; git spawned with an argument array and `-C`; CRLF tolerated in parsed output; keychain verified on Windows Credential Manager in M1. Windows is the first platform each milestone is verified on. |
| **XVIII** Correlation engine tested | ✅ Pass | `correlation/` and `drift/` are pure functions over plain data with no I/O. Every drift rule ships a firing test and a declining test. The M2 exit criterion is the fixture suite green with Electron uninstalled. |

### Part I — process principles

Rule VII (plan the whole feature set before building) is satisfied: v1 is specced
and planned as one feature covering the entire initial set, and no
implementation has begun. Rule IX applies from here — work continues on
`001-ground-control-v1` with atomic commits per milestone slice. Rule X governs
the two decisions this plan defers (below).

### Gate verdict

**PASS** — no violations requiring redesign. Two judgment calls are recorded in
Complexity Tracking because a reviewer should challenge them rather than
discover them.

---

## Project Structure

### Documentation (this feature)

```text
specs/001-ground-control-v1/
├── spec.md              # The v1 specification
├── plan.md              # This file
├── research.md          # Phase 0 — ten resolved unknowns
├── data-model.md        # Phase 1 — entities, keys, state machines
├── quickstart.md        # Phase 1 — how to verify each milestone
├── contracts/           # Phase 1 — operation registry, MCP tools, IPC channels
│   ├── operations.md
│   ├── mcp-tools.md
│   └── ipc-channels.md
├── checklists/
│   └── requirements.md  # Spec quality validation
└── tasks.md             # Phase 2 — /speckit-tasks output
```

### Source Code (repository root)

npm workspaces. The boundary that matters is that **`packages/core` imports
nothing from `electron`, `react`, or the DOM** — enforced by a lint rule, not by
convention, because XVIII depends on it.

```text
packages/
├── core/                        # The service layer. No Electron. No UI. No display.
│   └── src/
│       ├── registry/            # Operation registry: names, Zod schemas, handlers
│       ├── domain/              # Entity types and natural-key construction
│       ├── correlation/         # join · severity · staleness · ball-in-court (pure)
│       ├── drift/               # rules D1–D9 (pure)
│       ├── providers/
│       │   ├── jira/            # search/jql + changelog bulkfetch
│       │   ├── github/          # one GraphQL doc per repo + aliased comparisons
│       │   ├── git/             # the only module allowed to spawn git
│       │   └── seam.ts          # provider interface; read-only by type
│       ├── store/
│       │   ├── mirror/          # mirror.db schema, migrations, repositories
│       │   └── authored/        # authored.db schema, migrations, repositories
│       ├── services/            # work · drift · notes · sessions · outbox · sync · settings
│       ├── auth/                # keychain seam
│       └── runtime/             # scheduler, handshake file, freshness bookkeeping
│
├── desktop/                     # The Electron application
│   └── src/
│       ├── main/                # lifecycle, windows, adapter-ipc, adapter-http host
│       ├── preload/             # the contextBridge surface and nothing else
│       ├── renderer/            # React: lanes, Attention, modal, theming
│       └── shared/              # types and channel names only — no runtime Node deps
│
├── mcp/                         # grndctrl-mcp: MCP stdio server (adapter-mcp)
│
├── launcher/                    # the published `grndctrl` bin: resolve runtime, verify, spawn
│
└── cli/                         # dev-only text board, lands in M2 so the engine is demoable

fixtures/                        # recorded provider payloads, scrubbed, checked in
├── jira/
├── github/
└── git/
```

**Structure Decision**: An npm-workspaces monorepo with `core` as a
framework-free package and every consumer — the Electron app, the MCP server,
the CLI — depending on it rather than on each other. This is the shape gate XII
describes, made structural: an adapter physically cannot grow business logic
without importing something `core` owns, and the dependency direction is
checkable by a lint rule. The alternative shapes are recorded in
[R1](./research.md#r1--service-placement-and-adapter-shape-closes-constitution-gate-xii).

`packages/cli` exists to answer the one real cost of building headless-first:
there is nothing to look at until M4. A text renderer of the board makes the
engine demonstrable at M2 and stays useful afterwards for inspecting fixtures.

---

## Deferred decisions

Two calls belong at implementation time, not here. Both are recorded so they are
made deliberately rather than by whoever touches the file first.

1. **Which row element the note count displaces.** The design system's 34px row
   has fully allocated fixed slots (spec Assumption 12). This is a design call
   against the real component, in M4.
2. **Whether core moves to `utilityProcess.fork`.** v1 runs core in the main
   process. If a correlation pass or a long `better-sqlite3` transaction is
   measured blocking the window, the move is prepared for by construction
   ([R1](./research.md#r1--service-placement-and-adapter-shape-closes-constitution-gate-xii)).
   Trigger: a measured frame drop, not a suspicion.

---

## Complexity Tracking

> Two judgment calls that a reviewer should challenge. Neither is a constitution
> violation; both are places where the honest answer is "we chose, and here is
> the cost."

| Decision | Why needed | Simpler alternative rejected because |
|---|---|---|
| A local **handshake file** holding an ephemeral port and per-launch token, so `grndctrl-mcp` can reach the running app | The MCP server is spawned by the agent's client as a separate short-lived process and must both discover and authenticate to a running instance. Principle XI governs *provider credentials*; this is a per-launch local session token, scoped to loopback, deleted on exit, and no registry operation can return a provider credential — so holding it yields no tokens. | OS pipe/socket permissions instead of a token is genuinely stronger, but it is a named pipe on Windows and a unix socket on POSIX — two code paths in the component a Windows-first project can least afford to get subtly wrong in v1. A fixed port is guessable and collides. Making the user paste a token into their agent config loses the integration at first run. Revisit if the app ever runs on a shared machine, where the calculus changes. |
| **Five packages** (`core`, `desktop`, `mcp`, `launcher`, `cli`) rather than one | `core` must be importable with Electron uninstalled (XVIII), `mcp` must run as its own process, and `launcher` must be installable and runnable *before* the Electron runtime exists on the machine. Those are three genuinely different runtime environments, not three folders. | A single package cannot satisfy them: anything that hoists Electron into `core`'s dependency graph breaks the XVIII test story, and the launcher must have near-zero dependencies to install fast under `npx`. `cli` is the one package that is a convenience — it earns its place by making M2 demonstrable, and it is deletable without touching anything else. |

### Tracked risks

Not violations — the three places most likely to produce a bad day, with what is
being done about each.

| Risk | Impact | Mitigation |
|---|---|---|
| **`better-sqlite3` ABI mismatch under `npx`** | Fails at `require` time on a *user's* machine, not in CI, with a message naming two version numbers and no remedy | Prebuilds per platform/arch/ABI built with `@electron/rebuild`; a launch-time ABI check that fails with an actionable message; "install from the packed tarball on a clean machine with a cleared runtime cache" is an explicit acceptance task on all three platforms, not an assumption ([R8](./research.md#r8--packaging-highest-risk-in-the-project)) |
| **GitHub rate limit consumed by ahead/behind** | A 40-branch repo on a 60s poll can spend its hourly budget on comparisons alone | Alias multiple comparisons into one GraphQL document; skip comparison when a branch head SHA has not moved since the last successful poll; surface remaining budget in the connection view ([R3](./research.md#r3--github-acquisition--changes-the-design)) |
| **Jira history requires a second call** | Staleness and drift rules D1/D2/D7 are unimplementable from the search response alone | Bulk changelog fetch batched over the keys from each search page; if it fails, the ticket lane degrades to "activity unknown" and says so, rather than silently falling back to `updated` — which is the field FR-027 exists to distrust ([R2](./research.md#r2--jira-acquisition--changes-the-design)) |

---

## Post-design constitution re-check

Re-evaluated after `data-model.md` and `contracts/` were written.

- **XIV** strengthened during design: freshness moved from "each operation should
  include it" to a shared `Envelope<T>` output schema that every provider-derived
  operation must return, so omission is a type error rather than a review catch.
- **XVI** strengthened during design: the confirmation token in
  [contracts/operations.md](./contracts/operations.md) makes "no automatic
  dispatch" structural — `outbox.enqueue` requires a token that only a user
  gesture mints, so no sync or rule path can call it even by mistake.
- **XIII** verified against `data-model.md`: no authored entity holds a mirrored
  row id; every cross-store reference is a natural key.
- No new violations. Verdict unchanged: **PASS**.
