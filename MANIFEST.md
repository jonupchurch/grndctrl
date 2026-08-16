# Toolkit Manifest

**If you are an AI agent working in this repo, start here.** This repo carries
the `ai-tools` reference toolkit — a spec-driven process plus subagents, slash
commands, and framework packs. The files below are one coherent system, not
loose config. This manifest is the map: what exists, when to use it, and how to
invoke it.

Two invocation notes:
- **In Claude Code**, `CLAUDE.md`/`AGENTS.md` auto-load, `.claude/` is
  auto-discovered, commands run as `/name`, skills via `/name`, subagents via
  the Agent/Task tool.
- **In any other context**, treat every asset below as a file you can *read and
  follow directly* — the prompts and rules are self-contained and work without
  the Claude Code harness.

## Precedence (what wins when things conflict)

1. **The target repo's own existing code and conventions** — always win.
2. **`.specify/memory/constitution.md`** — the ten principles governing *how*
   to work (the source of truth for process).
3. **This toolkit's defaults** — `stacks/`, commands, agents. Reach for these
   only where the repo hasn't already set a pattern.

## The working flow

**New project:** plan the *whole* initial feature set first
(`speckit-specify` → `speckit-plan` across every feature) before implementing
any. Then, **per feature:** orient → clarify scope → plan → implement on a
feature branch (match conventions, write tests alongside, commit atomically) →
verify → merge → narrate throughout. Under a time-boxed/live engagement, cut
ceremony but never cut clarification, verification, or the testing bar.

## Assets

### Rules & process — read before acting
| Path | What it is | Read it when |
|---|---|---|
| `AGENTS.md` | The ten rules, tool-neutral (auto-loaded via `CLAUDE.md`) | Always — it's the operating contract |
| `CLAUDE.md` | Imports `AGENTS.md`, adds Claude Code toolkit pointers | Claude Code sessions (auto-loaded) |
| `.specify/memory/constitution.md` | Full ten principles + rationale + governance | You need the *why* behind a rule, or an edge case |

### Subagents (`.claude/agents/`) — delegate; all read-only, none edit or commit
| Agent | Use when | Returns |
|---|---|---|
| `codebase-scout` | You need the repo mapped (architecture, patterns, where X lives) without watching it happen | Skimmable recon: relevant files, pattern to follow, open questions |
| `verifier` | A change needs real confirmation it works | Pass/fail verdict with evidence (suite, golden path, build) |
| `diff-reviewer` | Before committing/presenting a change | Findings by severity: scope creep, convention mismatch, bugs, leftovers |

### Slash commands (`.claude/commands/`) — the loop as one-shot actions
| Command | Does |
|---|---|
| `/orient` | Fast repo read + kicks `codebase-scout` off in the background |
| `/mini-spec` | 3-bullet what / acceptance criteria / out-of-scope before coding |
| `/verify` | Runs suite + golden path + edge case + build; honest verdict |
| `/commit` | Atomic commit in the repo's message style (inspects first) |
| `/pr` | Opens a PR with a body in the repo's style + honest test evidence |

### Spec-Kit skills (`.claude/skills/speckit-*`) — spec-driven build chain
| Skill | Does |
|---|---|
| `speckit-constitution` | Create/update the project constitution |
| `speckit-specify` | Write/update a feature spec from a description |
| `speckit-clarify` | Ask targeted questions to de-risk an underspecified spec |
| `speckit-plan` | Generate the implementation plan/design artifacts |
| `speckit-tasks` | Generate the dependency-ordered `tasks.md` |
| `speckit-analyze` | Cross-check spec ↔ plan ↔ tasks for consistency |
| `speckit-checklist` | Generate a custom quality checklist for the feature |
| `speckit-implement` | Execute the tasks in `tasks.md` |
| `speckit-converge` | Reconcile the codebase against spec/plan and append remaining work |
| `speckit-taskstoissues` | Turn tasks into ordered GitHub issues |

Engine + templates live in `.specify/` (spec/plan/tasks/checklist templates +
PowerShell automation). Per-project runtime state (`specs/`,
`.specify/feature.json`) is gitignored — this repo ships the engine, not one
project's state.

### Stack packs (`stacks/`) — repo-local framework conventions
| Path | Read before |
|---|---|
| `stacks/electron.md` | Writing any Electron main/preload/renderer, SQLite, keychain, or packaging code — **this project's pack** |
| `stacks/nextjs.md` | Writing Next.js/React App Router code (not used by this project) |
| `stacks/README.md` | Adding a new stack pack (shape: defaults → where things go → don't → verify) |

These travel with the repo (unlike session-level plugin skills), so the
guidance is present even offline. Repo conventions still override them.

### Config (`.claude/settings.json`)
`defaultMode: acceptEdits` (edits auto-apply) + a read-only permission allowlist
for recon/test/build commands, so investigation doesn't stop for a prompt on
every command. Personal/machine-local overrides belong in
`.claude/settings.local.json` (gitignored).

## Extending the toolkit

Add subagents to `.claude/agents/`, commands to `.claude/commands/`, and stack
packs to `stacks/` following the existing files' shape — then add a row here so
the next agent can find them.
