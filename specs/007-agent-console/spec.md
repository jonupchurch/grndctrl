# Feature Specification: The agent console

**Feature Branch**: `007-agent-console`

**Created**: 2026-08-19

**Status**: Complete — shipped in 0.4.0, less M2, which was dropped (see below)

**Input**: A marked-up screenshot of the operator's own board, 2026-08-19, adding four regions and one cross-cutting behaviour: *"Recent Tickets not assigned"*, *"Currently active ticket. Populated by MCP, scrollable and collapsible, the ticket should have a link to open it in a browser"*, *"Current important info/task update from the Agent. Should be terse and to the point without a lot of extra words or frills"*, *"List of recent prompts. Clicking copies to clipboard."*, and — separately — *"make each section collapsible"*.

> **Sequenced after [`006`](../006-remove-code-host-and-local-git/spec.md)**, which empties the three regions this fills. They ship in one release. 006 is not shippable alone: it ends with a board thin enough that the layout deserves a second look, and this is that second look.
>
> Constitution v4.0.0 Part II (XI–XVIII) remain hard gates. This is the first feature since 001 to **add** rather than narrow, so the gates that have been coasting — XII especially — do real work here.

---

## The problem

After 006 the board answers one question well: *what is assigned to me and how stale is it?* That is a smaller question than the operator has.

Three things are missing, and they are all about the same shift in how the work actually happens. The operator no longer works a ticket by opening it and typing; they work it by **handing it to an agent**. So the board needs to say what the agent is on, what the agent has to say about it, and what was said to the agent — and none of that is on the screen today. The session lane reports that an agent exists and when it last moved. It does not report what it is *doing*.

The fourth is different. With tickets scoped to the operator's own assignments, a ticket that stops being theirs simply vanishes from the board — silently, between two syncs, with nothing to mark that it was ever there. Work gets handed on, dropped, or quietly taken over, and the operator finds out by remembering to wonder.

And a board that is now seven regions tall on one page needs to be foldable, or the region the operator cares about today is below the fold because of two they do not.

---

## What this adds, and what it costs

| Added | Cost |
|---|---|
| ~~**A "no longer mine" lane**~~ | ⛔ **Dropped 2026-08-20** — see below. The verification it depended on could not be done. |
| **Active ticket panel** | The first time this application fetches and renders a ticket's **description**, which is rich text from an untrusted source in a format that is not plain text. See [R1](./research.md#r1--the-ticket-description-is-not-a-string--changes-the-design). |
| **Agent update panel** | A new authored table, a new MCP tool, and a retention policy — an append-only log with no bound grows until it is a problem. |
| **Recent prompts panel** | A new authored table, a new MCP tool, and **the first new capability the shell has granted the renderer since 001**: writing to the system clipboard. |
| **Collapsible sections** | Persisted per-section state, and a rule about what "collapsed" means to everything that counts rows. |

### What the lane actually is

