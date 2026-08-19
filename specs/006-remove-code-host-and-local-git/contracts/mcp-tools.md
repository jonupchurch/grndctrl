# Contract delta — `grndctrl-mcp` (the agent surface)

**Feature**: `006-remove-code-host-and-local-git` · **Date**: 2026-08-19

Amends [001's MCP contract](../../001-ground-control-v1/contracts/mcp-tools.md). The server is still an adapter — every tool maps to exactly one registry operation and holds no logic of its own (XII).

**This is the surface with a non-human audience, and that changes the standard.** A person reading a stale tool description notices the mismatch. An agent reads the description as ground truth, plans around it, and then handles the absence of data it was promised as an error condition — or worse, invents an explanation. FR-116 is not politeness.

---

## Tools removed

`grndctrl_list_drift`. Nothing produces a finding, so a tool that returns them would return an empty array forever — which an agent reads as "the systems agree", a much stronger claim than "we stopped looking".

---

## `grndctrl_start_session` — a parameter is removed

`workspaceKey` goes.

```diff
  agentId:         string
  sessionId:       string
  projectId?:      string | null
  workItemKey?:    string | null
- workspaceKey?:   string | null   // "The repo/branch checkout you are in."
  reportedStatus?: string | null
  heartbeatIntervalSec?: number
```

**A caller that sends it gets an explicit rejection** (FR-115), not silent acceptance and not a quiet drop. The alternative — accept and ignore — was considered and rejected: it is precisely the shape this codebase keeps finding bugs in, a field both sides agree on that nothing connects. An agent that keeps sending `workspaceKey` should find out immediately rather than believe the board knows which checkout it is in.

**Migration for agent authors**: remove the argument. There is no replacement, because there is nothing left to identify a checkout by.

---

## `grndctrl_resolve_link` — four targets removed

```diff
- target?: 'default' | 'ticket' | 'pull-request' | 'repository' | 'branch' | 'documentation' | 'check'
+ target?: 'default' | 'ticket' | 'documentation'
```

The description loses its clause about falling back to the repository for a branch the host has never seen.

---

## Descriptions that must change

The current text promises data that will never arrive. Each of these is a rewrite, not a deletion, and the rewrite has to be *accurate about what remains* rather than merely quiet about what left.

| Tool | Currently says | Must say |
|---|---|---|
| `grndctrl_list_work` | "ticket, branches, pull requests, CI checks and agent sessions joined into one row each" | tickets and agent sessions joined into one row each, with severity, staleness and whose move it is |
| `grndctrl_list_projects` | "each one a Jira project plus a repository" | each one a Jira project |
| `grndctrl_list_notes` | "attached to a ticket, pull request, branch, workspace or session" | attached to a ticket or a session — **and must still say** that notes on other subject kinds exist from before and are readable by key |

That last row is the subtle one. The tool's *ability* to read a note on a pull-request key is retained (FR-117), so a description that says only "ticket or session" would understate what the tool does and would tell an agent not to bother asking about a key it might legitimately hold.

---

## Tools unchanged

`grndctrl_heartbeat`, `grndctrl_report_activity`, `grndctrl_end_session`, `grndctrl_add_note`, `grndctrl_update_note`, `grndctrl_delete_note`, `grndctrl_list_pending_actions`, `grndctrl_claim_action`, `grndctrl_report_action_complete`, `grndctrl_report_action_failed`.

The outbox tools keep every action kind in their schemas so that an action confirmed before the upgrade is still claimable and reportable. Only the set the application *produces* narrows.

---

## Resources

The MCP resource list is unchanged in shape. Its content narrows with the board.

---

## Versioning note

This is a breaking change to a published package's tool surface: a removed parameter and four removed enum members. It belongs in the changelog's breaking-changes list at the top of the entry, not in the body — see [plan.md](../plan.md#versioning).
