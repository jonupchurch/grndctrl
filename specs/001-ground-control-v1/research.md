# Phase 0 — Research: Ground Control v1

**Feature**: `001-ground-control-v1` · **Date**: 2026-08-14 · **Plan**: [plan.md](./plan.md)

Every unknown in the plan's Technical Context, resolved. Each entry states the
decision, why, what was rejected, and — where it matters — the constitution gate
it answers to.

Two findings changed the design rather than confirming it, and they are flagged
**⚠ CHANGES THE DESIGN** below: Jira can no longer return issue history in the
search call (R2), and GitHub's ahead/behind comparison is a per-branch call with
a real rate-limit cost (R3).

---

## R1 — Service placement and adapter shape (closes constitution gate XII)

**Decision.** One `core` package that imports nothing from `electron`, nothing
from a UI framework, and nothing that needs a display. It exposes a single
**operation registry**: a flat, typed map of named operations (`work.list`,
`drift.list`, `notes.upsert`, `outbox.claim`, …), each with an input schema, an
output schema, and a handler. Three adapters translate transport onto that
registry and contain no logic of their own:

| Adapter | Transport | Consumer |
|---|---|---|
| `adapter-ipc` | Electron `ipcMain.handle`, one channel per operation | the React renderer |
| `adapter-http` | loopback HTTP on `127.0.0.1`, ephemeral port, bearer token | `grndctrl-mcp` |
| `adapter-mcp` | MCP stdio server, tools mapped from the registry | the agent's MCP client |

The core **runs in the Electron main process** for v1, and is written so that
moving it into a `utilityProcess.fork` child later requires changing only where
it is instantiated.

**Why this closes XII.** The gate says a capability reachable through one
adapter but not the other is a defect. Enumerating operations in a registry makes
that mechanically checkable rather than a matter of discipline: a conformance
test asserts every registry entry is exposed by every adapter, and fails the
build when a new operation is added to one and not the others. The gate's other
clause — the Electron shell is "a client of the API, not a privileged sibling
with a private path to the data" — is satisfied because the IPC adapter is a
transport over the same registry, not a shortcut around it. It is a different
wire, not a different surface.

**Rejected**: letting the renderer call core functions directly across a thin
IPC veneer (fails the "no private path" clause the moment one convenience call
is added); putting the service in a `utilityProcess` from day one (a second
process boundary to debug before anything works, for a latency problem not yet
measured); a long-running local HTTP server as the *only* transport, with the
renderer as an HTTP client (an extra hop and a listening socket for every window
repaint, to solve a problem IPC does not have).

**MCP discovery and authentication.** The MCP server is a separate short-lived
process spawned by the agent's own MCP client (`npx grndctrl-mcp`), so it must
find a running Ground Control and prove it is allowed to talk to it. On start,
the app writes a handshake file to its per-user data directory containing the
ephemeral port and a per-launch random token, created `0600` on POSIX and with a
user-only DACL on Windows, and deletes it on exit. The MCP adapter reads it.

This is a local session token, not a provider credential, so Principle XI's
"never in a dotfile" is not engaged — but it is still a secret, and the
mitigations are explicit: it is per-launch, it is scoped to loopback, it dies
with the process, and **no operation in the registry can return a provider
credential**, so possessing it does not yield tokens. Rejected: a fixed port
(collides, and is guessable); OS pipe/socket permissions instead of a token
(stronger, but named pipes on Windows versus unix sockets on POSIX is two code
paths and a Windows-first project should not take that on for v1); requiring the
user to paste a token into their agent config (works, but the first-run
experience is where an integration is lost).

---

## R2 — Jira acquisition ⚠ CHANGES THE DESIGN

**Decision.** Search with `POST /rest/api/3/search/jql`, paginate on
`nextPageToken`, and fetch issue history **separately** via
`POST /rest/api/3/changelog/bulkfetch`.

**What changed.** The old `/rest/api/3/search` endpoints were deprecated through
2025 and progressively shut down; the replacement is the enhanced JQL search
endpoint. Two consequences the spec did not anticipate:

1. **There is no `total`.** Pagination is token-based and the response does not
   carry a result count. A lane count is therefore the count of what has been
   fetched, not a server-side total — so the UI must say "6 shown" and never
   imply "6 exist", and any "N of M" display has to come from a bounded fetch
   rather than a count query.
2. **Issue history is not reliably available on the search response.** Sources
   conflict on whether `expand=changelog` is honoured on the enhanced endpoint;
   the bulk changelog endpoint exists precisely because of that limitation. So
   the design must not depend on it.

