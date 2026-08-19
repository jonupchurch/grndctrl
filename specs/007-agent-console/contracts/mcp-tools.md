# Contract delta — `grndctrl-mcp` (the agent surface)

**Feature**: `007-agent-console` · **Date**: 2026-08-19

Amends [001's MCP contract](../../001-ground-control-v1/contracts/mcp-tools.md), on top of [006's delta](../../006-remove-code-host-and-local-git/contracts/mcp-tools.md).

**Three new tools, and this feature does not work without agents calling them.** Two of the four new panels are empty until something does. That makes the tool *descriptions* part of the feature rather than documentation of it: an agent decides whether to call a tool by reading its description, and a description that does not say *when* to call it will be read and skipped.

---

## Tools added

### `grndctrl_set_active_ticket`

```
ticketKey: string    // "The ticket you are working on now."
```

Maps to `focus.set`.

**Description must say when, not what.** "Sets the active ticket" tells an agent nothing about whether this moment is one. The text is closer to: *call this when you begin work on a ticket, so the operator's board shows what you are on. Call it again when you switch. One ticket is active at a time.*

**Not merged into `grndctrl_start_session`.** A session starts once; the ticket changes several times within it, and an agent that could only declare its ticket at startup would show the operator the wrong one for most of the session.

### `grndctrl_post_update`

```
sessionKey: string
text:       string   // bounded — see below
```

Maps to `updates.post`.

**The bound is in the schema and the description says why.** The panel's brief is "terse and to the point without a lot of extra words or frills", and an agent's natural register is neither. The description asks for one or two sentences — what changed, what is next, what is blocking — and the schema refuses a stack trace.

**It is not a heartbeat and not an activity report.** Three tools now take something from an agent about its liveness and this is the fourth thing in that neighbourhood, so each description must draw the line:

| Tool | Means |
|---|---|
| `grndctrl_heartbeat` | I am alive. Advances nothing. |
| `grndctrl_report_activity` | I did something. Advances the staleness clock. |
| `reportedStatus` on start/heartbeat | What I am doing, one line, overwritten. |
| `grndctrl_post_update` | **Something the operator should read.** Appended, kept, displayed. |

The fourth is the only one aimed at a human's attention, and the description says so.

### `grndctrl_record_prompt`

```
text:        string
sessionKey?: string
projectId?:  string
```

Maps to `prompts.record`.

**Description must be explicit about what a prompt is here**: the instruction the agent was given, recorded so the operator can reuse it. Not the agent's own plan, not a summary, not a paraphrase.

**`prompts.delete` is deliberately absent from this surface.** Recording is an agent's business; curating the operator's history is not.

---

## Tools narrowed

### `grndctrl_list_work`

The returned tickets gain `description` as structured content. The description of the tool says the field is a node array, not markup — an agent that expects a string will otherwise stringify a tree.

---

## Tools unchanged

Everything else, including the notes tools. `grndctrl_add_note` with type `question-for-human` still works exactly as before, and after 006 its display lands in the update panel (FR-135) rather than in Attention.

---

## Making an agent actually call these

**This is the part that determines whether the feature works**, and it is not code in this repository.

`docs/agents.md` gains a `CLAUDE.md` snippet the operator can paste into their own projects — roughly: when you start on a ticket call `grndctrl_set_active_ticket`; when you are given an instruction worth keeping call `grndctrl_record_prompt`; when something happens the operator would want to know call `grndctrl_post_update`, briefly.

Without it, the active ticket panel shows whatever the operator set by hand and the other two stay empty. The spec says this ([Assumption 1](../spec.md#assumptions)), the empty states say it (FR-141), and the completion report must say it.

---

## Versioning note

Three added tools and one changed field shape on `grndctrl_list_work`. Additive for existing agents, except that anything reading `description` as a string now receives an array. Belongs in the changelog's breaking-changes list alongside 006's removals.
