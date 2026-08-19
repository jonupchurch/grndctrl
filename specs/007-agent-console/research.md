# Phase 0 — Research: the agent console

**Feature**: `007-agent-console` · **Date**: 2026-08-19 · **Spec**: [spec.md](./spec.md)

Six questions, each answered from the code in this repository or from what the provider actually returns. Two of them change the design.

---

## R1 — The ticket description is not a string ⚠ CHANGES THE DESIGN

The active ticket panel is *scrollable*, which is only interesting if it holds something long. The only long thing on a ticket is its description, and this application has never fetched one.

**Jira Cloud's REST v3 returns `description` as ADF** — Atlassian Document Format, a JSON document tree of nodes (`paragraph`, `text`, `bulletList`, `codeBlock`, `table`, `mediaSingle`, `mention`, `inlineCard`, …), not a string and not markdown.

There are three ways to get renderable content, and two of them are wrong here.

| Approach | Verdict |
|---|---|
| `expand=renderedFields` — Jira renders the description to **HTML** | **Refused.** The renderer's CSP is `default-src 'none'`, nothing in this codebase uses `dangerouslySetInnerHTML`, and note bodies render as text in a `<p>`. Injecting provider HTML would be the first raw-markup path in the application, from the least trusted source it has. |
| Pull in an ADF renderer package | **Refused.** Atlassian's renderers pull a large React tree and their own styling. This application has four production dependencies and a bundle it controls. |
| Convert ADF to a small internal node type and render it with React elements | **Chosen.** |

**The conversion is a whitelist, and the whitelist has a fallback with a name.** Supported: paragraph, heading, text with marks (strong, em, code, link), bullet and ordered lists, code blocks, blockquote, rule, hard break, table (as a simple grid), mention (as text), inline card (as a link). Everything else — media, panels, expands, extensions, anything Atlassian ships next year — becomes a labelled placeholder saying what it was (FR-130).

**A dropped node is the failure mode to avoid.** A description whose "Acceptance criteria" section was a panel node, silently omitted, is a ticket that reads complete and is not. The placeholder is ugly on purpose.

**Link marks are still links, and links are still `links.resolve`'s problem.** A link inside a description is a provider-supplied URL, which FR-077 says is opened only over `https` and only after checking. It goes through the same path as everything else; it does not become an `<a href>` the renderer builds itself.

**Cost**: one extra field on the ticket search (`description`), a wider mirror column, and a converter of perhaps 150 lines with a test per node kind. The search already names fields explicitly, so adding one is a one-line change — and unlike the story-point field it has a fixed id.

---

## R2 — The lane is work that was taken off your plate

**Settled by the operator on 2026-08-19, in two corrections.** The label on the screenshot said *"Recent Tickets not assigned"*, which read as "the backlog". It is not. Their words: *"we only want to track items that WERE assigned to me and now are not"*, then *"and only the last 7 days"*.

That is a different feature from the one the label suggested, and a much better one. It is not a view of the tracker; it is **the tail of the operator's own work** — what was handed to somebody else, or dropped on the floor, in the last week. The thing you want to notice is a ticket you thought you were still holding that quietly became someone else's.

**It therefore barely reverses the standing rule at all.** `sync.ts` argues that "a command station is the work you are holding, not an export of the tracker"; this lane is work the operator *was* holding. The rule survives intact and the earlier draft of this research — which planned for hundreds of rows, a hard cap and an assignee column to make them actionable — was solving a problem that no longer exists.

### The query

```
project IN (…)
AND assignee CHANGED FROM currentUser() AFTER -7d
AND (assignee != currentUser() OR assignee IS EMPTY)
ORDER BY updated DESC
```

Three clauses, each load-bearing:

- **`CHANGED FROM currentUser() AFTER -7d`** is the whole feature. It reads the issue's *history*, not its current state, which is the only way to ask this question at all.
- **`(assignee != currentUser() OR assignee IS EMPTY)`** excludes tickets that came back. Without it, a ticket reassigned away on Monday and back to the operator on Tuesday sits in both lanes.
- The `AFTER -7d` bound makes the result set small by construction. **No cap is needed** — this is the operator's own recent work, not a slice of a backlog — and a cap would be the wrong instrument anyway, since truncating *this* list hides exactly the row worth seeing.

### ⚠ The one thing that must be verified before building

