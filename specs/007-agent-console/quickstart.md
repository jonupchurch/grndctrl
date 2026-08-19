# Quickstart — Verifying the agent console

**Feature**: `007-agent-console` · **Date**: 2026-08-19 · **Plan**: [plan.md](./plan.md)

Each milestone verifiable on its own, in build order. **Windows first** — the clipboard is the only genuinely platform-divergent thing here.

---

## Prerequisites

- [006](../006-remove-code-host-and-local-git/quickstart.md) complete and green.
- A Jira site where a ticket has been **reassigned away from you in the last week** (and ideally one **unassigned** away from you, which is the case a naive query drops), and one ticket with a **rich description** — a heading, a bullet list, a code block, and ideally something exotic like a panel or an embedded image, because the exotic node is the one the converter has to handle honestly.
- An MCP client that can call the new tools. For the last section, a real agent.

---

## M1 — Collapse

```
npm run build && npm run verify
```

Then launch and:

- Collapse every region. Each folds to its header.
- **Open the inspector.** A collapsed region's contents must be **absent**, not hidden. If you can find a `.row` inside a collapsed lane, FR-143 is not met and `perf.spec.ts` is now counting rows nobody can see.
- A collapsed lane still shows its count and its freshness.
- Restart. Everything you collapsed is still collapsed.
- Tab to a collapse control. It announces its state.

**The probe** (T105): implement one region with `display: none` and confirm the test fails. If it passes, the test is checking a class name and is worth nothing.

---

## M2 — The "no longer mine" lane

**First, before any of this** (T106a): send `assignee CHANGED FROM currentUser() AFTER -7d` to `/rest/api/3/search/jql` and see if Jira accepts it. One request. If it does not, the lane cannot be built as specified and that is a conversation, not a workaround.

Then:

- The lane lists tickets that left your hands in the last seven days, newest first, **each showing who has it now** — or that nobody does.
- A ticket reassigned away **eleven** days ago is not there.
- A ticket reassigned away and then back to you is in the **ticket** lane and not in this one.
- A ticket that became **unassigned** away from you *is* there. This is the one a naive query drops silently, and the lane looks perfectly healthy without it.
- The ticket lane above is unchanged — still only your work.
- **The numbers did not move.** Compare every tile and every ball-in-court row before and after the lane appears (SC-014).
- Select one project. The lane filters with everything else.
- Click a row. Jira opens.

**Two probes here.**

(T108) Make the two queries two separate `replaceTickets` calls, sync twice, and watch one lane empty. This bug reaches a bug report as *"sometimes the tickets are gone"*, and finding it from that description costs a day.

(T108a) Drop `OR assignee IS EMPTY` from the query and confirm the unassigned-away case disappears while the lane still looks fine. JQL's `!=` does not match empty fields — the failure is invisible unless something asserts that specific row.

---

## M3a — The active ticket

Over MCP:

```
grndctrl_set_active_ticket { ticketKey: "…" }
```

- The panel updates **without a reload** — that is the `focusChanged` push doing its job.
- Key, summary, status, and a link that opens the ticket at the tracker without navigating the board.
- Clear it. The empty state offers a way to set one from a ticket row.
- Set a key that is in **no** scenario. The panel shows the key and says the rest is unavailable, and **no network request is made** (FR-131).

---

## M3b — The description

- A ticket with headings, lists and code renders all of them legibly.
- A ticket with something exotic shows a **labelled placeholder** naming what it was — not a gap.
- **View source on the panel.** No provider HTML anywhere. If the CSP had to stop something, the design was already wrong; the CSP is the backstop, not the control.
- A long description scrolls **inside the panel**, and the rest of the page does not move.

**The probe** (T126): make the converter drop unknown nodes instead of labelling them, and confirm the test fails. Silent dropping is this component's characteristic failure, and the section it drops is usually the acceptance criteria.

---

## M4 — Agent updates

```
grndctrl_post_update { sessionKey: "…", text: "Refactored the parser; tests green; next is the CLI." }
```

- Appears immediately, showing **text, agent, age** and nothing else. If it has a card, a border, an icon or a menu, FR-134 is not met — "terse" was the brief.
- Post several. The most recent is unmissable, the earlier ones reachable without leaving the board.
- Post past the retention bound. The oldest are pruned; the table does not grow.
- Add a `question-for-human` note. It appears here (FR-135) — this is where 006's Attention removal sent it.
- Try to post something enormous. It is refused by the schema, not rendered.

---

## M5 — Prompts and the clipboard

```
grndctrl_record_prompt { text: "…" }
```

- Appears at the top of the list.
- Click it. **Paste somewhere and check.** Not "the click handler ran" — the clipboard.
- Record a very long prompt. Click it. Paste it. **The whole thing** (FR-138). A truncated copy fails at the paste, a long way from the click.
- Delete a prompt. It goes.
- With no prompts at all, the panel explains what records one.

**Two probes here**:

- (T142) Break the copy and confirm the test fails. A test asserting the handler ran is precisely the vacuous test this one exists instead of.
- (T140) Check *how* `preload-surface.test.ts` was updated. It should name `copy`. If it was relaxed to a subset check, the exact-set guarantee is gone and every future addition passes silently — and the diff looks entirely reasonable.

---

## M6 — The whole board

**Look at it.** Populated, every region expanded: seven regions on one page. Then collapse three. Is it better? This is the judgement T146 exists for, and it cannot be made from a mockup.

```
npm run verify
cd packages/desktop && npx playwright test
npm run audit:egress
```

- Everything green.
- The egress audit contacts nothing new. Two tables and a clipboard channel should not, and "should not" is what an audit is for.

---

## The end-to-end check (SC-013)

With a real agent, on a real ticket:

1. Agent starts a session and calls `grndctrl_set_active_ticket`.
2. The active-ticket panel shows it, with its description, without a reload.
3. Agent calls `grndctrl_record_prompt` with what it was told.
4. It is at the top of the prompts panel. Clicking it puts it on the clipboard.
5. Agent calls `grndctrl_post_update` twice as it works.
6. Both appear, most recent first, terse.
7. Agent asks a question as a `question-for-human` note.
8. It appears in the update panel, and ball-in-court moves to you.
9. Collapse the no-longer-mine lane and the prompts panel. Restart. Still collapsed.

**If steps 1, 3 and 5 do nothing**, the agent has not been told to call the tools — see the `CLAUDE.md` snippet in `docs/agents.md` (T147). That is the expected first-run state, and it is why the empty states have to explain themselves.