> **⛔ Out of scope, by the operator's decision on 2026-08-20.** The lane needed
> JQL history operators (`assignee CHANGED FROM currentUser() AFTER -7d`) verified
> against a real Jira, which could not be reached from where the work was being
> done. Asked whether to ship without it, wait, or drop it, the operator answered:
> *"we can remove that feature if it's going to create crazy issues. Drop it and
> mark it as out of scope."*
>
> **Nothing was built, so nothing was removed** — no operation, no lane, no
> column, no migration. What follows is kept as written rather than deleted,
> because it is the record of a feature that was specified and then declined, and
> the reasoning in it is the reason not to reach for the wider "everything not
> assigned to me" later.
>
> **The one real cost is recorded in [tasks.md](./tasks.md#t111):** two end-to-end
> assertions were retired at 006 on the explicit promise that T111 would restore
> them against a second lane. There is no second lane now. Both are replaced by
> source-level tests rather than left dangling.


The screenshot said *"Recent Tickets not assigned"*, which reads as the backlog. It is not. Corrected twice by the operator in conversation: **items that were assigned to them, now are not, and changed hands in the last seven days.**

That is a much narrower and much better feature. It is not a view of the tracker — it is **the tail of the operator's own work**: what was handed to somebody else or dropped in the last week. The row worth seeing is the ticket you thought you were still holding.

**So the standing rule survives.** `sync.ts` argues today that *"a command station is the work you are holding, not an export of the tracker"*, and this lane is work the operator *was* holding. Nothing here needs a cap, an assignee-based filter, or an argument about noise: the set is small by construction, because it is bounded by "passed through your hands in the last week".

The wider reading — everything not assigned to the operator — was considered and explicitly narrowed away from. It is the export that rule exists to prevent.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See what an agent is actually doing (Priority: P1)

The operator hands a ticket to an agent. The board shows, in one column: **which ticket** is being worked (with its description, scrollable, and a link to open it in Jira), and **what the agent last said** — terse, current, no ceremony.

**Why this priority**: this is the change. The other three are useful; this one is the reason the board is worth looking at while an agent runs.

**Independent Test**: start a session over MCP against a ticket, set the active ticket, post an update. Both panels reflect it without the window being reloaded.

**Acceptance Scenarios**:

1. **Given** an agent sets the active ticket over MCP, **When** the board is open, **Then** the active ticket panel shows that ticket — key, summary, status, and description — without a refresh.
2. **Given** a ticket with a long description, **When** it is shown, **Then** the panel scrolls within its own bounds and does not push the rest of the page down.
3. **Given** the active ticket panel, **When** the operator activates its link, **Then** the ticket opens in the browser and the board does not navigate.
4. **Given** an agent posts an update, **When** the board is open, **Then** the update panel shows it with the agent's name and how long ago, and nothing else.
5. **Given** several updates in sequence, **When** the operator reads the panel, **Then** the most recent is unmissable and the earlier ones are reachable without leaving the board.
6. **Given** no agent has set an active ticket, **When** the board renders, **Then** the panel says so plainly and offers the operator a way to set one from a ticket row — an empty panel with no way to fill it is a dead region.

   > **⚠ The second clause was departed from on 2026-08-20**, by the operator's
   > decision, to free width on the row. The ring that set and cleared the active
   > ticket from a ticket row is gone, so **there is no way to set it by hand**;
   > an agent setting it over MCP is the only route, and the panel can still
   > clear it. The lane also no longer marks which row is active — that was the
   > same control's filled state.
   >
   > The first clause still holds: the panel says plainly that nothing is active.
   > What it no longer offers is the way to fill it, which is precisely the "dead
   > region" this scenario was written against. Raised before the change and
   > asked for again after.
7. **Given** an open `question-for-human` note, **When** the board renders, **Then** it appears in the update panel. *(This is where 006's Attention removal sends it; the requirement that it be visible somewhere is met here.)*

---

### User Story 2 - Reuse what was said to the agent (Priority: P2)

Prompts the operator has given agents are recorded as they are used. The panel lists the most recent; clicking one copies it to the clipboard, ready to paste into the next session.

**Why this priority**: it depends on nothing else here and is independently useful, but it is worth less than knowing what the agent is doing right now.

**Independent Test**: record several prompts over MCP, confirm they list newest-first, click one, and confirm the clipboard holds exactly that text.

**Acceptance Scenarios**:

1. **Given** an agent records a prompt over MCP, **When** the board is open, **Then** it appears at the top of the list.
2. **Given** a prompt in the list, **When** the operator clicks it, **Then** its full text is on the clipboard and the interface confirms the copy happened.
3. **Given** a long prompt, **When** it is listed, **Then** the row shows enough to recognise it and the **whole** text is what gets copied — a truncated copy is worse than no copy, because it fails silently.
4. **Given** no prompts have ever been recorded, **When** the panel renders, **Then** it explains what records a prompt and how to make an agent do it. This panel is empty until something is wired up, and it must say so rather than looking broken.
5. **Given** many prompts recorded over months, **When** the panel renders, **Then** it shows a bounded number and older ones are pruned on a stated policy, not accumulated forever.

---

### User Story 3 - Notice what stopped being yours (Priority: P3) — ⛔ OUT OF SCOPE

> **⛔ Out of scope, by the operator's decision on 2026-08-20.** The lane needed
> JQL history operators (`assignee CHANGED FROM currentUser() AFTER -7d`) verified
> against a real Jira, which could not be reached from where the work was being
> done. Asked whether to ship without it, wait, or drop it, the operator answered:
> *"we can remove that feature if it's going to create crazy issues. Drop it and
> mark it as out of scope."*
>
> **Nothing was built, so nothing was removed** — no operation, no lane, no
> column, no migration. What follows is kept as written rather than deleted,
> because it is the record of a feature that was specified and then declined, and
> the reasoning in it is the reason not to reach for the wider "everything not
> assigned to me" later.
>
> **The one real cost is recorded in [tasks.md](./tasks.md#t111):** two end-to-end
> assertions were retired at 006 on the explicit promise that T111 would restore
> them against a second lane. There is no second lane now. Both are replaced by
> source-level tests rather than left dangling.


A ticket the operator was assigned is reassigned, or unassigned, and today it simply disappears from the board between two syncs. A lane shows what left their hands in the last seven days, and who has it now.

**Why this priority**: genuinely useful and genuinely separable. It also depends on a tracker capability that has not been verified yet, so it is the one most likely to need a conversation rather than an implementation.

**Independent Test**: seed a scenario where a ticket's assignee changed away from the operator four days ago, another eleven days ago, and a third that changed away and back. Only the first appears.

**Acceptance Scenarios**:

1. **Given** a ticket reassigned away from the operator three days ago, **When** the board renders, **Then** it appears in the lane, showing who holds it now.
2. **Given** a ticket **unassigned** away from the operator three days ago, **When** the board renders, **Then** it appears too, showing that nobody holds it. This is the case a naive query drops silently.
3. **Given** a ticket reassigned away eleven days ago, **When** the board renders, **Then** it does not appear.
4. **Given** a ticket reassigned away and then back to the operator, **When** the board renders, **Then** it appears in the ticket lane and **not** in this one.
5. **Given** any ticket in this lane, **When** the headline counts are read, **Then** none of them counts it — not "your court", not "stalled", not the ticket lane's count.
6. **Given** any ticket in this lane, **When** ball-in-court is computed, **Then** it does not appear there.
7. **Given** the project filter is set to one project, **When** the lane renders, **Then** it filters with everything else.
8. **Given** a row in the lane, **When** the operator clicks it, **Then** the ticket opens at the tracker, exactly as a ticket row does.
9. **Given** a sync completes, **When** the mirror is inspected, **Then** the operator's tickets and this lane's tickets are both present and neither query has overwritten the other.

---

### User Story 4 - Fold away what you are not using (Priority: P4)

Every region on the board — lanes, panels, and the tile row — can be collapsed to its header, and stays that way across restarts.

**Why this priority**: it makes the other three usable together on one screen, but it is worth nothing on its own.

**Independent Test**: collapse each region, restart, confirm each is still collapsed and its contents are not merely hidden but absent from the page.

**Acceptance Scenarios**:

1. **Given** any region, **When** the operator activates its collapse control, **Then** the region folds to its header and its contents are removed from the page — not hidden with CSS.
2. **Given** a collapsed region, **When** the application restarts, **Then** it is still collapsed.
3. **Given** a collapsed region, **When** a screen reader reads its header, **Then** the control announces its state and what it controls.
4. **Given** a collapsed lane, **When** its header is read, **Then** its count is still visible — the count is the reason to collapse it and still know it is there.
5. **Given** every region collapsed, **When** the board renders, **Then** it is a stack of headers, and nothing errors.

---

### Edge Cases

- **A ticket that left and came back.** Reassigned away on Monday, back on Tuesday. It belongs to the ticket lane and to nothing else; the second clause of the query is what makes that true rather than putting it in both.
- **A ticket reassigned away twice inside the window.** It appears once. The lane is a set of tickets, not a log of transitions.
- **The tracker refuses history operators.** Reported as unbuildable (FR-123b), not approximated. Verified before anything else in this milestone is written.
- **The active ticket is one the operator cannot see.** An agent sets a ticket that is not in the mirror — not theirs, not unassigned, or from an unbound project. The panel shows what it knows (the key, and a link built from the project binding) and says the rest is unavailable. It does not fetch it on demand; that would be a network call driven by an agent's input.
- **The active ticket is deleted or reassigned at the tracker.** The panel keeps showing the last known state with its freshness attached, exactly like every other provider-derived thing on this board.
- **A description containing something that is not text.** Jira descriptions carry tables, panels, media, mentions and embedded content. Unsupported nodes render as a labelled placeholder — never dropped silently, never as raw markup. See [R1](./research.md#r1--the-ticket-description-is-not-a-string--changes-the-design).
- **A prompt containing a secret.** An agent records whatever it was given, which may include a token somebody pasted. This is authored data in the operator's own local store, which is where it already would have been in a note — but the prompt panel makes it one click from the clipboard. Called out in [R4](./research.md#r4--clipboard-access-is-a-new-capability); no automated redaction, and the operator can delete a prompt.
- **Two agents posting updates at once.** Updates are per session and the panel is per active ticket, so the panel shows the updates of the sessions on that ticket, most recent first. It does not merge two agents' narratives into one stream.
- **The clipboard is unavailable.** Reported, not swallowed. A click that appears to work and copies nothing is the worst outcome.
- **A collapsed region while its data is loading or failing.** Collapse is the operator's choice and outranks both; a failing region collapsed stays collapsed, and its header says it failed.

---

## Requirements *(mandatory)*

Numbering continues the single namespace 001 established.

### The "no longer mine" lane — ⛔ OUT OF SCOPE

> **⛔ Out of scope, by the operator's decision on 2026-08-20.** The lane needed
> JQL history operators (`assignee CHANGED FROM currentUser() AFTER -7d`) verified
> against a real Jira, which could not be reached from where the work was being
> done. Asked whether to ship without it, wait, or drop it, the operator answered:
> *"we can remove that feature if it's going to create crazy issues. Drop it and
> mark it as out of scope."*
>
> **Nothing was built, so nothing was removed** — no operation, no lane, no
> column, no migration. What follows is kept as written rather than deleted,
> because it is the record of a feature that was specified and then declined, and
> the reasoning in it is the reason not to reach for the wider "everything not
> assigned to me" later.
>
> **The one real cost is recorded in [tasks.md](./tasks.md#t111):** two end-to-end
> assertions were retired at 006 on the explicit promise that T111 would restore
> them against a second lane. There is no second lane now. Both are replaced by
> source-level tests rather than left dangling.


- **FR-123**: The system MUST fetch, for each bound project, tickets whose assignee **changed away from the operator within the last seven days and is not the operator now** — scoped at the query, using the tracker's issue history. It MUST NOT fetch tickets that were never the operator's.
- **FR-123a**: The query MUST match tickets that became **unassigned** as well as tickets reassigned to a person. A comparison operator alone does not match an empty field, and a lane that silently omits the unassigned ones has dropped the rows nobody picked up.
- **FR-123b**: If the tracker's search endpoint does not support history operators, the feature MUST be reported as unbuildable rather than approximated. The nearest approximation is every ticket not assigned to the operator, which is the export FR-102's scoping rule exists to prevent.
- **FR-124**: These tickets MUST NOT become work items. They MUST NOT contribute to any headline count, to ball-in-court, to severity, to staleness, or to the ticket lane's count. This MUST be enforced by exclusion from correlation, **not** by a display filter — `mineOnly` cannot do it, for the reason in [R2](./research.md#correlation-must-exclude-them-and-the-obvious-shortcut-is-known-broken).
- **FR-125**: The operator's own tickets and this lane's tickets MUST both survive a sync. A write of one set MUST NOT discard the other.
- **FR-126**: The lane MUST obey the project filter, MUST show **who holds each ticket now** — or that nobody does — and MUST state the seven-day window it covers. A row that does not say where the work went is a row the operator cannot act on.

### The active ticket

- **FR-127**: The system MUST hold exactly one active ticket at a time, settable through the agent interface and by the operator from a ticket row, and clearable.
- **FR-128**: The active ticket panel MUST show the ticket's key, summary, status and description, MUST scroll within its own bounds, and MUST offer a link that opens the ticket at the tracker.
- **FR-129**: The system MUST fetch and store the ticket description, and MUST render it as **structured content, never as markup**. No provider-supplied string may reach the page as HTML.
- **FR-130**: A description node the renderer does not support MUST render as a labelled placeholder naming what it is. Silently dropping content from a ticket the operator is working is a lie about what the ticket says.
- **FR-131**: An active ticket that is not in the mirror MUST be shown as what is known plus what is not, and MUST NOT trigger a fetch.

### Agent updates

- **FR-132**: Agents MUST be able to post a short update against their session through the agent interface, and it MUST appear on an open board without a poll.
- **FR-133**: Updates MUST be append-only, retained per session, and bounded by a stated retention policy.
- **FR-134**: The update panel MUST render an update as its text, its agent, and its age — and nothing else. The operator asked for terse; a card with a border, an icon, a title and a menu is not terse.
- **FR-135**: Open `question-for-human` notes MUST surface in the update panel. This satisfies [006's FR-121](../006-remove-code-host-and-local-git/spec.md#what-must-still-be-true), whose display left with the Attention region.

### Prompts

- **FR-136**: Agents MUST be able to record a prompt through the agent interface, with its text, the agent, and optionally the session and project.
- **FR-137**: The prompt list MUST be newest first, bounded, and MUST prune on a stated policy.
- **FR-138**: Activating a prompt MUST place its **complete** text on the system clipboard and MUST confirm that it did. A truncated or silently failed copy MUST NOT be possible.
- **FR-139**: The renderer MUST NOT supply the text that is copied. It identifies a stored prompt; the shell reads that prompt and copies it — the same discipline `links.resolve` already applies to URLs.
- **FR-140**: The operator MUST be able to delete a recorded prompt.
- **FR-141**: The empty state MUST explain what records a prompt, because nothing does until an agent is configured to.

### Collapsible regions

- **FR-142**: Every region of the board MUST be collapsible, and its state MUST persist across restarts.
- **FR-143**: A collapsed region MUST NOT render its contents. Hiding them with CSS leaves them in the page, where everything that counts rows still counts them.
- **FR-144**: A collapse control MUST be a real control that announces its state and what it controls.
- **FR-145**: A collapsed lane MUST still show its count and its freshness in its header. Collapsing is "I am not reading this now", not "stop telling me about it".

---

## Key Entities

| Entity | Change |
|---|---|
| **Ticket** | Gains `description` (structured, not a string). `assignee` becomes load-bearing: it decides which lane a row belongs to, and the "no longer mine" lane displays it. |
| **ActiveTicket** | New. Authored, single-valued: a ticket key, who set it, and when. |
| **AgentUpdate** | New. Authored, append-only: session, agent, text, timestamp. |
| **Prompt** | New. Authored: text, agent, optional session and project, recorded timestamp. |
| **Settings** | Gains collapsed-region state. |

---

## Success Criteria *(mandatory)*

- **SC-013**: An agent can set the active ticket, post an update, and record a prompt over MCP, and all three appear on an open board with no poll and no reload.
- **SC-014**: Adding tickets to the "no longer mine" lane changes no headline count, no tile, and no ball-in-court number.
- **SC-015**: A sync writes both the operator's tickets and this lane's tickets, and both are present in the mirror afterwards.
- **SC-021**: A ticket that became **unassigned** away from the operator appears in the lane. This is asserted separately from the reassigned-to-a-person case, because the query that gets it wrong still returns plenty of rows.
- **SC-016**: A ticket description containing a table, a code block, a mention and an unsupported node renders all four legibly, with the unsupported one labelled, and no markup reaches the page.
- **SC-017**: Clicking a prompt puts its complete text on the clipboard — asserted by reading the clipboard back, not by asserting the click handler ran.
- **SC-018**: Every region collapses, survives a restart collapsed, and renders none of its contents while collapsed — asserted by counting elements, not by checking a class.
- **SC-019**: The board with every region expanded and populated still meets the existing performance floor.
- **SC-020**: `npm run verify` and the end-to-end suite are green.

---

## Assumptions

1. **Agents will be configured to call the new tools.** The update and prompt panels are empty until something calls them. A `CLAUDE.md` snippet ships with the change; nothing in this application can make an agent cooperate, and the empty states say so.
2. **One active ticket is enough.** The operator works one thing at a time with an agent. If that stops being true it is a list, not a rewrite.
3. **Jira's search endpoint supports `CHANGED FROM … AFTER`.** *Unverified, and the first thing to check.* There is no client-side fallback: the changelog endpoint takes issue keys, and the keys of tickets reassigned away are exactly the ones this application no longer holds.
4. **Jira Cloud's description format is ADF.** Confirmed in [R1](./research.md#r1--the-ticket-description-is-not-a-string--changes-the-design); a Server/DC deployment returning wiki markup is out of scope, and the renderer degrades to a labelled placeholder rather than guessing.
5. **The operator accepts that recorded prompts may contain anything an agent was told**, including secrets, held in their own local authored store.
