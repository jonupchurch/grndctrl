# Specification Quality Checklist: the agent console

**Purpose**: Validate specification completeness and quality before implementation
**Created**: 2026-08-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details in the spec itself
- [x] Focused on user value, and on what each addition costs
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No `[NEEDS CLARIFICATION]` markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Every success criterion has a named check in [quickstart.md](../quickstart.md)
- [x] Edge cases identified

## Addition-specific

The mirror of 006's removal checklist. A feature that adds has different ways of being wrong.

- [x] **Every new boundary crossing is named and justified** — three operations with their exposures decided one at a time, three MCP tools, one shell channel, one provider field
- [x] **The new capability the shell grants the renderer is stated as a widening**, not slipped in — and the wrong fix to the test that guards it is written down in advance
- [x] **A standing decision being reversed is quoted and re-argued**, not silently contradicted — the "only my assigned work" rule, quoted from `sync.ts`, and scoped to a lane rather than abandoned
- [x] **Untrusted input has a named rendering strategy** — a whitelist converter with a labelled fallback, and an explicit refusal of provider HTML
- [x] **Every new table has a retention policy**, and each prunes on write rather than on a schedule that can fail to run
- [x] **The features that do nothing until someone else acts are marked as such** — two of four panels are empty until an agent is configured, in the spec, in the empty states, and in what the completion report must say
- [x] **The two vacuous-test traps are identified with their probes** — asserting a click handler ran instead of reading the clipboard; asserting a CSS class instead of counting elements

## Feature Readiness

- [x] Every user story has acceptance scenarios and is independently testable
- [x] Milestone order is argued rather than assumed
- [x] A judgement point is scheduled rather than assumed away (T146 — seven regions on one page, looked at running)
- [x] Constitution gates re-checked after the data model and contracts, and the re-check moved the emphasis (from the clipboard to XII and the three exposures)

## Open questions for the operator

Not blockers; each has a stated default that implementation will follow.

- [ ] **"Not assigned" reading.** Default: `assignee IS EMPTY` — genuinely nobody's, therefore available. The alternative, "assigned to anyone but me", is most of a real tracker and is the export the standing rule was written against.
- [ ] **Prompt list exposure.** Default: readable by any agent (`all`). They are all your agents on your machine, but one agent can read what another was told, and a prompt may contain a pasted secret. One word to change.
- [ ] **Whether the update panel shows one agent or all of them.** Default: the sessions on the active ticket, most recent first — not a merged stream across every agent.
- [ ] **Version.** 006 + 007 together in one release. **0.4.0** stays the recommendation; 1.0.0 is available if the reshaped product warrants the signal.
