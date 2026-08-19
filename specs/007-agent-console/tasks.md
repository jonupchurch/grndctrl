# Tasks: the agent console

**Feature**: `007-agent-console` · **Date**: 2026-08-19

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Quickstart**: [quickstart.md](./quickstart.md)

**Starts after [006](../006-remove-code-host-and-local-git/tasks.md) M6.** Same branch, same release.

---

## Organization — cheapest cross-cutting change first, then one region at a time

Unlike 006 there is no risk of a red tree here: every milestone adds and nothing depends on the next. The ordering is chosen for a different reason — **each milestone is a region the operator can look at and judge**, and the two that depend on an agent being configured come after the two that do not.

## Format: `[ID] [P?] Description`

- **[P]** — may run in parallel with others marked `[P]`; different files, no ordering.
- Every task names its files.
- **New assertions must be made to fail before they are relied on.** Two here are specifically prone to passing vacuously: the clipboard test (asserting a handler ran rather than that the clipboard holds the text) and the collapse test (asserting a class rather than that the contents are absent).

---

## Phase 1: M1 — Collapse, on the board 006 leaves

Applied to the existing regions first, so the four new ones inherit it rather than retrofitting it.

- **T101** `components/Section.tsx` — the collapsible shell: header, count slot, freshness slot, a real `<button>` with `aria-expanded` and `aria-controls`, and children rendered **only when expanded** (FR-143, [R6](./research.md#r6--what-does-collapsible-mean-to-the-tests)).
- **T102** `services/settings.ts` + authored migration **3** (settings half only) — `collapsedRegions: Record<string, boolean>`, unknown keys ignored on read.
- **T103** Adopt `Section` in the ticket lane, the session lane, the ball-in-court panel, the tile row and the connection notice. Region ids are **stable literals**, never generated — a generated id changes between builds and silently expands everything the operator folded.
- **T104** A collapsed lane keeps its count and freshness in the header (FR-145). Collapsing is "not reading this now", not "stop telling me".
- **T105** Tests: collapse each region, restart, still collapsed; contents **absent** from the page, asserted by counting elements. **Probe it** — implement with `display: none` and confirm the test fails. If it passes, the test is checking a class and is worthless.
- **T106** Check `perf.spec.ts` and `greyscale.spec.ts` still count what they think they count. This is the regression the "do not render" decision exists to prevent, and the repo has had it once before with `lane__headings`.

---

## Phase 2: M2 — The unassigned lane

Needs nothing from the agent surface.

- **T107** `services/sync.ts` — the second query: `project IN (…) AND assignee IS EMPTY AND statusCategory != Done ORDER BY created DESC`, capped. **Both result sets concatenated into one `replaceTickets` call** — the [R2](./research.md#r2--can-the-unassigned-lane-share-the-tickets-table-yes-and-the-reason-is-neat) trap. Two writes and the second discards the first.
- **T108** **Probe T107 first, not after.** Write the two queries as two writes, confirm the test catches it, then fix it. This bug's symptom is a lane empty on alternate syncs — the kind that reaches a bug report as "sometimes it does not work".
- **T109** `correlation/join.ts` — exclude `assignee === null` tickets from work items, **once, at the top** (FR-124). Six consumers would otherwise each need to remember.
- **T110** `registry/ops/work.ts` — `tickets.unassigned`, envelope, `providerDerived`, carrying its cap alongside the rows ([operations.md](./contracts/operations.md#ticketsunassigned)).
- **T111** `renderer/lanes/Unassigned.tsx` — a lane on `Section`, newest first, obeying the project filter, stating its cap, rows opening at the tracker.
- **T112** SC-014: add fifty unassigned tickets to a scenario and assert **no** headline count, tile or ball-in-court number moves. This is the assertion that the reversal stayed scoped to a lane.
- **T113** Update `docs/` and the sync comment. The comment in `sync.ts` currently argues *against* fetching anything but the operator's own work; it is still right about the ticket lane and must be rewritten to say so rather than deleted, or the next reader will re-derive the wrong conclusion.

---

## Phase 3: M3a — The active ticket, without the description

- **T114** `domain/types.ts` + authored migration 3 — `active_ticket`, single row by CHECK.
- **T115** `services/focus.ts` — get, set, clear. `setBy` derived from the caller's context, **never taken as input** ([operations.md](./contracts/operations.md#focusget--focusset--focusclear)).
- **T116** `registry/ops/focus.ts` — three operations, all exposure `all`. **This is the exposure that must not be `ui-only`**: the operator's brief was "populated by MCP".
- **T117** `packages/mcp/src/tools/focus.ts` — `grndctrl_set_active_ticket`, with a description that says *when* to call it, not what it does.
- **T118** `main` + preload — the `focusChanged` push event.
- **T119** `renderer/panels/ActiveTicket.tsx` — key, summary, status, link to the tracker, on `Section`, scrollable. Empty state offers the operator a way to set one from a ticket row (FR-131, US1 scenario 6) — an empty panel with no way to fill it is a dead region.
- **T120** FR-131: an active ticket the mirror does not hold shows what is known and names what is not, and **does not fetch**. Test with a key that is in no scenario.

## Phase 3: M3b — The description

The largest single piece of new code here, and separable from M3a.

- **T121** `providers/jira/index.ts` — add `description` to the field list. Fixed id, unlike story points; one line.
- **T122** Mirror migration **5** — `tickets.description TEXT`, nullable, no default.
- **T123** `domain/adf.ts` — the converter. Whitelist per [R1](./research.md#r1--the-ticket-description-is-not-a-string--changes-the-design); everything outside it becomes `unsupported` carrying the original node name (FR-130).
- **T124** Convert **at ingest**, in the provider, not at render. A conversion failure then is one line in a sync log; at render it is a blank panel.
- **T125** `renderer/components/Document.tsx` — renders converted nodes as React elements. **No `dangerouslySetInnerHTML`, no HTML strings, no exceptions.** Links inside a description are provider-supplied URLs and go through `links.resolve` like every other URL in this application.
- **T126** A test per supported node kind, plus one deliberately unknown type asserting the labelled placeholder. **Probe it**: make the converter drop unknown nodes instead and confirm the test fails — silent dropping is this component's characteristic failure and the one that loses an acceptance-criteria section.
- **T127** SC-016: a description with a table, a code block, a mention and an unsupported node renders all four legibly with no markup on the page.

---

## Phase 4: M4 — Agent updates

- **T128** Authored migration 3 — `agent_updates` with its index.
- **T129** `services/updates.ts` — append, and **prune inside the same write** (FR-133). No scheduler, because a scheduler is a thing that can fail to run.
- **T130** `registry/ops/updates.ts` — `updates.list`, `updates.post`. `text` bounded at the schema, `agentId` and `ticketKey` filled by the service.
- **T131** `packages/mcp/src/tools/updates.ts` — `grndctrl_post_update`, with the description that distinguishes it from heartbeat, activity and `reportedStatus` ([mcp-tools.md](./contracts/mcp-tools.md#grndctrl_post_update)). Four things now live in that neighbourhood and an agent has to be able to pick.
- **T132** `renderer/panels/AgentUpdates.tsx` — text, agent, age. **Nothing else** (FR-134). No card, no border, no icon, no menu. The operator asked for terse and terse is a design constraint, not a default.
- **T133** Open `question-for-human` notes surface here (FR-135). This is 006's FR-121 coming due — the effect on ball-in-court never left, and this is where the display lands.
- **T134** `updatesChanged` push event.

---

## Phase 5: M5 — Prompts and the clipboard

- **T135** Authored migration 3 — `prompts` with its index.
- **T136** `services/prompts.ts` — record, list, delete, prune on write.
- **T137** `registry/ops/prompts.ts` — three operations. **`prompts.delete` is `ui-only`**; the other two are `all`. Curating the operator's history is not an agent's business.
- **T138** `packages/mcp/src/tools/prompts.ts` — `grndctrl_record_prompt`.
- **T139** `shared/channels.ts` + `main/clipboard.ts` — `COPY_CHANNEL`. Takes a **prompt id**, reads that prompt, copies what it read (FR-139). The renderer never supplies the string.
- **T140** `preload/index.ts` — add `copy`. **Update `test/preload-surface.test.ts` by naming the new property**, never by relaxing it to a subset check ([ipc-channels.md](./contracts/ipc-channels.md#the-surface-before-and-after)). The wrong fix looks entirely reasonable in a diff and would permit every future addition too.
- **T141** `renderer/panels/Prompts.tsx` — newest first, truncated preview, click to copy, visible confirmation. Delete control. Empty state explaining what records a prompt (FR-141).
- **T142** SC-017: click a prompt and **read the clipboard back**. Probe it by breaking the copy and confirming the test fails — a test that asserts the handler ran is exactly the vacuous test this one exists instead of.
- **T143** Assert a long prompt copies **whole** (FR-138). Truncated-copy fails at the paste, a long way from the click.
- **T144** `promptsChanged` push event.

---

## Phase 6: M6 — Layout, docs, release

- **T145** `App.tsx` — the final arrangement: tickets, unassigned, active ticket, agent updates down the main column; sessions, ball-in-court, prompts down the side. Four new `LaneBoundary` wrappers (XV).
- **T146** **Look at it running**, populated, with every region expanded, and then with several collapsed. Seven regions is a lot of page; this is where the layout is judged, not in a mockup.
- **T147** [P] `docs/agents.md` — the `CLAUDE.md` snippet without which two panels stay empty. **This is part of the feature, not documentation of it.**
- **T148** [P] README and the package descriptions — the product is a ticket-and-agent console now.
- **T149** [P] `scripts/audit-egress.ts` — confirm nothing new contacts anything. Two new tables and a clipboard channel should not, and "should not" is what an audit is for.
- **T150** Scenario fixtures gain unassigned tickets, an active ticket, updates and prompts, with relative timestamps ([006 FR-118](../006-remove-code-host-and-local-git/spec.md#test-material)).
- **T151** CHANGELOG — 006's removals and 007's additions in one entry, breaking changes at the top.
- **T152** STATUS.md, version cut, release.

---

## Dependencies & Execution Order

```
006 M6 ─→ M1 (collapse) ─→ M2 (unassigned) ─→ M3a ─→ M3b ─→ M4 ─→ M5 ─→ M6
                                                └── M4 and M5 do not depend on M3b
```

M1 first because it touches every region and there are fewer of them now than there will be. M2 before the agent panels because it needs no agent to demonstrate. M3b is separable from everything after it.

### Critical path

T101 (Section) → T103 (adopt it) → T107/T108 (the one write, probed) → T116 (exposure) → T123 (converter) → T139/T140 (channel and surface) → T146 (**look at it**) → T152.

### Parallel opportunities

- T147–T149 (docs and audits).
- Within M4 and M5, the store/service/operation/tool chains are independent of each other up to the panels.

---

## Implementation Strategy

**Why collapse comes first.** It is the only cross-cutting change here, and every region added afterwards inherits it for free. Doing it last means retrofitting nine regions instead of five, and means the "do not render when collapsed" decision gets tested after three new panels have already been built assuming something else.

**Why the description is split out.** M3b is the only unbounded input in this feature — a description can contain anything Atlassian ships — and it is the only part with a real chance of taking longer than planned. M3a is a working panel without it.

**What "done" looks like.** SC-013 through SC-020 in [spec.md](./spec.md#success-criteria-mandatory), each with a named check in [quickstart.md](./quickstart.md).

**And what the completion report must say first**: two of these four panels are empty until an agent is configured to call the new tools. Nothing in this application can make an agent cooperate. A report that opens with "four new panels, all tests green" describes a board that, on the operator's machine, has two blank regions on it.
