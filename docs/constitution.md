<!--
Sync Impact Report
==================
Version: 4.0.0 (was 3.1.0)
Status: The constitution for Ground Control (`grndctrl`). Structurally two
  documents in one file, because `speckit-constitution` operates on this
  path by overwrite and a second file would be silently dropped on the next
  run:
    Part I  — process principles (I–X). HOW to work. Carried in from the
              `ai-tools` reference toolkit (v2.1.0) unchanged in substance;
              lineage traces back through playm8z, InterruptVector, and
              PrintingSite.
    Part II — product and architecture non-negotiables (XI–XVIII). WHAT
              Ground Control must always be. New in 3.0.0, sourced from the
              project brief at `resources/grndctrl-claude-code-kickoff.md`.
Amendment (3.0.0): MAJOR. Adding a product half restructures the document
  and changes its authority — it is no longer a portable reference that any
  repo may adapt freely, but this project's binding constitution. Part II's
  principles are gates on design, and violating one is a defect, not a
  stylistic difference. Governance rewritten accordingly.
  Also generalized the time-boxed clause: dropped the live-interview and
  client-scoping framing, which does not apply to a personal greenfield
  product. The relaxation itself survives.
Amendment (4.0.0): MAJOR. Principle XVI redefined — was "Read-Only by
  Default", forbidding all provider writes outright and deferring them to v2.
  It now separates *authority* from *effect*: Ground Control's own credentials
  stay read-only and the service layer may never call a provider write API,
  but Ground Control MAY dispatch an individually-confirmed action through the
  action outbox for an agent to execute with its own credentials. This permits
  something the previous wording forbade, so it is a redefinition of a
  non-negotiable, not a clarification. Driven by the design's drift-resolution
  buttons plus the v1 decision to build a bidirectional MCP action outbox.
Amendment (3.1.0): MINOR. Principle X now requires the recommendation to be
  presented as one selectable option among its real alternatives, each with
  its cost and risk stated, rather than as prose. Materially expands the
  guidance without redefining the principle. Propagated to AGENTS.md rule 10.
Prior amendments retained for record:
  2.1.0 — added Principle X (ask one question at a time, with a
    recommendation). Propagated to AGENTS.md (rule 10 + red flags) and
    MANIFEST.md (nine → ten). Removed docs/interview-cheat-sheet.md and all
    pointers to it.
  2.0.0 — re-centered from an interview-only frame to a general build
    reference; added Principles VII, VIII, IX.
Templates checked this pass:
  ✅ plan-template.md — "Constitution Check" derives its gates from this
     file at plan time (`[Gates determined based on constitution file]`);
     no edit needed, but every plan MUST now gate on Part II.
  ✅ spec-template.md, tasks-template.md — no constitution-specific tokens.
  ✅ AGENTS.md, CLAUDE.md, MANIFEST.md — process half already in sync.
Deferred: none. No unresolved placeholders.
-->

# Constitution — Ground Control (`grndctrl`)

Ground Control is a local-first desktop command station that reconciles
tickets (Jira), code (GitHub), and local git state. Its reason to exist is
the **join** between them — displaying the three side by side is not the
product, correlating them is.

This document is binding on the project in two halves. **Part I** governs how
work is done here; it is portable process, and the target-repo-wins caveat
that shipped with it no longer applies, because this *is* the repo. **Part
II** governs what the product must always be; these are design gates, and a
violation is a defect rather than a matter of taste.

# Part I — Process Principles

## Core Principles

### I. Clarify Before Building (NON-NEGOTIABLE)

Before writing code, capture — even in a few bullet points, even just
said out loud — what's actually being asked: the user story, the
acceptance criteria, and what's explicitly OUT of scope. If a
requirement is ambiguous, ask whoever owns it rather than silently picking
an assumption; if asking isn't possible in the moment, state the assumption
out loud before proceeding so it can be corrected early rather than
discovered at the end. Principle X governs the form the asking takes.

Rationale: the single most common way a technically-correct solution
still fails is solving the wrong problem confidently. A five-second
clarifying question is always cheaper than a wrong solution.

