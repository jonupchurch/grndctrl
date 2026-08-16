# Quickstart — Verifying Ground Control v1

**Feature**: `001-ground-control-v1` · **Date**: 2026-08-14 · **Plan**: [plan.md](./plan.md)

How to prove each milestone actually works, in the order the work is built
(research [R10](./research.md#r10--build-sequence)). Every milestone below is
independently verifiable — no step needs the milestone after it.

**Verify on Windows first.** Not out of preference: Windows is the primary
development machine, so a POSIX-only assumption is an immediate break, not a
portability nicety (XVII).

---

## Prerequisites

- Node 22+ and npm 10+
- Git on `PATH` (the app spawns the operator's own git — [R4](./research.md#r4--local-git-read-only))
- A working OS credential store: Windows Credential Manager, macOS Keychain, or
  libsecret. **No fallback exists** — this is the intended behaviour (FR-006)
- For live-provider checks only: a Jira Cloud API token and a GitHub PAT.
  Everything below except the marked live steps runs against checked-in fixtures

```
npm install
npm run build
```

---

## M1 — Skeleton

**Proves**: the two-database split, migrations, the registry, and the keychain
seam.

```
npm run test -w packages/core -- store migrations registry
npm run keychain:roundtrip -w packages/core     # writes, reads, deletes a dummy secret
```

**Expect**:

- `mirror.db` and `authored.db` created as **separate files** in the per-user
  data directory, each with its own version table.
- The keychain round-trip returns the value it stored, then `null` after delete.
  On Windows the entry is visible in Credential Manager under the app's service
  name.
- The registry conformance test passes with zero operations registered — it must
  be green *before* there is anything to conform to, or it is not a gate.

**The check that matters** (XIII, SC-007): seed a note, delete `mirror.db`,
relaunch.

```
npm run test -w packages/core -- mirror-rebuild
```

The note is still there, still attached, with its content intact.

---

## M2 — The engine

**Proves**: correlation, drift, severity, staleness, ball-in-court — the whole
differentiator — with **Electron uninstalled** (XVIII).

```
npm uninstall -w packages/desktop electron        # or run in a container without it
npm run test -w packages/core -- correlation drift
npm run test:coverage -w packages/core
```

**Expect**:

- The full fixture suite green with no network, no display, and no Electron
  resolvable (SC-003).
- **Every drift rule D1–D9 has a firing test and a declining test.** A rule with
  only a firing test is not covered — it can fire on everything and still pass.
- Ten consecutive runs produce byte-identical output including finding
  identifiers (SC-004):

```
npm run test:determinism -w packages/core
```

**See it as a human**, which is what `packages/cli` is for:

```
npx grndctrl-cli board --fixtures fixtures/scenarios/merged-pr-open-ticket
```

Prints the lanes as text with severity, staleness, and ball-in-court. The
scenario above must show exactly one D1 finding, naming both the ticket and the
PR.

**Live provider check** (optional, needs tokens):

```
npx grndctrl-cli providers:probe --jira <site> --github <owner>/<repo>
```

Confirms the two findings from Phase 0 hold in reality:

- Jira paginates on `nextPageToken` and returns **no `total`** — the probe prints
  "fetched N (no server-side total)" rather than a count ([R2](./research.md#r2--jira-acquisition--changes-the-design)).
- The GitHub compare probe succeeds. If it fails with a permission error while
  everything else works, the token lacks `repo` scope — the exact failure the
  connection test is built to catch ([R3](./research.md#r3--github-acquisition--changes-the-design)).

---

## M3 — The agent surface

**Proves**: notes, sessions, and the outbox work end to end with **no UI in
existence**.

Start the headless core, then point an MCP client at it:

```
npm run dev:headless -w packages/core           # writes the handshake file
npx @modelcontextprotocol/inspector npx grndctrl-mcp
```

**Expect**, in the inspector:

1. `grndctrl_get_board` returns work items, each carrying a **freshness
   envelope** with absolute timestamps (XIV). A resource never synced reads
   `never`, not `stale`.
2. `grndctrl_add_note` with type `question-for-human` — then
   `grndctrl_get_board` shows that work item's ball-in-court as the operator.
3. `grndctrl_start_session`, wait past 3× the heartbeat interval, then
   `grndctrl_get_board`: the session reads **silent** (FR-042). Send one
   heartbeat: it returns to running, and **no second session appears**.
4. `grndctrl_list_pending_actions` is empty, and **`grndctrl_enqueue_action`
   does not exist** — an agent cannot queue work for itself. This absence is the
   test.

**The durability check** (SC-008), which is the one worth being fussy about:

```
npm run test -w packages/core -- outbox-durability
```

Confirm an action with no agent connected → restart the core → connect an agent
→ it lists, claims, and completes it. Then assert the negative: a second claim
returns `conflict`, and a claim allowed to expire returns the action to
`pending` with the attempt recorded in `history`.

**The gate that guards XVI**:

```
npm run test -w packages/core -- no-auto-dispatch
```

Asserts no module under `services/sync`, `correlation`, or `drift` can reach
`outbox.mintConfirmation` — so no sync, rule, or timer can dispatch, by
construction rather than by care (FR-060).

---

## M4 — The shell

**Proves**: the Electron app, the isolation boundary, and packaging.

```
npm run dev -w packages/desktop
```

**Golden path**, on Windows first:

1. Launch with nothing configured → an empty state that **explains what a
   project is**, not an error and not a blank page.
2. Add a Jira connection and a GitHub connection; run `connections.test` on each.
   The GitHub test reports the **compare probe** separately from authentication.
3. Add a project: Jira project + repo + a local checkout path. Include a path
   **with a space and a non-ASCII character** — that is the case that breaks
   (FR-087).
4. The board renders: four stat tiles, Attention, three lanes, sessions, ball in
   court. Every lane shows its freshness.
5. Click one row of each type. Each opens the right page in the default browser
   and the app **does not navigate**.
6. Click an unpushed branch → the repository page opens (FR-076).
7. Open the notes modal, add a note, see the row's count change.
8. Activate a drift finding's action → a confirmation appears → confirm → the
   action shows as **pending**, and says plainly that nothing is listening yet.

**Isolation is real** — in the renderer console:

```
window.require   // undefined
process          // undefined
Object.keys(window.grndctrl)   // exactly the enumerated methods; no `invoke`
```

**Degradation** (XV, SC-005) — revoke the Jira token while the app is running:

- The ticket lane shows its last data marked **failed to refresh**, with the
  reason and the age of the last good data.
- PRs, branches, and sessions stay live and interactive.
- The distinction between *stale* and *failed* is visible, not inferred.

**Automated**:

```
npm run test:e2e -w packages/desktop
```

---

## Packaging — the riskiest path in the project

Do this on a **clean machine** (or a fresh container/VM) with the runtime cache
cleared, on all three platforms. A developer machine that already works proves
nothing here ([R8](./research.md#r8--packaging-highest-risk-in-the-project)).

```
npm pack -w packages/launcher
npx ./grndctrl-<version>.tgz
```

**Expect**: the Electron runtime downloads from GitHub releases, its checksum
verifies, `better-sqlite3` loads against the **matching ABI**, and the app opens.

**The failure this is built to catch**: a native module built for Node throws at
`require` time under Electron, on a user's machine, with a message naming two
version numbers and no remedy. Verify the guard, don't just hope for the happy
path:

```
npm run test:abi-guard -w packages/launcher
```

Deliberately mismatch the ABI and confirm the launcher fails with an actionable
message naming the expected and actual runtime — not a raw Node error.

---

## The privacy checks

Run before calling v1 done. These are the promises that cost the most to break.

**No credential on disk** (XI, SC-011) — after a full session with a known
sentinel token:

```
npm run audit:secrets -- --sentinel <the-token-value>
```

Searches the app data directory, both databases, every log, and the handshake
file. **Zero hits** is the only pass.

**No unexpected egress** (XI, SC-010) — capture traffic for 30 minutes of normal
use:

```
npm run audit:egress
```

Only the configured provider hosts, plus the GitHub releases host on first run.
No telemetry, no analytics, no crash reporter, no update ping.

**No network git** (FR-017) — assert the allow-list directly:

```
npm run test -w packages/core -- git-allowlist
```

Every git invocation in the codebase resolves to an allow-listed read-only
subcommand. `fetch`, `pull`, `push`, and `remote update` are absent, and adding
one fails the test.