**Why this matters more than it looks.** FR-026 defines "last real activity" in
terms of status transitions and assignment changes — which live in the
changelog, not on the issue. Staleness, three drift rules (D1, D2, D7), and the
whole staleness gauge rest on it. Taking history from a second, explicitly
supported call is the difference between a feature that works and one that
quietly degrades to "last updated", which is exactly the field that automation
noise corrupts (FR-027).

**Cost.** Two calls per poll instead of one, the second batched over the keys
from the first. At a 5-minute Jira interval this is well inside normal limits.

**Rejected**: `expand=changelog` on search (undependable per above); per-issue
`GET /issue/{key}?expand=changelog` (N+1 — the documented workaround for the old
API, and the reason `bulkfetch` was added); deriving activity from the `updated`
field alone (FR-027 exists because that field moves on label changes and bot
edits); scraping the activity stream (unsupported and unstable).

**Also decided here**: `currentUser()` in JQL resolves the operator per account
(FR-033); status semantics come from each status's **category** (`new`,
`indeterminate`, `done`) rather than its name, with a per-project override, so
that "Done" spelled differently does not break drift rule D1 (Assumption 5).

---

## R3 — GitHub acquisition ⚠ CHANGES THE DESIGN

**Decision.** One GraphQL query per repository per poll for PRs, reviews, and
checks; **one additional query per tracked branch** for ahead/behind.

**Ahead/behind is a per-branch call.** The GraphQL schema exposes
`Repository.ref(qualifiedName:).compare(headRef:)` returning a `Comparison` with
`aheadBy` and `behindBy`. It takes ref names, not SHAs, and it cannot be
batched across branches in the natural way — each tracked branch is its own
field selection. FR-018 requires this data and forbids getting it from a local
fetch, so the cost is structural, not incidental.

**Consequence for the plan**: tracked-branch count drives rate-limit
consumption, so the poll must (a) alias several comparisons into a single
GraphQL document rather than issuing one request each, and (b) skip comparisons
for branches whose head SHA has not moved since the last successful poll. Both
are implementation requirements, not optimisations to consider later — a 40-branch
repository on a 60-second poll would otherwise spend its hourly budget on
comparisons alone.

**Known caveat.** `Ref.compare` requires `repo` scope on an OAuth token even for
public repositories. The connection test must therefore verify the compare path
specifically, not merely that the token authenticates — otherwise ahead/behind
silently returns nothing on a token that looks fine everywhere else.

> **Settled against the live API, 2026-08-14.** A **fine-grained personal access
> token with read-only permissions** (Metadata, Contents, Pull requests, Checks,
> Commit statuses) authenticates against GraphQL *and* runs `Ref.compare`
> successfully. The `repo`-scope caveat applies to **classic** tokens; it does
> not force a read-write token on anyone. Constitution XVI's "read-only
> credentials" therefore holds literally rather than by convention, which is the
> outcome this project wanted and could not confirm from documentation.
>
> The verification is worth recording because the first run said the opposite.
> The probe compared the ref `HEAD` against itself, and
> `ref(qualifiedName: "HEAD")` resolves to nothing — so it reported "the token
> cannot compare branches" for a token that compares branches perfectly well.
> That false negative would have sent an operator to widen a correctly-scoped
> credential, which is the exact opposite of what the probe exists to achieve.
> It now probes with a real branch name read from the repository it just
> fetched, and the fixture test carries a branch for the same reason.

**Why GraphQL at all** (already locked, restated because it earns its keep here):
`pullRequest.reviewThreads { isResolved, isOutdated }` has no REST equivalent, and
review state drives both severity (FR-029) and ball-in-court (FR-032). REST would
need one call per PR per thread page.

