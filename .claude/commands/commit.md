---
description: Stage and commit the current change using the repo's own commit-message conventions.
argument-hint: "[optional: intent/context for the message]"
allowed-tools: Bash
---

Commit the current change, matching this repo's existing conventions.

Extra intent/context (if given): $ARGUMENTS

1. **Inspect first**: `git status` and `git diff` (and staged diff) to see
   exactly what would be committed. If there are unrelated changes mixed in,
   flag them and stage only what belongs in this commit — don't blindly
   `git add -A`.
2. **Match the repo's message style**: read `git log` for the last ~10 commits
   and follow whatever convention is actually in use (Conventional Commits or
   not, tense, scope prefixes, capitalization, length). Do not impose a style
   the repo doesn't use.
3. **Write the message** to describe *what changed and why*, not a play-by-play.
   Keep the subject tight; add a body only if the why isn't obvious.
4. Commit. Do **not** push, and do **not** amend an existing commit unless I
   explicitly ask.

Show me the final message and the commit result. If a pre-commit hook fails,
stop and surface it — don't bypass it with `--no-verify`.
