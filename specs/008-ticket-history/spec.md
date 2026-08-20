# Feature Specification: The ticket history

**Feature Branch**: `008-ticket-history`

**Created**: 2026-08-20

**Status**: In progress

**Input**: The operator, 2026-08-20: *"I want to have a manually curated ticket history that lists one line per ticket where I can have Claude make notes on what we did and any additional notes so I can easily track back to answer questions"*.

> Sequenced after [`007`](../007-agent-console/spec.md), which shipped in 0.4.0.
> Constitution v4.0.0 Part II (XI–XVIII) remain hard gates. Like 007 this **adds**
> rather than narrows, so XII and XIII both do real work: a new authored entity,
> a new operation namespace, and a new tool on all three surfaces.

---

## The problem

Three weeks after a ticket is closed, somebody asks what was done on it. The
answer exists — it is spread across a Jira comment thread, a pull request that no
longer has a lane on this board, an agent session that ended, and a chat
transcript nobody kept. None of it is one place, and none of it is one line.

Ground Control already holds writing about tickets, and none of it answers that
question:

| What exists | Why it is not this |
|---|---|
| **Notes** (`decision`, `gotcha`, `question-for-human`, `todo`) | Many per subject, and typed by intent. A subject with eleven notes has no line; it has eleven. Reading back a year of work means reading everything. |
| **Agent updates** | A per-session stream, pruned at 50, and about *now* — "running the migration", "tests green". Correct for a live panel and worthless a month later, by design. |
| **Recorded prompts** | What was *said to* an agent, bounded at 200, and about how to ask rather than what happened. |
| **The ticket lane** | Only what is currently assigned to the operator. A ticket that closed or changed hands leaves the board entirely, and takes any trace of itself with it. |

So the gap is specific: **one durable line per ticket, written after the fact,
that survives the ticket leaving the board.** It is not a fifth note type and it
is not a longer update stream.

---

## What this adds, and what it costs

| Added | Cost |
|---|---|
| **A `ticket_history` table** — one row per ticket key, never pruned | The first authored table in this product with **no retention bound at all**, which has to be a decision rather than an omission. See below. |
| **`history.*` — five operations** | A sixth namespace on three surfaces, and the third write path that has to ask the site check whether its key could ever resolve. |
| **Two MCP tools** | A model that will reasonably record *everything* unless the tool description tells it what a line is for. Same failure `grndctrl_record_prompt` was written against. |
| **A board region with an editor in it** | The first region on the board the operator can **edit** in place. Notes have a modal; this has an inline editor, which means a second surface holding an optimistic-concurrency revision. |

### Never pruned, deliberately

Every other authored stream in this product has a bound: updates at 50 per
session, prompts at 200 globally. Both are *feeds* — the value of an entry decays
and the newest matter most, so a bound loses nothing anyone would miss.

This is the opposite. The whole point is the entry you wrote fourteen months ago
about the ticket somebody is now asking about, and a retention rule would delete
exactly the rows the feature exists to keep. One line per ticket also bounds
itself in practice: the table grows at the rate the operator closes tickets, not
at the rate an agent talks.

**So there is no prune, and a test asserts its absence** — otherwise the next
person to add a table here copies `prompts.ts`, brings the prune with it, and
nothing fails until a year has passed.

### One line means one line

The requirement says "lists one line per ticket". A model handed a free-text
field will write a paragraph, and a region of paragraphs is not a history you can
scan — it is the note list again, with worse types.

So the line is **one line, enforced**: bounded, and refused if it contains a line
break. Refused rather than collapsed, because collapsing rewrites what the caller
wrote and reports nothing, and because the refusal is the only chance to tell a
model where the paragraph belongs — in `notes`, which is the field right beside
it and has room.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Answer a question about work that is finished (Priority: P1)

Somebody asks the operator why a change was made on MERC-1184 four months ago.
They open Ground Control, look at the ticket history, and find one line: what was
done, and by whom. Expanding it shows the longer notes, which name the decision
and the thing that nearly went wrong.

The ticket itself is closed and has not been on this board since March.

**Why this priority**: it is the whole feature. Everything else here exists to
get a correct line into that list.

**Acceptance scenarios**

1. **Given** a history entry for a ticket the mirror no longer holds, **When** the
   operator opens the board, **Then** the entry is listed with its line, its
   ticket key and the ticket's summary as it stood when the entry was last
   written.
2. **Given** thirty entries, **When** the operator types part of a ticket key or a
   word from a line, **Then** the list narrows to matching entries and says how
   many of how many are shown.
3. **Given** an entry with notes, **When** the operator expands it, **Then** the
   notes are shown in full, with their line breaks intact.
4. **Given** an entry written a year ago, **When** any number of prompts, updates
   and syncs have happened since, **Then** it is still there.

---

### User Story 2 - Have an agent write the line (Priority: P1)

The operator finishes a piece of work with an agent and says "record what we did".
The agent calls one tool with the ticket key, a one-line summary and a paragraph
of detail. It appears on the board immediately.

Next week the same ticket comes back. The agent records again: the line is
rewritten to describe where the ticket now stands, and the new detail is **added**
to the notes rather than replacing them.

**Why this priority**: the operator asked for "Claude to make notes". A history
only the operator can write is a history that will not get written.

