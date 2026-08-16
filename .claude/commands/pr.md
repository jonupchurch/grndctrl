---
description: Open a pull request for the current branch with a body written in the repo's style — summary, rationale, test evidence, and scope boundaries.
argument-hint: "[optional: extra context or the target base branch]"
allowed-tools: Bash
---

Open a pull request for the current branch.

Extra context / target base (if given): $ARGUMENTS

1. **Gather the facts**: `git status`, the branch's commits vs. the base
   (`git log <base>..HEAD`), and the full diff. Determine the base branch from
   the repo (usually `main`); if unclear, ask.
2. **Check for a template**: if `.github/PULL_REQUEST_TEMPLATE.md` (or similar)
   exists, follow it. Otherwise use this shape:
   - **Summary** — what this PR does, in a sentence or two.
   - **Why** — the motivation / the ask it satisfies.
   - **Changes** — the notable changes as a short list.
   - **Testing** — what was actually run/verified (pull this from `/verify` if
     it was run; don't claim tests that weren't run).
   - **Out of scope / follow-ups** — anything deliberately deferred.
3. **Push** the branch and open the PR with `gh pr create`. If there are
   uncommitted changes, stop and tell me first — don't commit them silently.

Report the PR URL. Keep the body honest about what's verified vs. assumed.