**Rejected**: REST `/compare/{base}...{head}` (same per-branch cost, and would
mean running two API styles); computing ahead/behind locally (forbidden by
FR-017/FR-018 — it requires a fetch); showing only "diverged / not diverged"
(loses the number the design's branch lane renders).

---

## R4 — Local git, read-only

**Decision.** Spawn the user's own `git` binary with read-only plumbing
commands, through one module that is the only place in the codebase allowed to
execute git:

| Need | Command |
|---|---|
| dirty state | `git status --porcelain=v2 --branch` |
| unpushed commits | `git rev-list --count @{u}..HEAD` (absent upstream → unknown) |
| worktrees | `git worktree list --porcelain` |
| branches and heads | `git for-each-ref --format=... refs/heads` |
| remote identity | `git remote get-url origin` |

That module refuses any argument outside an allow-list of subcommands, which is
what makes FR-017 enforceable rather than aspirational — "we never fetch" is a
property of one file, testable by asserting the allow-list, instead of a habit
spread across the codebase.

**Rejected**: `isomorphic-git` (pure JS, no spawn — but it reimplements index
and config parsing, and disagreeing with the user's real git about their own
working tree is a worse failure than a spawn); `simple-git` (a convenience
wrapper whose whole surface is network-capable, so the allow-list guarantee
would be gone); libgit2 bindings (a second native module with an ABI to match,
next to the one already flagged as the riskiest thing in the project).

**Windows specifics** (XVII): pass `-C <path>` rather than changing directory;
never interpolate paths into a shell string — spawn with an argument array;
expect CRLF in output; treat paths case-insensitively but preserve case;
tolerate worktrees on a different drive letter, which is why worktree
association keys on the repository's canonical remote rather than a path prefix.

---

## R5 — Credentials

**Decision.** `@napi-rs/keyring`, via its `Entry` class:

```
new Entry(service, account) → setPassword() / getPassword() / deletePassword()
```

macOS Keychain, Windows Credential Manager, Linux libsecret; maintained, with
prebuilt binaries per platform. Reached only through an `auth` seam in core, so
OAuth can land later without touching call sites.

**Rejected**: `keytar` (archived); Electron `safeStorage` (encrypts a blob the
app must then store somewhere, which is exactly the dotfile-or-SQLite that XI
forbids); an encrypted file with a passphrase (invents key management and adds a
prompt to every launch).

**Failure behaviour** (FR-006): a headless Linux box with no libsecret provider
is the realistic failure. The app reports the connection as unusable and refuses
to fall back — no environment variable escape hatch, because that is precisely
the thing a `git add .` picks up.

---

## R6 — Agent transport: what MCP can and cannot promise

**Decision.** The durable outbox is the contract; push is an accelerator.

**What the protocol supports.** Servers can push to clients: a client sends
`resources/subscribe`, and the server then emits `notifications/resources/updated`
when that resource changes. Notifications are one-way JSON-RPC messages with no
reply. The server must declare `resources.subscribe` in its initialize response,
and — decisively — **the client must choose to subscribe**. The notification
carries no payload: it tells the client to re-read, nothing more.

**Therefore.** An agent learns about pending work by polling `outbox.pending`, and
*additionally* gets a nudge if its client subscribed. Ground Control cannot make
an agent act, cannot reach an agent with no open session, and must not behave as
though it can. FR-064 (durability) and FR-065 (push is an accelerator, never the
contract) are the direct consequence, and this is why the spec refuses to treat a
dispatched action as delivered until an agent claims it.

**Confidence boundary, stated plainly.** MCP client support for subscriptions is
uneven across implementations and moves faster than any document here. That is an
argument for the outbox, not against push: a design whose correctness depends on
an optional client capability would be wrong in a way that is invisible until a
user swaps agents.

**Rejected**: elicitation/sampling to drive the agent (server→client *requests*
exist, but support is thinner still, and using them would put Ground Control in
the position of commanding an agent rather than offering it work); a webhook or
local port the agent calls into (an inbound listener, which XI's posture and
FR-009 both refuse); requiring a long-lived agent process (makes the common case
— no agent running — the broken case).

---

## R7 — Storage

**Decision.** Two `better-sqlite3` databases in the app's data directory:
`mirror.db` (disposable) and `authored.db` (the user's). WAL mode, foreign keys
on, versioned forward-only migrations per database.

**Why two files, not two schemas.** XIII requires deleting the mirror to be safe.
As two files, "rebuild the mirror" is `fs.unlink` plus a resync, and a cascade
delete cannot reach authored data because no foreign key can span the files.
Cross-store references are by natural key (`jira:SITE/PROJ-123`,
`gh:owner/repo#451`, `repo:<canonical-remote>#<branch>`), which is what makes
FR-050 and SC-007 hold. The join happens in code, deliberately.

**Rejected**: one database with a naming convention (one careless `ON DELETE
CASCADE` destroys user data, and the constitution calls this out as needing to be
structural rather than conventional); an ORM (adds a migration system and a query
layer over a correlation problem that is mostly reads of small tables); keeping
the mirror purely in memory (a cold start would then require a full resync of
every provider before the board renders, which is the opposite of what a launcher
should feel like).

**Event-loop discipline.** `better-sqlite3` is synchronous and blocks whatever
loop it runs on. Per-call work stays small; a full correlation pass reads into
memory, computes as pure functions, and writes back in one transaction.

---

## R8 — Packaging (highest risk in the project)

**Decision.** Published npm package is a thin launcher: `bin/grndctrl` resolves
the Electron runtime, downloads it from GitHub releases on first run, verifies a
checksum, caches it per machine under a versioned path, then spawns the app.
Native modules ship as **prebuilds per platform/arch/ABI**, selected at first
run.

**The specific failure mode.** Electron's ABI differs from Node's — different
`NODE_MODULE_VERSION`, Chromium's BoringSSL instead of OpenSSL — so a
`better-sqlite3` built for Node throws at `require` time under Electron. Under
`npx`, that happens on a user's machine, not in CI, and the message it produces
names two version numbers and no remedy.

**Mitigation, and it is a task not a hope**: build prebuilds against the pinned
Electron ABI with `@electron/rebuild`; verify at launch that the loaded native
module's ABI matches the running runtime and fail with an actionable message if
not; and make "install from the packed tarball on a clean machine with a cleared
runtime cache, on all three platforms" an explicit acceptance task rather than
something confirmed by the fact that the developer's machine works.

**Rejected**: bundling the Electron runtime in the npm package (hundreds of
megabytes per platform); requiring a global Electron; shipping platform
installers instead of npx (contradicts the locked delivery decision, and npx is
the distribution the tool is designed around).

---

## R9 — Testing

**Decision.** Vitest across all packages. Three tiers, each with a different job:

- **Correlation unit tests over recorded fixtures** — no network, no Electron, no
  display. Every drift rule gets a test that fires it and a test that correctly
  declines to (XVIII, SC-003). Fixtures are checked-in JSON captured from real
  provider payloads with identifiers and titles scrubbed.
- **Adapter contract tests** — the registry-conformance test from R1, plus
  round-trip schema validation per operation, so IPC and MCP cannot drift apart.
- **Playwright end-to-end** on the Electron build for the golden path: launch,
  configure a project against a stubbed provider, board renders, click a row,
  open the notes modal, confirm a dispatch.

**Provider tests run against recorded HTTP fixtures**, not the live APIs — a test
suite that needs someone's Jira token is a suite that stops being run.

**Rejected**: Jest (slower on ESM/TS here, and the ecosystem has moved); testing
correlation through the UI (couples the one component that must stay
framework-free to the one that changes most).

---

## R10 — Build sequence

**Decision.** Headless first, in four milestones, each independently verifiable:

| M | Contents | Proven by |
|---|---|---|
| **M1 — Skeleton** | monorepo, core package, two databases, migrations, operation registry, settings, keychain seam | operations callable from a test; keychain round-trip on Windows |
| **M2 — The engine** | providers (Jira, GitHub, git), correlation, drift rules, severity, staleness, freshness records | fixture suite green with Electron uninstalled (SC-003, SC-004) |
| **M3 — Agent surface** | notes, sessions and heartbeat, outbox, HTTP adapter, `grndctrl-mcp` | an agent starts a session, writes a note, claims an action — with no UI in existence |
| **M4 — The shell** | Electron main, preload bridge, React renderer, lanes, Attention, modal, theming, launching, packaging | golden path on Windows; `npx` from a cleared cache |

**Why this order.** The correlation engine is both the differentiator and the
only place a subtle bug produces confident wrong output, and it is the cheapest
thing here to test properly. Proving it before spending on the shell means the
expensive component is built against something already known to work. M3 before
M4 also means the agent surface is designed as a first-class consumer rather
than retrofitted onto whatever the UI happened to need — which is the failure
mode XII exists to prevent.

**Accepted cost.** There is nothing to look at until M4, on a product whose value
is visual. Mitigated by a small CLI in M2 that prints the board as text — enough
to demo correlation, and useful afterwards for debugging fixtures.

---

## Sources

- [GitHub GraphQL `Ref.compare` — community discussion on comparing commits](https://github.com/orgs/community/discussions/153074)
- [GitHub GraphQL `Ref.compare` OAuth `repo` permission caveat](https://github.com/orgs/community/discussions/106598)
- [Jira Cloud REST v3 — Issue Search API group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/)
- [Jira search endpoint deprecation and migration to `/search/jql`](https://docs.adaptavist.com/sr4jc/latest/release-notes/breaking-changes/atlassian-rest-api-search-endpoints-deprecation)
- [Jira bulk changelog fetch — Atlassian developer community](https://community.developer.atlassian.com/t/bulk-fetch-changelogs-experimental-api/87240)
- [MCP resource subscriptions and `notifications/resources/updated`](https://modelcontextprotocol.info/docs/concepts/resources/)
- [MCP notification handling guidance](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1192)
- [`@napi-rs/keyring` — package and `Entry` API](https://github.com/Brooooooklyn/keyring-node)
- [Electron — using native Node modules and ABI rebuilds](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [`better-sqlite3` under Electron — ABI mismatch reports](https://github.com/WiseLibs/better-sqlite3/issues/704)