**Acceptance scenarios**

1. **Given** no entry for a ticket, **When** an agent records one, **Then** it is
   created and the board updates without a refresh.
2. **Given** an existing entry, **When** an agent records against the same ticket,
   **Then** the line is replaced and the notes are appended to, with the previous
   notes intact above.
3. **Given** an agent that records the same notes text twice, **When** the second
   record arrives, **Then** the text appears once.
4. **Given** an agent that passes a line containing a line break, **When** it
   records, **Then** the write is refused with an error naming the notes field.
5. **Given** an agent recording against `jira:acme/MERC-1` when the configured
   site is `acme.atlassian.net`, **When** it records, **Then** the write is
   refused and the error names the configured sites.

---

### User Story 3 - Curate it (Priority: P2)

The line an agent wrote is close but not right. The operator edits it in place,
fixes the wording, and saves. Another entry was recorded against the wrong ticket
entirely; they delete it.

**Why this priority**: "manually curated" is in the request. A list you cannot
correct is a list you stop trusting.

**Acceptance scenarios**

1. **Given** an entry, **When** the operator edits the line and saves, **Then** the
   new text is stored and the revision advances.
2. **Given** an entry the operator has open in the editor, **When** an agent
   records against the same ticket first, **Then** the operator's save is rejected
   as a conflict and shown the entry that won, with their draft still in the box.
3. **Given** an entry, **When** the operator deletes it, **Then** it is gone from
   the list and from the store.
4. **Given** an agent, **When** it attempts to rewrite or delete an entry,
   **Then** the operation is not available to it.

---

### Edge Cases

- **A ticket key with no entry** — `history.get` answers `not_found`, not an empty
  entry. Same reasoning as `prompts.get`: an empty line and a missing one look
  identical to a caller that renders whatever it is handed.
- **Notes that grow without bound** — the accumulated text is capped, and the cap
  refuses rather than truncates. The refusal points at the rewrite operation.
- **A ticket that gets renamed in Jira** — the stored summary is refreshed
  whenever the history is written and the mirror can answer. It freezes at the
  last value seen once the ticket leaves the mirror, which is the correct
  behaviour for a record of what was worked on.
- **No connections configured yet** — the site check stays silent, exactly as it
  does for notes and focus. A fresh install must be able to record.
- **An entry for a subject that is not a ticket** — refused. This is the *ticket*
  history; a branch or a session key in it would produce a row nothing can label.

---

## Requirements *(mandatory)*

### The entry

- **FR-146**: The system MUST hold at most one history entry per ticket key.
  Recording against a key that already has one MUST update that entry rather than
  create a second.
- **FR-147**: An entry's line MUST be a single line. A line containing a line
  break MUST be refused, with an error that names the notes field. Surrounding
  whitespace is trimmed; interior text is never rewritten.
- **FR-148**: Recording MUST append to an entry's notes rather than replace them,
  and MUST NOT append text the notes already end with.
- **FR-149**: An entry MUST carry the ticket's own summary as it stood when the
  entry was last written, refreshed on each write the mirror can answer and
  retained when it cannot.
- **FR-150**: History entries MUST NOT be pruned. There is no retention bound and
  no age cutoff.
- **FR-151**: An entry's author MUST be stamped from the transport, never read
  from the payload.
- **FR-152**: Recording against a Jira site no connection is configured for MUST
  be refused, on the same terms as a note and the active ticket.
- **FR-153**: A history entry MUST attach to a ticket key only.

### Curating

- **FR-154**: The operator MUST be able to rewrite an entry's line and notes
  wholesale, and to delete an entry. Both MUST be unavailable to agents.
- **FR-155**: A rewrite MUST require the revision that was read. A stale revision
  MUST be rejected as a conflict, carrying the entry that won.

### Reading

- **FR-156**: Entries MUST be listed most-recently-written first.
- **FR-157**: The list MUST be narrowable by a term matching the ticket key, the
  line, or the notes.
- **FR-158**: The board MUST show the history as its own collapsible region, one
  row per entry, with the notes shown on demand rather than always.
- **FR-159**: An empty history MUST name the tool that fills it, as the prompts
  panel does — it is empty on every fresh install and must not read as broken.

---

## Key Entities

- **Ticket history entry** — a ticket key, one line, accumulated notes, the
  ticket's summary as last seen, who last wrote it, a revision, and two
  timestamps. Authored. Keyed by natural key with no foreign key to the mirror
  (XIII), which is what makes it outlive the ticket.

---

## Success Criteria *(mandatory)*

- **SC-030**: An entry written before a mirror is deleted and rebuilt is still
  present, still readable, and still carries its ticket summary afterwards.
- **SC-031**: A history of 500 entries renders and filters without the board's
  frame budget regressing.
- **SC-032**: No code path in the product deletes a history entry except the
  operator's explicit delete.

---

## Assumptions

- The operator writes history **after** work, not during it. Nothing here tries to
  capture it automatically, and no other operation writes an entry as a side
  effect — an entry that appeared without being asked for would be a feed, which
  is the thing this is not.
- One line per ticket is per *ticket*, not per ticket per person. Two agents
  working the same ticket share an entry, and the notes accumulate in the order
  they were written.
