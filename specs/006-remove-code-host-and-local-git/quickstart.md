# Quickstart — Verifying the removal

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19 · **Plan**: [plan.md](./plan.md)

How to prove each milestone actually happened, in the order the work is built. Every milestone below is independently verifiable — no step needs the milestone after it.

**Verify on Windows first**, as always (XVII). This change removes the single largest source of Windows-specific complexity in the tree — git path handling — so the risk here is not that Windows breaks but that nobody notices it got easier.

---

## Prerequisites

- Node 22+, npm 10+
- **No GitHub credential anywhere on the machine.** This is not a precaution, it is part of the test: SC-010 says the operator can complete this quickstart with none present. If one is in the keychain from earlier use, remove it first and confirm the application never asks for it.
- A Jira site, an API token, and a project with a few issues assigned to you — or, for every step except the last, nothing at all: the seeded scenarios need no credential.

---

## Before you start — the baseline (T002)

```
npm run verify
cd packages/desktop && npx playwright test
```

Record what fails **now**, on `main`. Three `greyscale.spec.ts` tests fail because `every-severity.json` carries absolute 2026-08-14 timestamps and severity derives partly from staleness. If you do not write this down before you start, you will spend an hour on it in M5 believing you caused it.

---

## M1 — The board becomes what it will be

```
npm run build
cd packages/desktop && node scripts/seed.mjs --dir <scratch> --scenario ../../fixtures/scenarios/<scenario>.json
GRNDCTRL_DATA_DIR=<scratch> npx electron .
```

**Look at it.** This is the milestone whose verification is a human one.

- One work lane, plus the session lane. No empty pull-request lane, no collapsed branch lane, nothing hidden — search the DOM and find nothing.
- Attention beneath the tickets, panels beside them. Does the two-column layout still hold with one lane in the main column? *This is [a deferred decision](./plan.md#deferred-decisions); decide it here.*
- Settings → Projects: no repository field, no checkout paths, no GitHub connection selector.
- Settings → Connections: one provider kind, and no screen naming a GitHub permission.

**The trap to check for explicitly**: open the error boundaries. There should still be one per lane and one around Attention. If they were removed as "obviously redundant now", gate XV has been quietly dropped — see [ipc-channels.md](./contracts/ipc-channels.md#what-must-not-be-removed-along-with-the-lanes).

---

## M2 — The adapters

No shell needed.

```
npm run verify
node --experimental-strip-types packages/cli/bin/grndctrl-cli.js board --dir <scratch>
```

- The CLI board prints one lane.
- Ask the registry for a removed link target and confirm it is an **error**, not a fallback to the ticket page. A silent fallback is the failure mode here: the caller gets a URL, believes it, and opens the wrong page.
- Start an MCP session with `workspaceKey` set and confirm the rejection is explicit. If it is accepted and ignored, FR-115 has not been met.

---

## M3 — The engine

```
npm run verify
```

- The three surviving drift rules fire against ticket-and-session fixtures; the six retired ones cannot be produced by any input.
- **Check the wording** of D2's and D3's summaries. They named branches and pull requests in text the operator reads; a rule that still says "with no branch, PR, or session" while only checking sessions is a rule that lies in the one place the operator looks.
- Determinism holds: run correlation twice over unchanged fixtures and compare, including finding identifiers.
- `severity.test.ts` asserts all four bands reachable (FR-104) — not by argument, by fixture.

---

## M4 — The store

The one that can lose data.

```
# Against the 0.3.0 database captured in T003
npm run verify
```

- Every authored row present after upgrade: projects, notes, sessions, outbox actions, dismissals, settings. **By count and by content.**
- The repository-only project is still there and is shown as incomplete rather than as working.
- A finding dismissed before the upgrade is still dismissed after it.
- The removed connection's secret is **gone from the OS keychain**. Check the keychain directly — this is the assertion most easily satisfied by a test that only checks the row is gone.
- Run the upgrade twice. The second run writes nothing.

**Probe it** (T046): make the `projects` copy drop a row, confirm the test fails, put it back. A migration test that has never failed has never been tested.

---

## M5 — Fixtures and the greyscale fix

```
cd packages/desktop && npx playwright test
```

- **Green, including the three greyscale tests.** That is SC-008 and it is the visible sign this change left the suite better than it found it.
- Then the probe that matters (T051): advance the clock — the machine's, or the injected `now` — by a week and run the severity scenario again. All four severities still present. The old fixture fails this by construction, which is why it has been failing since 2026-08-17.

---

## M6 — Audits, docs, release

```
npm run audit:deps
npm run audit:egress
GRNDCTRL_CLIENT_DENYLIST="$(cat .client-denylist)" node --experimental-strip-types scripts/run-audits.ts client --scope tree
```

- Egress: one provider host allowed. **`github.com` and `objects.githubusercontent.com` still allowed as first-run entries** — if they are gone, a fresh install cannot download its native module, and the failure will appear at first launch on someone else's machine.
- No child process anywhere in the shipped tree (FR-100).
- README, `docs/agents.md`, `.env.example` and all four package descriptions: none still claims PR, CI, branch or checkout correlation.

Then the release path: `npm run verify`, a **dry run of the release workflow against the branch** — the only way to exercise the client-reference audit over full history before the one-way door — then merge, tag, push.

---

## The end-to-end check (SC-010)

On a machine with **no GitHub credential of any kind**:

1. Fresh install, fresh data directory.
2. Add one Jira connection with an API token.
3. Bind one project: a ticket project, a short code, a documentation URL.
4. Sync.
5. Tickets appear. Freshness reports one provider and a real age.
6. Start an agent session against one of them over MCP; it appears in the session lane and takes its turn in ball-in-court.
7. Let the session run past the threshold without moving the ticket; D7 appears in Attention.
8. Dismiss it. Restart. It stays dismissed.

At no point is a GitHub token requested, a repository named, or a checkout path asked for.
