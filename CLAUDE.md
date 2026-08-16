# CLAUDE.md

Always-on operating context for this session. The shared, tool-neutral rules
live in `@AGENTS.md` — read them; they govern how to work here.

@AGENTS.md

## Claude Code toolkit available in this repo

This repo ships a portable toolkit (`.claude/` + `.specify/`) meant to travel
into whatever codebase you're working in. `MANIFEST.md` is the full routable
catalog (every asset, its trigger, and how to invoke it); the highlights:

- **`codebase-scout` subagent** — read-only reconnaissance. Spin it off in the
  background to map an unfamiliar repo (architecture, relevant files, existing
  patterns, open questions) while the foreground conversation continues. Never
  edits, commits, or installs.
- **`verifier` subagent** — drives the golden path and runs the test suite,
  reports pass/fail with evidence. Use it to satisfy rule 5 (Verify) as a
  delegable job.
- **`diff-reviewer` subagent** — read-only readback of the current diff for
  scope creep, convention mismatch, and obvious bugs (rules 3 + 5).
- **Slash commands** (`.claude/commands/`): `/orient`, `/mini-spec`, `/verify`,
  `/commit`, `/pr` — the loop encoded as one-keystroke actions.
- **Spec-Kit** (`.specify/` + `speckit-*` skills): the build chain —
  `speckit-specify → speckit-plan → speckit-tasks → speckit-implement`.
- **Stack packs** (`stacks/`): repo-local conventions for specific frameworks
  (e.g. `stacks/nextjs.md`). Read the relevant one before writing framework
  code — these travel with the repo, unlike session-level plugin skills.

## Project docs — keep these current

- **`STATUS.md`** — where the project actually is right now: phase, what
  exists, open decisions blocking progress, the next action. Update it when a
  phase completes, a decision closes, or a blocker appears. It should never be
  more than one session stale.
- **`CHANGELOG.md`** — Keep a Changelog format. Add an entry under
  `[Unreleased]` for anything notable; `STATUS.md` holds the present,
  `CHANGELOG.md` holds the history.

## Default posture

Prefer delegating investigation you don't need to watch (`codebase-scout`,
`/orient`) so the foreground stays free for scoping and decisions. Default to
matching what's already in the target repo over anything in this toolkit — the
toolkit is a starting point, not inherited authority.
