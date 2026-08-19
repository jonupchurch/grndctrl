# Implementation Plan: the agent console

**Feature**: `007-agent-console` · **Date**: 2026-08-19

**Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md) · **Data model**: [data-model.md](./data-model.md) · **Tasks**: [tasks.md](./tasks.md)

---

## Summary

Four new regions and one cross-cutting behaviour, landing on the board [006](../006-remove-code-host-and-local-git/plan.md) empties: a lane of work that has been handed off, an active-ticket panel with the ticket's description, a terse agent-update panel, a click-to-copy prompt list, and collapse on every region.

**This is the first feature since 001 that adds.** Three new authored tables, three new registry operations, three new MCP tools, one new shell channel, one new provider field, and one new renderer subsystem (the description converter). Every one of those crosses a boundary that has been quiet for five releases, so the gates below do real work rather than being re-confirmed.

---

## Technical Context

| | |
|---|---|
| **Language / runtime** | TypeScript 5.6, Node 22, Electron 33, React 19 — unchanged |
| **New dependencies** | **None.** The ADF converter is written here; see [R1](./research.md#r1--the-ticket-description-is-not-a-string--changes-the-design) for why not a package. |
| **Storage** | authored **3** (three tables + settings), mirror **5** (one column) |
| **New shell capability** | clipboard write, via a channel — the first widening of the preload surface since 001 |
| **Sequenced after** | 006. Ships in the same release. |

---

## Constitution Check

### Part II — product and architecture gates

| Gate | Verdict |
|---|---|
| **XI** — no secrets outside the OS credential store | **Engaged, and worth stating.** Recorded prompts are free text an agent was given, and may contain a token somebody pasted. They are authored data in the operator's own local store — the same place a note would be — but the prompt panel puts them one click from the clipboard. No new secret path is created; no automated redaction is offered; the operator can delete a prompt. Recorded in the spec's edge cases rather than left to be discovered. |
| **XII** — everything reachable through the registry | **The gate that does the most work here.** Three new operations, and each arrives on IPC, loopback HTTP and MCP together. The clipboard is deliberately *not* an operation — it is a host affordance like opening a browser, and `channels.ts` already argues that distinction for `OPEN_CHANNEL`. Getting this wrong in the other direction (a private renderer path to the store) is the failure the gate exists to catch. |
| **XIII** — mirrored and authored separate | **Held.** All three new tables are authored and reference tickets by natural key. The active ticket survives a mirror rebuild pointing at a ticket that may not be there yet — which is FR-131's case, and is correct rather than a bug. |
| **XIV** — no provider data without its freshness | **Engaged by two new regions.** The handed-off lane and the active-ticket panel both render provider data and both need freshness. The description in particular: a ticket description shown without its age is the most convincing stale thing on the board, because it reads like a document. |
| **XV** — degrade honestly, never blank | **Four new regions, four new error boundaries.** Each of the new panels can fail on its own — an unparseable description, a store read, an empty agent surface — and none may take the board with it. |
| **XVI** — never hold write authority | **Not engaged, and worth saying why.** Setting the active ticket, posting an update and recording a prompt are all local writes to the operator's own store. Nothing here touches a provider. The distinction between "an agent can set this" and "an agent can act on your behalf" is exactly what XVI polices, and this is firmly the first. |
| **XVII** — Windows first-class | **Engaged by the clipboard**, which is the only genuinely platform-divergent thing here. Verified on Windows first. |
| **XVIII** — determinism | **Held.** Correlation gains one exclusion (tickets that are not the operator’s) and is otherwise untouched. The new state is authored and read, not derived. |

### Part I — process principles

- **Probe the gates.** The clipboard test must fail when the copy is broken — asserted by reading the clipboard back, not by asserting a handler ran (SC-017). The collapse test must fail when a region merely hides — asserted by counting elements, not by checking a class (SC-018).
- **Report what does not work.** Two of these four panels are **empty until an agent is configured to call them**. The completion report must lead with that, or it reports a feature that looks broken on first launch.

### Gate verdict

**Pass, with two live obligations**: XI is engaged by prompt content (documented, not mitigated away), and XII must not be routed around when the clipboard turns out to need one more thing.

---

## Project Structure

```
packages/core/src/
├── domain/types.ts              + ActiveTicket, AgentUpdate, Prompt; Ticket.description
├── domain/adf.ts                NEW — ADF → internal document nodes (R1)
├── providers/jira/index.ts      + 'description' in the field list
├── correlation/join.ts          + exclude not-mine tickets from work items (FR-124)
├── services/
│   ├── sync.ts                  + the second query; ONE write (FR-125, the R2 trap)
│   ├── focus.ts                 NEW — the active ticket
│   ├── updates.ts               NEW — agent updates, append + prune
│   └── prompts.ts               NEW — prompts, record + list + delete + prune
├── store/authored/              migration 3: three tables + settings
├── store/mirror/                migration 5: tickets.description
└── registry/ops/
    ├── focus.ts                 NEW — focus.get / focus.set / focus.clear
    ├── updates.ts               NEW — updates.list / updates.post
    ├── prompts.ts               NEW — prompts.list / prompts.record / prompts.delete
    └── work.ts                  + tickets.handedOff

packages/desktop/src/
├── shared/channels.ts           + COPY_CHANNEL
├── main/clipboard.ts            NEW — reads the prompt, copies what it read (FR-139)
├── preload/index.ts             + copy
└── renderer/
    ├── components/Section.tsx        NEW — the collapsible shell every region uses
    ├── components/Document.tsx       NEW — renders converted ADF (FR-129, FR-130)
    ├── panels/ActiveTicket.tsx       NEW
    ├── panels/AgentUpdates.tsx       NEW
    ├── panels/Prompts.tsx            NEW
    ├── lanes/HandedOff.tsx           NEW
    └── App.tsx                       the new layout

packages/mcp/src/tools/
├── focus.ts     NEW — grndctrl_set_active_ticket
├── updates.ts   NEW — grndctrl_post_update
└── prompts.ts   NEW — grndctrl_record_prompt

docs/agents.md   + the CLAUDE.md snippet that makes an agent actually call these
```

---

## Milestones

### M1 — Collapse, on the board that exists

`Section.tsx` and the settings field, applied to every region 006 leaves. Nothing else.

**Why first**: it touches every region, so doing it before there are four more regions is strictly less work. It is also independently useful and independently revertible, and it gets the "do not render when collapsed" decision tested before three new panels depend on it.

### M2 — The "no longer mine" lane

**Starts with one request against a real Jira**, not with code: does `/rest/api/3/search/jql` accept `assignee CHANGED FROM currentUser() AFTER -7d`? There is no client-side fallback ([R2](./research.md#-the-one-thing-that-must-be-verified-before-building)), so if the answer is no this milestone stops and becomes a conversation rather than an approximation.

Then the second query, the single write, the correlation exclusion, and the lane with its assignee column.

**Why second**: it is the only one of the four that needs nothing new from the agent surface, so it lands with no dependency on an agent being configured — and its one unknown is answerable in a minute.

### M3 — The active ticket

Two halves, and they are separable:

- **M3a — the pointer.** Authored state, three operations, one MCP tool, a panel showing key/summary/status and a link. Useful immediately.
- **M3b — the description.** The provider field, the mirror column, the ADF converter, the document renderer.

**Why split**: M3b is the largest single piece of new code in this feature and the only one with an unbounded input format. M3a is worth having on its own, and if M3b takes longer than expected it does not hold up the panel.

### M4 — Agent updates

Table, service with pruning, two operations, one MCP tool, panel. Absorbs the open question-for-human notes that lost their home in 006 (FR-135).

### M5 — Prompts and the clipboard

Table, service, three operations, one MCP tool, the `COPY_CHANNEL`, the preload widening, the panel.

**The care point**: the preload surface test. It asserts an exact set, and this is the first time in five releases that set has grown. The test is updated *deliberately*, with the addition named — never loosened to a subset check.

### M6 — Layout, docs, release

The final arrangement, the `CLAUDE.md` snippet in `docs/agents.md` without which two panels stay empty, and the release.

---

## Deferred decisions

| Deferred | Default | Cost to revisit |
|---|---|---|
| **A wider lane — everything not assigned to the operator** | No. Narrowed away from explicitly; it is the export the scoping rule exists to prevent. | One JQL clause, a cap, and an argument about noise. |
| **A window other than seven days** | Seven | A constant. Worth revisiting after a fortnight of use. |
| **More than one active ticket** | One | A list rather than a value; the operations already take a key. |
| **Editing prompts** | Record and delete only | An update operation. |
| **Prompt search or pinning** | Neither | The panel is bounded and newest-first; search matters at a size this will not reach soon. |
| **Whether an update can be dismissed** | No — pruned by retention, not by hand | A resolved flag. |

---

## Complexity Tracking

### Tracked risks

| Risk | Why it is real here | Mitigation |
|---|---|---|
| **The second query wipes the first** | `replaceTickets` deletes by connection. Two writes means the second discards the first, and the symptom is a lane empty on alternate syncs. | One concatenated write (FR-125). The test asserts both sets present *after a sync*, not that both queries ran. |
| **The query silently drops the unassigned ones** | JQL `!=` does not match an empty field. The lane still returns rows, so nothing looks wrong. | FR-123a, and SC-021 asserts the unassigned case **separately** from the reassigned one. |
| **These tickets leak into the counts** | Six places consume work items. Excluding at each is six chances to miss one. | Exclude once, at the top of `correlate`. SC-014 asserts no number moves. |
| **The tracker refuses history operators** | `CHANGED` is changelog-backed and the enhanced endpoint has restricted things before. There is no fallback. | Verified as the first task of M2, before any code is written. |
| **The description renders as markup** | It arrives from the least trusted source in the application, and the fastest way to ship it is `dangerouslySetInnerHTML`. | FR-129, and the CSP would break it anyway — but the CSP is not the reason, it is the backstop. The converter emits nodes, never strings-that-are-markup. |
| **A description node is silently dropped** | A whitelist converter's natural failure is to ignore what it does not know, and the missing node is usually the acceptance criteria. | FR-130: unsupported nodes render as a labelled placeholder. Test with a deliberately unknown node type. |
| **The clipboard copies nothing, silently** | The most likely failure and the least visible one — indistinguishable from success until a paste. | SC-017 reads the clipboard back. The channel returns a result and the row acknowledges it. |
| **The preload surface is loosened rather than widened** | The test asserts an exact set. The quickest fix when it fails is to relax the assertion. | The test is updated by naming the new property, and this risk is written here so a reviewer knows to check which of the two happened. |
| **Two panels ship empty and look broken** | Updates and prompts arrive only when an agent calls them, and no agent will without configuration. | Empty states explain what fills them (FR-141); `docs/agents.md` carries the snippet; the completion report leads with it. |
| **An append-only table grows forever** | An agent on a loop posts updates indefinitely. | Bounded per session, pruned on write (FR-133) — no scheduler to fail to run. |

### Not tracked

- **Bundle size from the converter.** ~150 lines against a 279 KB bundle.
- **Clipboard permission prompts.** `clipboard.writeText` in main needs none on any of the three platforms.

---

## Post-design constitution re-check

Re-run after the data model and contracts.

**One thing changed.** The first pass treated the clipboard as the interesting boundary. Writing the contracts made it clear that the interesting boundary is **XII and the three new operations**: the clipboard is one narrow channel with an established precedent, while `focus.set` is an agent-writable piece of application state that has to arrive identically on three surfaces and be exposed correctly on each. An operation whose exposure is wrong is the failure that puts something on the wrong surface, and this feature adds three of them — the first since 001.

**Also confirmed**: `focus.set` does not engage XVI. It writes a local pointer, not a provider. Stated in [R3](./research.md#r3--where-does-active-ticket-live-and-who-may-set-it) so nobody has to re-derive it while reviewing an agent-writable operation.