**JQL's history operators may not be available on the enhanced search endpoint.** `CHANGED`, `WAS` and `WAS IN` are backed by the issue changelog, and this application uses `/rest/api/3/search/jql` — the replacement for the deprecated `/search`, which came with its own restrictions (R2 of 001 found two already).

**There is no fallback.** Changelogs are fetched by `/rest/api/3/changelog/bulkfetch`, which takes issue keys — and the keys of tickets reassigned away are precisely the ones this application no longer has, because the assignee-scoped query stopped returning them. The history cannot be searched from the client side.

So: **verify this against a real Jira before writing anything else in M2.** It is one request. If `CHANGED` is refused there, the lane cannot be built as specified and the operator has to be told rather than handed an approximation — the nearest approximation, "everything not assigned to me", is the export the standing rule exists to prevent, and is the reading they explicitly narrowed away from.

### The JQL trap in the second clause

```
assignee != currentUser()          -- WRONG: silently excludes every unassigned ticket
(assignee != currentUser() OR assignee IS EMPTY)   -- correct
```

JQL comparison operators do not match empty fields, exactly like SQL's `NULL`. The naive clause keeps tickets reassigned to a *person* and **silently drops the ones that were simply unassigned** — which are arguably the most interesting rows in the lane, because nobody picked them up.

It fails in the worst way: the lane works, has rows in it, and is quietly missing a category. **The test must seed a ticket that was unassigned away from the operator and assert it appears**, not merely assert the lane is non-empty.

### The discriminator, and why still no new column

The two queries stay **disjoint**: the ticket lane's rows all have `assignee.accountId` equal to the viewer's; this lane's rows, by the second clause, never do. So the predicate is **`assignee?.accountId` is not among the operator's account ids**, and `correlate` already receives `operatorAccountIds` — it is in `CorrelationInput` and in every scenario fixture today.

**No new column, no new table, no flag.** The alternative — a `lane` column written by whichever query produced the row — would have to stay correct across reassignment, and a ticket that came back to the operator between syncs would carry a stale flag saying it was somebody else's while sitting in the ticket lane.

**The rows do want an assignee column**, though: "who has it now" is the entire point of the row. That is a lane-local column, not a change to the ticket lane.

### The write trap is unchanged and is still the sharpest edge

`replaceTickets(connectionId, tickets)` **deletes every row for that connection and reinserts**. Two queries writing separately means the second wipes the first, and the symptom is a lane empty on alternate syncs — intermittent, timing-dependent, and nearly unreadable from a bug report. **Both result sets concatenated into one call** (FR-125); the test asserts both present *after a sync* rather than asserting each query ran.

### Correlation must exclude them, and the obvious shortcut is known-broken

`correlate` builds a work item per ticket; one of these would become a work item and reach the tiles, ball-in-court and the ticket lane's count. Exclude **once, at the top of `correlate`**, not at each of the six consumers.

**Not with `mineOnly`.** It looks like it would do this job — it exists, and it filters the board to the operator's work. It does not: it tests `ballInCourt !== 'you'`, and **`ball.ts`'s fallback awards an unassigned ticket to the operator on the grounds that nobody else holds it**. So `mineOnly` passes exactly the rows it appears to remove — and this lane is full of unassigned tickets, so it would fail here immediately and visibly.

