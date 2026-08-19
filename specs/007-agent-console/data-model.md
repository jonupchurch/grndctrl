# Phase 1 — Data Model: the agent console

**Feature**: `007-agent-console` · **Date**: 2026-08-19 · **Plan**: [plan.md](./plan.md)

The three tiers are unchanged. Everything added here is **authored** except one mirrored column — which is the right split: the active ticket, the updates and the prompts are all things the operator or their agent produced, and none of them can be rebuilt from a provider.

---

## Ticket *(mirrored)* — one new field

| Field | |
|---|---|
| `description` | `DocumentNode[] \| null` — the ticket body, converted from ADF at ingest |

**Converted at ingest, not at render.** Three reasons. The renderer must never hold provider markup ([R1](./research.md#r1--the-ticket-description-is-not-a-string--changes-the-design)); the conversion is deterministic, so doing it per-paint is waste; and a conversion failure at ingest is one log line on a sync, while a conversion failure at render is a blank panel with no explanation.

**`null` means the description was not fetched or was empty** — and, as everywhere else in this application, is not rendered as "no description" but as an absence with its freshness attached.

**Storage**: `tickets.description TEXT` holding the converted node array as JSON. Nullable, no default.

### DocumentNode *(derived from the provider, stored)*

A closed union, deliberately small:

```
paragraph | heading | text | list | listItem | codeBlock
| blockquote | rule | hardBreak | table | tableRow | tableCell
| mention | link | unsupported
```

`unsupported` carries the original node type as a label and nothing else. It is what every node outside the whitelist becomes, and it exists so that a description with an unrecognised block reads as *"[panel]"* rather than as a description that quietly lacks a section (FR-130).

**No node carries raw markup.** `text` carries a string and a set of marks. There is no `html` node and there must never be one.

---

## ActiveTicket *(authored, single-valued)*

| Field | |
|---|---|
| `ticketKey` | natural key — the ticket being worked |
| `setBy` | `'operator' \| 'agent'` |
| `setByAgentId` | agent id when an agent set it, else null |
| `setAt` | timestamp |

**One row, enforced by the schema** — `CHECK (id = 1)`, the same shape the settings table already uses. A table that can hold two of something single-valued eventually holds two.

**Authored, so it survives a mirror rebuild** — and can therefore point at a ticket the mirror does not currently hold. That is FR-131's case and it is correct: the pointer is the operator's, the ticket is the provider's, and they are allowed to be out of step. The panel shows what it knows and says what it does not.

**Clearing sets the row to absent**, not to an empty string. "No active ticket" is a state, not a ticket whose key is blank.

---

## AgentUpdate *(authored, append-only)*

| Field | |
|---|---|
| `id` | |
| `sessionKey` | which session posted it |
| `agentId` | denormalised, so an update outlives its session row being read |
| `ticketKey` | the active ticket at post time, or null — **captured, not joined** |
| `text` | the update, bounded |
| `postedAt` | |

**`ticketKey` is captured at write time rather than looked up at read time.** The active ticket changes; an update said what it said about the ticket that was active when it was posted. Joining at read would re-attribute the whole history every time the operator switched tickets.

**Retention**: the most recent *N* per session, pruned **on write** (FR-133). On write rather than on a timer, because a pruning schedule is a thing that can fail to run and then nobody notices until the table is enormous. Deleting the tail during the insert costs one statement and cannot be skipped.

**Append-only.** No update or delete operation. An agent that said something wrong says something else; the operator reads a history, not a mutable status. That is the whole reason this is not `AgentSession.reportedStatus` ([R5](./research.md#r5--agent-updates-a-new-table-or-reportedstatus)).

---

## Prompt *(authored)*

| Field | |
|---|---|
| `id` | |
| `text` | the full prompt — **never truncated in storage** |
| `agentId` | who recorded it |
| `sessionKey` | nullable |
| `projectId` | nullable |
| `recordedAt` | |

**The list truncates for display; the store does not, and the copy does not** (FR-138). A copied prompt that stops mid-sentence fails silently at the point of use, which is the paste — a long way from the click.

**Deletable** (FR-140), because a prompt is free text an agent was handed and may contain something the operator would rather not keep. This is the one entity here with a delete operation, and that is why.

**Retention**: a bounded number, pruned on write, same reasoning as updates.

**No deduplication.** Two identical prompts recorded a week apart are two facts about when work happened. Collapsing them would turn a history into a set.

---

## Settings *(authored)* — one new field

| Field | Shape |
|---|---|
| `collapsedRegions` | `Record<string, boolean>` — region id → collapsed |

**A map rather than an array of ids**, so a region removed from the board leaves a harmless orphan key rather than an array that has to be reconciled. Unknown keys are ignored on read; missing keys mean expanded.

**Region ids are stable strings owned by the renderer** and never generated — a generated id would change between builds and silently expand everything the operator had folded.

---

## Migration — `mirror.db`, version 4 → 5

```sql
ALTER TABLE tickets ADD COLUMN description TEXT;
```

Nullable, no default. Every existing row answers `null`, which the domain already defines as "not fetched". The next sync fills them.

---

## Migration — `authored.db`, version 2 → 3

Three new tables and one settings-payload field. Nothing existing is rewritten, so this one carries none of 006's table-rebuild risk.

```sql
CREATE TABLE active_ticket (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  ticket_key     TEXT NOT NULL,
  set_by         TEXT NOT NULL CHECK (set_by IN ('operator','agent')),
  set_by_agent_id TEXT,
  set_at         TEXT NOT NULL,
  -- An agent-set row must say which agent. The operator is the only anonymous setter.
  CHECK (set_by <> 'agent' OR set_by_agent_id IS NOT NULL)
);

CREATE TABLE agent_updates (
  id          TEXT PRIMARY KEY,
  session_key TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  ticket_key  TEXT,
  text        TEXT NOT NULL,
  posted_at   TEXT NOT NULL
);
CREATE INDEX idx_updates_session ON agent_updates(session_key, posted_at DESC);

CREATE TABLE prompts (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  session_key TEXT,
  project_id  TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_prompts_recorded ON prompts(recorded_at DESC);
```

**No foreign keys to `agent_sessions`**, though both tables are authored and a reference would be legal. A session row can be pruned or a session can be reported by an agent that never started one cleanly; an update that vanished because its session did would lose the operator information they were relying on. `session_key` is a key, not a constraint — the same reasoning `freshness.connection_id` already uses.

**Settings** gains `collapsedRegions: {}`. Idempotent: a payload that already has it is untouched.

---

## What the unassigned lane does *not* add

**Nothing.** No table, no column, no flag.

The two ticket queries are disjoint by construction — the operator's rows all have `assignee.accountId` equal to the viewer's, unassigned rows all have `assignee` null — so `assignee === null` identifies the lane exactly ([R2](./research.md#r2--can-the-unassigned-lane-share-the-tickets-table-yes-and-the-reason-is-neat)).

This is worth stating as a data-model decision rather than an implementation detail, because the obvious alternative — an `is_mine` or `lane` column written by whichever query produced the row — is a field that must be kept true by the sync, and the recurring bug in this codebase is exactly the field that both sides agree on and nothing maintains.

**The constraint it creates**: both result sets must be written in a single `replaceTickets` call, because that call deletes every row for the connection first. Two writes and the second discards the first. It is a data-model consequence, not a coding detail, and FR-125 exists for it.
