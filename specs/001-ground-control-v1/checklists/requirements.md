# Specification Quality Checklist: Ground Control v1

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Constitution gates (v4.0.0, Part II)

Not part of the standard checklist; recorded here because these are hard gates
and the spec is the first artifact that can violate them.

| Gate | Where the spec honours it |
|---|---|
| XI — Local-first, single-user | FR-005 – FR-008, FR-085, SC-010, SC-011 |
| XII — One service layer; adapters are thin | Deferred to plan; the spec states behaviour, not placement |
| XIII — Mirrored vs authored data separate | FR-050, FR-051, FR-083, SC-007 |
| XIV — Never display provider data without freshness | FR-011 – FR-013, SC-002 |
| XV — Degrade per-provider, never globally | US6, FR-081, SC-005 |
| XVI — Read-only credentials; writes dispatched and confirmed | FR-017, FR-057 – FR-068, SC-009 |
| XVII — Cross-platform, Windows first-class | FR-086, FR-087, SC-012 |
| XVIII — The correlation engine is tested | FR-024, FR-025, SC-003, SC-004 |

## Validation notes

**Iteration 1** — three findings, all fixed in the spec before this checklist was
marked complete:

1. *Severity was asserted without a rule.* The first draft described severity as
   correlation output but never said how it is computed, which fails "testable
   and unambiguous". Fixed by adding the contribution table in FR-029 and the
   configurable thresholds in FR-030.
2. *Drift rules were described in prose.* "Detect when sources disagree" is not
   testable. Fixed by enumerating the nine v1 rules in FR-035 with their
   conditions and suggested resolutions, each with a negative case required by
   SC-003.
3. *"Last real activity" was undefined*, which made the staleness gauge and
   three drift rules unfalsifiable. Fixed by FR-026 (what counts) and FR-027
   (what explicitly does not).

**Standing caveats on two checklist items** — both pass, with the reasoning
recorded so a later reader does not re-open them:

- *No implementation details*: Jira and GitHub are named throughout. They are
  the problem domain, not a technology choice — the product exists to correlate
  those two specific systems, and a version of this spec that said "a ticket
  provider" would be less testable, not more neutral. Every genuine stack fact
  (desktop shell, storage engine, agent transport) is confined to the
  Assumptions section as a recorded decision, per `STATUS.md`.
- *Written for non-technical stakeholders*: the operator **is** a developer and
  the entities are branches, worktrees, and pull requests. The spec is written
  for someone who understands that vocabulary but not this codebase — which is
  the honest reading of the criterion for a developer tool.

**Deliberately not escalated as [NEEDS CLARIFICATION]**: every open question from
`STATUS.md` was closed before specification began. Two items that could have
become markers were instead decided and recorded as assumptions — note-edit
conflict resolution (Assumption 6, reject-not-merge) and dispatch with no agent
connected (FR-064, FR-066: the action waits and the board says nothing is
listening).

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
- Constitution gate XII is the one gate the spec deliberately leaves open; it is
  a `speckit-plan` concern (service placement, adapter shape) and is already
  recorded as decision 13 in `STATUS.md`.