That is not hypothetical. It is why the assignee scope moved into the JQL on 2026-08-15, after a real board claimed that most of a project's tickets needed the operator's attention when the true figure was single digits — found by looking at the running board, not by any of the several hundred tests then passing. (The exact counts are omitted deliberately: they were a fact about a client's Jira, and this file is public.)

---

## R3 — Where does "active ticket" live, and who may set it?

The obvious answer is `AgentSession.workItemKey` — an agent already declares what it is working on. It was rejected for two reasons: it is per session, so two sessions disagree and something has to arbitrate; and it is `null` whenever no agent is running, which makes the panel a dead region exactly when the operator is working the ticket themselves.

**A single authored value, settable by agent or operator.** One row: ticket key, who set it, when.

**It is authored, not derived.** It survives a mirror rebuild, it is the operator's own state, and it must not be recomputed from provider data.

**Exposure is the interesting part.** `settings.update` is `ui-only`, so parking this in settings would put it out of an agent's reach — and the operator's own words were "populated by MCP". It needs its own operation with exposure `all`. That is a real registry addition rather than a field on an existing one, and gate XII means it arrives on all three surfaces at once.

**It is not a write to a provider.** Setting the active ticket changes a local pointer; it does not transition a ticket, comment on it, or touch Jira. Gate XVI is not engaged and no confirmation is required — worth stating, because "an agent can set this" and "an agent can act on your behalf" are the distinction that gate exists to police.

---

## R4 — Clipboard access is a new capability

The renderer is treated as untrusted, and `test/preload-surface.test.ts` asserts the exact set of properties reaching `window`. Copying to the clipboard adds one, and that is a deliberate widening of the shell's grant.

**`navigator.clipboard` is not the route.** The page is loaded over `file:` with `default-src 'none'`; the async clipboard API needs a secure context and a user-gesture model this application should not be relying on. Electron's `clipboard.writeText` in the **main** process is the supported path.

**The shape is already established.** `channels.ts` documents `OPEN_CHANNEL` as *"not an operation — opening the operator's browser is a host affordance of the shell, like the window itself. The URL it opens is not the renderer's: it comes from `links.resolve`."* Copying is the same category: a host affordance, not a question about the domain. So a `COPY_CHANNEL` alongside it, not a registry operation.

**And the same discipline applies to what crosses.** The renderer sends a **prompt id**, never the text. Main reads that prompt from the authored store and copies what it read (FR-139). A renderer that could name arbitrary text to put on the operator's clipboard is a renderer that could put anything there — and the clipboard is pasted into terminals.

**The confirmation is part of the feature, not polish.** A click that silently copies nothing is indistinguishable from a click that worked, until the operator pastes. The channel returns a result and the row acknowledges it (FR-138).

---

## R5 — Agent updates: a new table, or `reportedStatus`?

`AgentSession.reportedStatus` already exists — a nullable string, capped at 500 characters, settable on `sessions.start` and `sessions.heartbeat`, and already rendered in the session lane.

**It is the wrong shape for this panel.** It is a *current status* — overwritten each time, one per session — and the operator asked for "current important info/task update", which reads as a thing an agent *posts*, plural, with the most recent one prominent. A panel over `reportedStatus` would show one line that changes and has no history; the operator would never see the update they missed while away from the desk.

**So: an append-only `agent_updates` table**, and `reportedStatus` keeps its own job in the session lane. Two fields that look similar and mean different things is a risk — the mitigation is that they are rendered in two different places with two different labels, and the MCP tool descriptions say which is which.

**Retention is not optional** (FR-133). An append-only table with an agent writing to it on a loop is unbounded. Bound it per session and prune on write — the cheapest correct policy, and one that cannot fail to run because it has no scheduler.

---

## R6 — What does "collapsible" mean to the tests?

Two implementations, and the difference is not cosmetic.

| | Hide with CSS | Do not render |
|---|---|---|
| Rows still in the DOM | yes | no |
| `perf.spec.ts` counting `.row` | **counts hidden rows** | correct |
| `greyscale.spec.ts` finding severity marks | **finds hidden ones** | correct |
| Screen reader | needs `aria-hidden` too, easy to forget | correct by construction |
| Re-expand cost | free | a re-render |

**Do not render** (FR-143). The re-render is cheap and everything else is a class of bug this repository has already had once: `lane__headings` was `row row--head` and the performance test counted two hundred and two rows on a two-hundred-item board.

**State lives in settings**, keyed by region id. Not in component state, which resets on every launch, and not in `localStorage`, which is a second store the application does not otherwise have and which no migration would ever touch.

**A collapsed lane keeps its header live** (FR-145) — its count and its freshness still render, because the reason to collapse a lane is that you know what is in it and do not need to see it right now. A header that went quiet would make collapsing feel like disabling.

---

## Sources

- `packages/core/src/services/sync.ts` — the JQL, and the `replaceTickets` scoping hazard
- `packages/core/src/correlation/join.ts` — where a work item is built, and therefore where to exclude
- `packages/desktop/src/shared/channels.ts` — `OPEN_CHANNEL`'s reasoning, which `COPY_CHANNEL` copies
- `packages/desktop/src/preload/index.ts` + `test/preload-surface.test.ts` — the surface being widened
- `packages/desktop/src/renderer/index.html` — the CSP that rules out provider HTML
- `packages/core/src/services/sessions.ts` — `reportedStatus` and why it is not this
- Atlassian ADF node reference, and Jira Cloud REST v3 `search/jql` field selection
