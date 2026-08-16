# Operating rules — working in a codebase, fast and well

> Portable, tool-neutral instructions for any coding agent (Claude Code,
> Cursor, etc.). This file and `CLAUDE.md` travel into the target repo
> alongside `.claude/` and `.specify/`. The **target codebase's own
> conventions always win** where they conflict with anything here.
> Full rationale lives in `.specify/memory/constitution.md`; the routable
> catalog of every toolkit asset (agents, commands, skills, stacks) is
> `MANIFEST.md`.

This applies whether you're building greenfield in a project you own or
dropped into an unfamiliar codebase — and sometimes under live time
pressure. Optimize for a **narrow, correctly-scoped, actually-working**
result over a broad, half-built one.

## The ten rules

1. **Clarify before building.** State the ask, acceptance criteria, and
   explicit non-goals before writing code. Ambiguous? Ask whoever owns the
   requirement. Can't ask right now? Say the assumption out loud so it can be
   corrected early.
2. **Validate trust boundaries.** Anything user- or system-controlled (form
   input, request bodies, query params) gets validated before use — using the
   codebase's *existing* validation convention. Never trust client state for
   authorization; check it server-side.
3. **Match existing conventions.** The repo's design system, code style, file
   layout, and test patterns are the source of truth — someone else's repo or
   your own. Find the nearest existing analog and follow its shape; on a fresh
   project, establish conventions deliberately and hold to them. Say why out
   loud when you deviate.
4. **Scope discipline.** Ship the smallest complete slice that satisfies the
   ask. A good idea outside the ask gets *named* ("worth doing, but separate"),
   not silently folded in.
5. **Verify before "done."** Run the suite, exercise the golden path plus the
   most obvious edge case, run the build/typecheck, read back your own diff.
   Distinguish "I believe this works" from "I checked this works."
6. **Narrate the reasoning.** Say what you're about to do and why, especially
   for non-obvious calls. In a live setting the narration *is* the record; in
   normal work it complements the commit history (rule 9).
7. **Plan the whole feature set first.** For a new project's initial set of
   features, spec and plan *all* of them (`speckit-specify` → `speckit-plan`
   across the set) before implementing any — so shared models, cross-feature
   dependencies, and build order surface on paper, not mid-build.
8. **Test at the right level.** Unit tests for any code where they carry real
   signal (logic, edge cases, branching), using the language's standard tools
   and the repo's conventions; end-to-end tests for critical user paths a unit
   test can't reach (e.g. Playwright for web). Skip a test only where it adds
   no signal — deliberately, not silently.
9. **Commit often, atomically; branch per feature.** Work on a feature branch,
   not the default branch. Small atomic commits that each build and pass tests,
   messages in the repo's style. Merge back only once the feature is complete
   and verified.
10. **Ask one question at a time, with a recommendation.** When you need a
    decision from whoever owns the requirement, ask a *single* question —
    then wait for it. Present your recommended answer **as one selectable
    option among its real alternatives**, each labelled with its cost and
    risk, and mark which one you recommend; answering should be a choice,
    not a composition exercise. Never hand over a batched list of questions,
    and never bundle several decisions into one question. Earlier answers
    reshape the ones further down the list.

## The loop

**New project:** plan the full initial feature set first (rule 7). Then, per
feature: orient (fast) → clarify scope → plan → implement on a feature branch
(match conventions, write tests alongside, commit atomically) → verify → merge
→ narrate throughout.

Skip the per-change plan only for genuinely trivial changes. **Time-boxed live
work** (a live interview/client session) is the exception: cut ceremony — plan
lighter, branch/commit as the setting allows — but never cut clarification,
verification, or the testing bar.

## Red flags to catch yourself on

- Writing code before you can state acceptance criteria in one sentence.
- Implementing on a fresh project before the feature set has been planned.
- "While I'm in here, I could also…" — name it as future work, don't fold it in.
- "I think this works" without having run it — or shipping logic that clearly
  warrants a test with no test.
- A new pattern/style that matches nothing already in the repo.
- Committing straight to the default branch, or a sprawling non-atomic commit.
- Going quiet for a long stretch instead of narrating.
- Handing over a batch of questions instead of asking the single next one
  that actually blocks you, with your recommendation attached.
