# Specification Quality Checklist: removing the code host and local git

**Purpose**: Validate specification completeness and quality before implementation
**Created**: 2026-08-19
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details in the spec itself (they live in plan/research/data-model)
- [x] Focused on user value and on what the change costs
- [x] Written so a non-implementer can judge whether the trade is worth making
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No `[NEEDS CLARIFICATION]` markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable and technology-agnostic
- [x] Every success criterion has a named check in [quickstart.md](../quickstart.md)
- [x] Edge cases identified, including the ones that only exist because this is an upgrade
- [x] Every 001 requirement this touches is listed as retired or amended, by number
- [x] Retired identifiers are declared burned, with the reason (FR-114)

## Removal-specific

These are not in the standard checklist. A removal has failure modes a feature does not, and each of these was a real risk in this change rather than a box to tick.

- [x] **What is lost is stated up front**, in a table, before any of the plan — not discovered during implementation
- [x] **The rejected alternative is recorded with its reasoning** — keeping the capability behind a toggle, and why carrying it dark is worse than restoring it from history
- [x] **Authored data is protected by an explicit requirement**, not by the absence of an instruction to delete it (FR-109)
- [x] **Data that becomes unreachable is named as unreachable** rather than described as "retained" and left at that ([data-model.md](../data-model.md#what-becomes-unreachable-and-stays))
- [x] **Every absence assertion is paired with a presence assertion** so a wrong selector fails loudly instead of passing (tracked risk in [plan.md](../plan.md#tracked-risks))
- [x] **The things that must *not* be removed alongside are called out** — the first-run egress entries for the native module download, the per-lane error boundaries, the `notes.questions` query Attention rendered, the outbox's eight operations, and the dismissal rows that now have no reader
- [x] **The breaking changes to published packages are enumerated**, not summarised

## Feature Readiness

- [x] Every user story has acceptance scenarios
- [x] User stories are prioritised and independently testable
- [x] The milestone order is argued, not assumed ([R7](../research.md#r7--in-what-order-can-this-be-done-so-that-every-commit-is-green))
- [x] A real decision point is marked in the task list rather than buried (T015 — look at the board before dismantling the engine behind it)
- [x] Constitution gates re-checked after the data model and contracts were written, and the re-check found something the first pass missed (gate XV)

## Open questions for the operator

Not blockers — each has a stated default that implementation will follow unless told otherwise.

- [ ] **Version number.** Recommendation **0.4.0** for 006 and [007](../../007-agent-console/spec.md) together. This breaks a published MCP tool surface; 1.0.0 is available if the reshaped product warrants the signal.
- [ ] **The outbox.** Recommendation: keep it. After this change nothing in the interface produces an action, which is a real gap — but removing a second subsystem inside a change that already carries the only data-losing migration compounds risk, and it deserves its own scope. See *The outbox question* in the spec.
- [ ] **A repository link on a project.** Out of scope as specified (removal, entire). One field of the same shape as `documentationUrl` if the operator wants the repo reachable in one click.
- [ ] **The correlation badge column** (T006). With only the agent correlation left it is a one-badge column. Decide by looking at the board at T015.
- [ ] **The two-column board layout.** Settled by [007](../../007-agent-console/spec.md), which fills the main column with three more regions. Not a 006 decision after all.