### II. Validated Trust Boundaries

Anything crossing a trust boundary — request bodies, query params, MCP tool
arguments, provider API responses, anything a user or another system
controls — gets validated before use, following whatever validation
convention the codebase already has. Never trust client-side state for
authorization; check it server-side.

Rationale: this is universal, not project-specific — the existing
pattern is usually right there to follow, so this principle is about
finding and matching it, not inventing a new one each time. Note that in
this project a *provider response* is a trust boundary too: Jira and GitHub
schemas drift, and custom field IDs differ per site.

### III. Match Existing Conventions

The codebase's design system, code style, file layout, and UX patterns are
the source of truth — not momentary preference. Before writing new code in
an unfamiliar area, find the nearest existing analog (a similar module, a
similar adapter, a similar test) and follow its shape. Where no convention
exists yet, establish one deliberately and then hold to it. Deviating is
sometimes right, but say why out loud when it happens.

Rationale: consistency with what's already there reads as competence and
keeps a codebase legible; a stylistically-foreign addition reads as not
having actually understood the surrounding code, even when the logic is
correct.

### IV. Scope Discipline (NON-NEGOTIABLE)

Ship the smallest complete slice that actually satisfies what was
asked. Resist gold-plating or solving adjacent problems nobody raised.
If a good idea surfaces mid-build that's outside the current ask,
name it out loud ("worth doing, but separate from this") rather than
silently expanding scope.

Rationale: scope creep is the fastest way to end up with a lot in
flight and nothing finished; a narrow, complete change is easier to
review, verify, and trust than a broad, half-built one.

### V. Verify Before Calling It Done

Before saying "done," actually check it: run the test suite, manually
exercise the golden path (and the one most obvious edge case), and read
back your own diff once. Run the build/typecheck. "I believe this works"
and "I checked this works" are different claims — say which one you're
making.

Rationale: a change that breaks the moment someone else touches it is
worse than admitting a rough edge honestly; verification is cheap
insurance against exactly that.

### VI. Narrate the Reasoning

