---
description: Verify the current change actually works before calling it done — run the suite, exercise the golden path plus an edge case, typecheck/build, and read back the diff.
argument-hint: "[optional: what the change is supposed to do]"
allowed-tools: Bash, Read, Grep, Glob
---

Verify the current change before we call it done. This is rule 5 (Verify
before "done") — the goal is to be able to say "I *checked* this works," not
"I *believe* this works."

What the change is supposed to do (if given): $ARGUMENTS

Do the following, and report what you actually ran and what you observed:

1. **Read back the diff** — `git diff` (and `git status` for untracked files).
   Confirm it does what was asked and nothing extra crept in.
2. **Tests** — find and run the existing suite (or the relevant subset). If
   there's no suite, say so; don't fabricate one to check a box.
3. **Golden path + one edge case** — actually exercise the primary flow the
   change affects, plus the most obvious edge/failure case. Prefer running the
   real thing over reasoning about it.
4. **Build / typecheck** — if the repo has one, run it.

For anything that's genuinely hard to exercise here, delegate to the
`verifier` subagent rather than skipping it.

Finish with a plain verdict: **VERIFIED** (what you ran + observed),
**PARTIAL** (what's confirmed vs. still only believed), or **NOT VERIFIED**
(why, and what would be needed). Do not overstate confidence.
