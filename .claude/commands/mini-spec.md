---
description: Produce a 3-bullet mini-spec (what's asked / how we'll know it's done / what's explicitly out of scope) before any code is written.
argument-hint: "the feature or change being asked for"
---

Turn this ask into a mini-spec before we write any code — this is rule 1
(Clarify before building) and rule 4 (Scope discipline) made concrete.

Ask: $ARGUMENTS

Produce exactly three things, tight:

- **What's being asked** — the user story / concrete change, in one or two
  sentences.
- **Acceptance criteria** — how we'll know it's done, as a short checklist of
  observable outcomes (not implementation steps).
- **Explicitly out of scope** — what we are deliberately NOT doing, including
  any adjacent good ideas that are real but separate.

Rules:
- If a requirement is genuinely ambiguous and only the client/user can decide
  it (a business/product call, not something inferable from the code), **stop
  and ask it as a flagged question** rather than picking an assumption.
- If asking isn't possible, state the assumption explicitly and mark it as an
  assumption to confirm.
- Keep it to the smallest complete slice that satisfies the ask. Don't
  gold-plate the criteria.

End with a one-line "Assumptions to confirm:" list if there are any.
