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

- One work lane, plus the session lane. No empty pull-request lane, no collapsed branch lane, no Attention region — search the DOM and find nothing.
- Three tiles, not four. The DRIFTING tile is gone with what fed it.
- **This is the thin board**: three tiles, one lane, two side panels. That is the intended intermediate state and it is what [007](../007-agent-console/quickstart.md) fills. Judge the direction here, not the layout.
- Settings → Projects: no repository field, no checkout paths, no GitHub connection selector.
- Settings → Connections: one provider kind, and no screen naming a GitHub permission.

**Two traps to check for explicitly.**

The error boundaries: there should still be one per remaining region. Attention had one and Attention is going, so it is easy to conclude the pattern went with it. It did not — see [ipc-channels.md](./contracts/ipc-channels.md#what-must-not-be-removed-along-with-the-lanes), and 007 adds four more regions that need it.

The `notes.questions` query: Attention rendered the open question-for-human nudges, so deleting the component makes the query look orphaned. It is not — ball-in-court reads the same set, and 007's update panel is where the display lands. Removing it here silently breaks FR-121 and nothing fails.

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

- No input produces a drift finding, because there is no rule left to produce one.
- **Check what left with it.** The outbox's eight operations still registered. `notes.questions` still queried. An open question-for-human note still driving ball-in-court to the operator. Every dismissal row still in `authored.db`. This is the milestone's real risk — not that drift fails to leave, but that it takes a passenger.
- Severity keeps every contribution except `inDrift`, unchanged, for the same inputs. A "tidy" rebalance while in there would be an undocumented product change.
- Determinism holds: run correlation twice over unchanged fixtures and compare.

---

## M4 — The store

The one that can lose data.

```
# Against the 0.3.0 database captured in T003
npm run verify
```

- Every authored row present after upgrade: projects, notes, sessions, outbox actions, dismissals, settings. **By count and by content.** The dismissals especially — they have no reader after this change, which makes deleting them look like tidiness (FR-122).
- The repository-only project is still there and is shown as incomplete rather than as working.
- Every outbox row is still in its state, and a pending action is still claimable.
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
7. Add a `question-for-human` note to a ticket; ball-in-court moves to you. *(Its display lands in [007's](../007-agent-console/quickstart.md) update panel — after 006 alone it has an effect and no visible home, which is why the two ship together.)*

At no point is a GitHub token requested, a repository named, or a checkout path asked for.