Make the reasoning visible: say what you're about to do and why before
doing it, especially for a non-obvious call (why this approach over an
alternative, why this scope boundary, what you're explicitly deferring).
Keep a short running list of decisions and assumptions. This complements
the commit history (Principle IX) rather than replacing it.

Rationale: the reasoning is often more valuable than the diff itself —
make it visible as you go, don't save it for a retrospective explanation.

### VII. Plan the Whole Feature Set Before Building

For a project's initial set of features, plan ALL of them to completion —
specifications and implementation plans — before writing implementation
code for any single one. Use the Spec-Kit chain across the full set
(`speckit-specify` then `speckit-plan` for every feature) so shared data
models, cross-feature dependencies, and the right build order surface on
paper. Implementation of the set begins only once the set is planned.

Rationale: planning features one at a time is how you discover in week
three that feature A's data model can't support feature C. Surfacing those
collisions up front, while they're still cheap to fix, is the entire point.
This project's join-shaped data model makes the risk acute: the correlation
engine touches every entity, so a modeling mistake is not local.

### VIII. Test at the Right Level

Write **unit tests** for any code where they carry real signal — logic,
edge cases, data transformations, anything with branching a later change
could silently break — using the language's standard tooling and matching
the repo's test conventions. Include **end-to-end tests** wherever feasible
for critical user paths a unit test can't reach. Not every line needs a
test; skip the ones where a test adds no signal (trivial glue, generated
code) — but skip them deliberately, not silently.

**The correlation engine is exempt from any skip.** See Principle XVIII.

Rationale: tests are the executable, durable form of "I checked this works"
(Principle V) — they're what lets the next change be made safely. Choosing
the level is about putting the check where the risk lives.

### IX. Commit Often, Atomically; Branch per Feature

Work on a feature branch, never directly on the default branch. Commit
often in small, **atomic** commits — each a single coherent change that
builds and passes tests, with a message in the repo's convention. Merge
back only once the feature is complete and verified (Principles V and VIII).

Rationale: atomic commits are a reviewable, revertible history and the
durable record of intent — the counterpart to Principle VI's narration.
A feature branch keeps the default branch releasable while work is in
flight.

### X. Ask One Question at a Time, With a Recommendation

When a decision belongs to whoever owns the requirement, ask them — but ask
**one question at a time**, and wait for the answer before asking the next.
Every question MUST carry your recommended answer and the reasoning behind
it, and MUST present that recommendation **as one selectable option among
its real alternatives** — each labelled, each with its cost and risk stated —
so answering is a choice rather than a composition exercise. Mark the
recommended one as such. Never bundle several decisions into a single
question, and never hand over a batched list of open questions.

Rationale: a batch of ten questions is a homework assignment delivered before
the answerer has context on any of them, and it forces them to hold ten open
threads at once. One question carrying a recommendation is a decision that
can be made in seconds, and options with stated costs surface the tradeoff
that prose buries. Because earlier answers constrain later ones —
frequently dissolving questions further down the list entirely — asking
serially also means asking fewer questions overall. This governs HOW
Principle I's clarification happens; it never licenses skipping it.

# Part II — Product & Architecture Non-Negotiables

These are gates, not preferences. Each `speckit-plan` MUST check its design
against every principle here and record any violation in the plan's
Complexity Tracking table with a justification — or change the design.

### XI. Local-First, Single-User (NON-NEGOTIABLE)

There is no hosted service, no telemetry, no analytics, no crash reporting,
and no phoning home of any kind. All state lives on the user's disk. The
only outbound network traffic is to the providers the user explicitly
configured (their Jira sites, their GitHub) and to fetch the Electron
runtime on first run.

Credentials live in the **OS keychain** — never in a dotfile, never in an
environment file, never in SQLite, never in a log. A credential MUST NOT be
written anywhere a backup tool, a screenshot, or a `git add .` could pick it
up.

Rationale: this tool sits on top of a developer's entire working context —
their tickets, their unpushed branches, their private repos. That is an
unusually sensitive aggregation, and the only defensible posture for it is
that the data never leaves the machine. "Anonymous usage metrics" is how
that promise erodes; there is no version of it that is in scope.

### XII. One Service Layer; API and MCP Are Thin Adapters (NON-NEGOTIABLE)

Every capability lands in the **service layer first**. The HTTP API and the
MCP server are both thin adapters over it: they translate transport in and
out, and they contain no business logic, no correlation, and no provider
calls of their own. The Electron shell is a client of the API, not a
privileged sibling with a private path to the data.

Concretely: if a behavior can be reached through the API but not through
MCP, or the two return materially different answers for the same question,
that is a defect. New capability MUST NOT be added to an adapter directly.

Rationale: two adapters over one core is a maintainable shape; two adapters
that have each grown their own logic is two products wearing one name, and
they diverge silently — the API gets a fix the MCP server doesn't, and an
agent quietly acts on a stale understanding of the world. The MCP server is
a first-class consumer here, not a bolt-on, precisely because agents are the
audience.

### XIII. Mirrored and Authored Data Are Separate Stores (NON-NEGOTIABLE)

**Mirrored data** — tickets, PRs, branches, CI results, anything fetched
from a provider or read from a repo — is a **disposable cache**. It MUST be
safe to delete the entire mirror and rebuild it from scratch at any time,
and the app MUST behave correctly when that happens.

**Authored data** — notes, pins, active-story selection, snoozes, field
mappings, and anything else the user created — belongs to the user. A sync
MUST NEVER discard, overwrite, or cascade-delete it. Authored records
reference provider entities by **stable natural key**, not by a mirrored
row id, so they survive the mirror being rebuilt.

The two live in separate stores with separate lifecycles and separate
migration paths.

Rationale: mixing them means a cache rebuild can destroy the user's own
work, which is unforgivable and also unrecoverable — there is no server-side
copy to restore from (Principle XI). Keeping the boundary structural rather
than conventional means it cannot be violated by accident in a
join-heavy codebase where nearly every query touches both.

### XIV. Never Display Provider Data Without Its Freshness (NON-NEGOTIABLE)

Every piece of provider-derived data shown to a user or returned to an agent
MUST carry when it was last successfully retrieved. "Stale" and "failed to
refresh" are **distinct states** and MUST be distinguishable — a lane that
has not updated in an hour because polling is slow is a different situation
from one that has not updated because the token expired.

This applies to MCP responses exactly as it applies to the UI: a context
packet handed to an agent MUST state the age of what it contains.

Rationale: a polling tool that silently shows stale data is worse than no
tool, because it converts "I don't know" into "I know, incorrectly." The
whole value proposition is trusting the board at a glance; an unmarked stale
board destroys that trust permanently the first time it burns someone. And
an agent acting confidently on hour-old branch state will do real damage.

### XV. Degrade Per-Provider, Never Globally (NON-NEGOTIABLE)

A failing provider MUST NOT degrade any other provider's data. Jira being
unreachable, rate-limited, or misconfigured leaves the GitHub and local-git
lanes fully populated and clearly labelled, and vice versa. Failure is
scoped to the **connection**, not the app: one Jira site being down does not
affect another Jira site.

Correlation MUST degrade gracefully too — a work item whose ticket cannot be
fetched still shows its branches, PRs, and notes, marked as partially
resolved rather than hidden.

Rationale: a developer's tools are most needed exactly when something is
broken. An app that blanks itself because one of five connections failed has
chosen a purity that serves nobody, and the failure mode is silent: the
lanes just look empty, which reads as "no work" rather than "no data."

### XVI. Read-Only Credentials; Writes Are Dispatched and Confirmed

Ground Control's own credentials are **read-only against providers**. The
service layer MUST NOT call a Jira or GitHub write API — no create, modify,
transition, comment, or delete — using the user's stored tokens. That is the
line the app never crosses itself, and it does not move.

Ground Control MAY **dispatch** an action for an agent to perform, through the
action outbox. A dispatched action MUST be individually confirmed by the user
before it enters the outbox, MUST record what was dispatched and when, and
MUST remain visible through its pending, claimed, and completed states. The
executing agent acts with its own credentials and its own authority; Ground
Control never lends it any, and MUST NOT dispatch as a side effect of a sync,
of a drift rule firing, or of any other automatic trigger.

Be honest about what this is: a dispatched action produces a provider write
that Ground Control caused. The principle is not that no write ever happens —
it is that **Ground Control never holds write authority**, and that every
write is a deliberate, individually confirmed act with an audit trail.

The user's local repositories keep the stricter posture: their working tree,
index, and branches MUST NOT be modified. Any operation that touches the
network on the user's behalf (notably `git fetch`) is opt-in, and its effect
on freshness is displayed.

Writes to local authored state — notes, sessions, field mappings, selections,
dispatched actions — are unrestricted.

Rationale: trust in an observability tool is asymmetric; it takes months to
earn and one unexpected mutation to lose. Separating *authority* from *effect*
is what preserves it — the tool cannot act on its own, a human authorizes each
action, and an agent with its own credentials carries it out where an audit
trail already exists. A tool that transitions a ticket you did not mean to
transition, or fetches over a delicate rebase, becomes a tool you turn off.

### XVII. Cross-Platform, With Windows First-Class (NON-NEGOTIABLE)

Windows, macOS, and Linux are all supported targets, and **Windows is not
the afterthought**. Path handling MUST NOT assume POSIX separators, case
sensitivity, or forgiving path lengths. Git interaction MUST tolerate CRLF
translation, `core.autocrlf`, worktrees on other drives, and paths with
spaces. Anything that shells out MUST be tested on Windows before it is
called done.

Rationale: Windows is the primary development machine for this project, so a
POSIX-only assumption is not a portability nicety deferred to later — it is
an immediate break. These bugs are also disproportionately expensive
discovered late, because they hide in string handling spread across the
whole codebase rather than in one porting layer.

### XVIII. The Correlation Engine Is Tested (NON-NEGOTIABLE)

The correlation engine — the code that joins ticket ↔ workspace ↔ PR ↔
commits ↔ CI and derives drift — MUST have unit tests against fixture data,
and they are a merge gate, not a follow-up task. Every drift rule MUST have
a test that produces it and a test that correctly declines to produce it.
Every new correlation case discovered in real use MUST arrive with a fixture
reproducing it.

The stack is TypeScript throughout on Node 22+, and the engine MUST be
testable without network access, without a real Jira or GitHub, and without
Electron.

Rationale: this is simultaneously the highest-value and highest-risk
component. It is the entire differentiator, and it is the one place where a
subtle bug produces confident, plausible, wrong output — a false "your
ticket is in review but the PR merged" is worse than showing nothing,
because the user will act on it. It is also pure logic over data, which
makes it the cheapest thing in the codebase to test properly. Keeping it
free of Electron, network, and provider SDKs is what preserves that.

## Workflow

**Starting the project (its initial feature set):** plan the whole set first
(Principle VII) — `speckit-specify` + `speckit-plan` across every feature —
before implementing any. Then take each feature through the loop below.

**Per feature or change:**

1. **Fast orientation pass** — stack, entry points, directory conventions,
   how an action flows, and the handful of existing patterns to match.
   Delegate it to a read-only reconnaissance agent when there is enough code
   to be worth mapping.
2. **Clarify scope** — the actual ask, acceptance criteria, explicit
   non-goals (Principle I), asking per Principle X.
3. **Plan** — the full-set plan (Principle VII) at project inception, or a
   lightweight per-change plan for a single change. Gate the design against
   Part II. Skip the lightweight plan only for genuinely trivial changes.
4. **Implement on a feature branch, matching existing conventions**
   (Principle III), **writing tests alongside the code** (Principles VIII
   and XVIII) and **committing atomically** (Principle IX).
5. **Verify** (Principle V) before presenting it as finished.
6. **Merge the feature branch** once complete and verified (Principle IX).
7. **Narrate throughout** (Principle VI); keep `STATUS.md` and
   `CHANGELOG.md` current.

## Governance

This constitution is binding on Ground Control. Where Part I's process
guidance conflicts with a convention this codebase has already established,
the codebase wins (Principle III). **Part II does not yield to convenience:**
a design that violates one of XI–XVIII is changed, or the violation is
recorded in the plan's Complexity Tracking table with an explicit
justification and accepted deliberately.

**Amendment procedure.** Every amendment MUST update the Sync Impact Report
above and bump the version in the same change.

The Sync Impact Report and the amendment notes in it refer to files that used
to sit beside this one — `AGENTS.md`, `CLAUDE.md`, `MANIFEST.md`, `.claude/`,
`.specify/`. That was the `ai-tools` agent toolkit, which was removed from this
repository on 2026-08-16 so that it could travel into other codebases from its
own home at `github.com/jonupchurch/ai-tools`. The references are left as
written because they are a record of what was true at each amendment, not
live instructions. **This document stayed** — Part II is Ground Control's own
design gates, cited by the conformance tests, the specs and the source, and it
is a product document that happened to live in a toolkit directory.

**Versioning policy.** MAJOR — a principle removed or redefined, or the
document's authority restructured. MINOR — a principle added, or guidance
materially expanded. PATCH — clarification and wording.

**Compliance review.** `speckit-plan` gates on Part II at design time;
`speckit-analyze` cross-checks spec, plan, and tasks for drift from it. The
locked technical decisions in `resources/grndctrl-claude-code-kickoff.md`
are settled inputs, not principles — they are not relitigated here, and this
constitution does not restate them.

**Time-boxed mode.** Under genuinely time-boxed, single-task work,
Principles VII and IX may be relaxed — plan lighter, commit and branch as
the setting allows. The verification and testing bar (V, VIII, XVIII), the
non-negotiables (I, IV), and all of Part II still hold.

**Version**: 4.0.0 | **Ratified**: 2026-08-14 | **Last Amended**: 2026-08-14
