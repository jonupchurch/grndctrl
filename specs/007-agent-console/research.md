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

## R2 — Can the unassigned lane share the tickets table? Yes, and the reason is neat

The two queries produce **disjoint** sets by construction:

- the operator's lane: `assignee = currentUser()` — every row has `assignee.accountId` equal to the viewer's
- the unassigned lane: `assignee IS EMPTY` — every row has `assignee` null

So `assignee === null` identifies an unassigned ticket exactly, and **no new column, no new table and no new flag is needed**. The lane a ticket belongs to is a property of the ticket, not a label the sync attaches.

That is worth stating because the obvious design — a `lane` or `is_mine` column written by whichever query produced the row — would be a field that has to be kept true, and this codebase's recurring bug is the field both sides agree on that nothing maintains.

**The trap is the write, not the read.** `replaceTickets(connectionId, tickets)` **deletes every row for that connection and reinserts**. Two queries writing separately means the second wipes the first, and the symptom is a lane that is empty on every other sync — intermittent, timing-dependent, and very hard to read from a bug report. `syncTickets` already carries a comment about exactly this hazard for a different reason. **Both result sets must be concatenated and written in one call** (FR-125), and the test for it must assert both are present after a sync rather than asserting each query ran.

**Correlation must exclude them** (FR-124). `correlate` builds a work item per ticket; an unassigned ticket would become one, and would then reach the tiles, ball-in-court and the ticket lane's count. The filter belongs at the top of `correlate`, where it is one condition, rather than at each of the six places that would otherwise need to remember.

**And the obvious shortcut is already known to be broken.** The `mineOnly` filter looks like it would do this job — it is right there, it already exists, and it filters the board to the operator's own work. It does not: it tests `ballInCourt !== 'you'`, and **the fallback at the end of `ball.ts` awards an unassigned ticket to the operator on the grounds that nobody else holds it**. So `mineOnly` passes exactly the rows it appears to remove.

This is not a hypothetical. It is why the assignee scope was moved into the JQL in the first place, on 2026-08-15, after a board carrying [redacted] claimed 159 items needed attention when the real number was nine — and it was found by looking at the running board, not by any of the 533 tests then passing. Excluding at `correlate` avoids it because an unassigned ticket never becomes a work item and therefore never reaches `ball.ts` at all. Anyone who "simplifies" FR-124 into a display filter reintroduces the original bug exactly.

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
