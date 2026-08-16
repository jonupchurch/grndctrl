# Claude Code Kickoff Prompt — Ground Control (`grndctrl`)

Paste into a fresh Claude Code session in an **empty directory** named `grndctrl`.
Use Opus for this session — it's specify/plan work, not implementation.

---

We are starting a new project called **Ground Control** (npm package and CLI: `grndctrl`).
This session is **bootstrap, orientation, and specification only — write no application
code.** The first deliverables are a constitution and a spec, not a running app.

Work through the phases below in order. Stop at the end of Phase 4 and check in with me
before doing anything else.

## Phase 0 — Bootstrap the toolkit

Install my standard Claude Code toolkit into this repo:

```bash
git clone https://github.com/jonupchurch/ai-tools.git /tmp/ai-tools
cp -r /tmp/ai-tools/.claude /tmp/ai-tools/.specify /tmp/ai-tools/stacks \
      /tmp/ai-tools/CLAUDE.md /tmp/ai-tools/AGENTS.md /tmp/ai-tools/MANIFEST.md ./
```

Then:

1. `git init` if needed, and add a Node-appropriate `.gitignore`.
2. Read `MANIFEST.md`, `CLAUDE.md`, `AGENTS.md`, and `docs/interview-cheat-sheet.md` if
   present. **`MANIFEST.md` is the source of truth for which slash commands, subagents, and
   templates actually exist** — use what it lists, not what you assume.
3. Tell me the available commands and agents before proceeding.

Note: `stacks/` ships a Next.js pack. This project is **Electron + TypeScript**, so there is
no matching pack. Creating `stacks/electron.md` is a Phase 3 task below — don't apply the
Next.js conventions here.

## Phase 1 — Orient

Run `/orient` (or the equivalent the manifest lists). The repo is empty, so this is mostly
confirming the toolkit loaded and establishing the working conventions you'll hold yourself
to. Report what you found.

## Phase 2 — Constitution

Write the project constitution using the Spec Kit constitution flow. It must encode these
non-negotiables:

- **Local-first, single-user.** No hosted service, no telemetry, no phoning home. All state
  on disk. Credentials in the OS keychain — never in a dotfile or in SQLite.
- **The API layer and the MCP server are both thin adapters over one service layer.** They
  must not be allowed to diverge. Any capability lands in the service layer first.
- **Mirrored data and authored data are separate stores** with separate lifecycles. Mirrored
  data (tickets, PRs, CI) is a disposable cache and may be rebuilt from scratch at any time.
  Authored data (notes, pins, active-story selection, snoozes) is the user's and is never
  discarded by a sync.
- **Never display provider data without its freshness.** A polling tool that silently shows
  stale data is worse than no tool.
- **Degrade per-provider, never globally.** Jira being down must not blank the GitHub lanes.
- **Read-only by default.** Anything that writes to GitHub or Jira is an explicit,
  confirmed action — and is out of scope for v1 entirely.
- **Cross-platform: Windows, macOS, Linux.** Windows is a first-class target, so all git and
  path handling must be safe there.
- Node 22+. TypeScript throughout. Tests for the correlation engine are mandatory, not
  optional — it is the highest-value and highest-risk component.

## Phase 3 — Stack pack

Create `stacks/electron.md` following the conventions of the existing packs in `stacks/`.
It should cover: Electron main/renderer/preload boundaries and context isolation, IPC
patterns, safe `shell.openExternal` usage, packaging an Electron app for `npx` delivery with
the runtime fetched from GitHub releases at first run, `better-sqlite3` native-module
handling, and secure credential storage via the OS keychain.

## Phase 4 — Specify

Run `/specify` for **v1** using the brief below. Then stop and check in.

---

# Product brief

**Ground Control** is a desktop command station for a developer running multiple projects
with AI coding agents. It reconciles three sources of truth that otherwise live in separate
browser tabs: **tickets** (Jira), **code** (GitHub PRs, branches, CI), and **local git
state**.

Its reason to exist is the **join** between them. Displaying tickets and PRs side by side is
not the product — correlating them is. The tool's differentiating output is the set of
things no single source can see:

- a ticket marked *In Review* whose PR merged three days ago
- a ticket assigned to me and *In Progress* with no branch and no PR
- a branch 40 commits behind main, or with unpushed local commits
- a PR with unresolved human review threads waiting specifically on me
- a branch with no corresponding ticket

## Locked technical decisions

Do not relitigate these; they are settled.

| Area | Decision |
|---|---|
| Form factor | Electron desktop app |
| Delivery | npm — `npx grndctrl`; Electron runtime fetched from GitHub releases at first run and cached per machine (following the pattern in github.com/jonupchurch/CoCoPilot) |
| Language | TypeScript, Node 22+ |
| Architecture | Daemon/core service layer; HTTP API and MCP server are thin adapters over it; Electron shell is a client |
| Storage | SQLite (`better-sqlite3`), with mirrored cache and authored state as separate stores |
| Ticket provider | **Jira Cloud** — REST v3 + JQL |
| Code provider | **GitHub** — **GraphQL, not REST** (required: `pullRequest.reviewThreads { isResolved, isOutdated }` does not exist in REST) |
| Auth | GitHub fine-grained PAT; Jira Cloud API token + email. Stored in OS keychain, behind an auth-provider seam for later OAuth |
| Sync | Polling only. GitHub with ETags; Jira cached harder (stricter, less documented limits). No webhooks — a local desktop app has no public URL |
| Accounts | **Multi-account above multi-project.** Multiple Jira sites and multiple GitHub orgs simultaneously |
| Theming | Light/dark, defaulting to the OS setting, with an explicit override that wins both ways |
| Display name | "Ground Control" in the UI; `grndctrl` for package, CLI, and repo |
| License | MIT |

## Pages — three, not more

1. **Command** (landing) — fully **global** across all accounts and projects. Project
   grouping is a *filter*, not a layout container. Layout: a status band of at-a-glance
   figures, a filter chip row, then three independently scrollable lanes — **Tickets** /
   **Pull Requests** / **Repos & Branches**.
2. **Work Item** — the join view for one item: ticket, linked branches, PRs, commits, CI,
   and notes on one page.
3. **Connections** — accounts, auth, Jira field mapping, sync health.

A visual design for the Command page is being produced separately. Its HTML mockup and CSS
custom-property tokens will be added to the repo as a design reference before `/plan`.
Spec the *behavior and data* now; leave the visual detail to that artifact.

## v1 scope

**The correlation engine** — the centerpiece, and the first thing to build and test:
- Configurable per-project Jira-key pattern, parsed from branch name, PR title, and commit
  trailers. **Do not depend on Jira's GitHub marketplace integration or smart commits.**
- Models a *workspace* as `repo + worktree + branch`, not a bare branch — multiple worktrees
  of one repo may be active simultaneously.
- Produces work items joining ticket ↔ branch(es) ↔ PR(s) ↔ commits ↔ CI.
- Unit tested against fixture data.

**Providers:**
- Jira: my assigned unresolved issues via JQL; status, and last *real* activity derived from
  `expand=changelog` (the bare `updated` field is unreliable — it ticks on automation and
  backlog ranking). **Custom field IDs differ per Jira site**, so story points / sprint /
  epic link / acceptance criteria must be discovered and user-mapped in Connections, not
  hardcoded. Ship this in v1; retrofitting it is miserable.
- GitHub: my open PRs and PRs awaiting my review; check/CI status; and **review threads
  split three ways** — unresolved, outdated, and by author type (human vs bot, notably
  `copilot-pull-request-reviewer[bot]`). Also compute *ball-in-court* per PR from who
  authored the last comment in each unresolved thread.
- Local git: configured repo paths; per workspace report branch, ahead/behind main,
  dirty/unpushed state, and worktree list.

**Drift rules** (cheap once the join exists, and the differentiator — include at least):
ticket-status vs PR-state contradiction; assigned + in-progress with no branch; branch with
no ticket; PR approved but unmerged; branch significantly behind main.

**Notes** — first-class entities attached to work items, typed as `decision` / `gotcha` /
`question-for-human` / `todo`. **Persistent across restarts** and outliving their work item
(a note survives branch deletion and ticket closure). A `question-for-human` note raises a
badge on the Command page.

**MCP server** (`grndctrl-mcp`, thin standalone package, fails gracefully when the app isn't
running) — **read tools in v1**, plus note writing:
- a **context packet** tool returning ticket + acceptance criteria + branch state + linked
  PRs + prior notes for a work item. This is the flagship tool: it replaces the context an
  agent otherwise rebuilds by hand at the start of every session.
- read and write notes
- query current work items and drift

**Also v1:** everything linkable and openable in the default browser; light/dark with system
default; full state persistence across restarts; per-lane freshness and manual refresh.

**Leave a `session` entity in the schema** — repo, worktree, branch, work item, status —
even though nothing writes to it in v1. An unused table is free; adding a new participant to
the join later is not.

## Explicitly out of scope for v1

Note these in the spec as deferred so they aren't accidentally designed in:

- **All write actions** to GitHub/Jira — branch-from-ticket, prefilled PR creation, Jira
  transitions, commenting. v2.
- Capture inbox; snooze/mute; local full-text search; PR "what changed since I last looked";
  "why did this fail" LLM analysis of CI logs; in-panel LLM calls of any kind.
- Agent session ingestion (the push plane). Schema seam only.
- Azure DevOps, GitLab, and any provider beyond Jira + GitHub.
- Multi-user, sync, hosting, auth-for-others.
- PR auto-summarization — deliberately rejected, do not add it.

## Working agreement for this session

- Ask me clarifying questions before writing the spec, not after. Batch them.
- No application code in this session.
- Where the brief is ambiguous, say so explicitly rather than picking silently.
- Push back if any of the above is internally inconsistent or if the v1 scope is still too
  large to ship — I would rather cut now than discover it in Phase 6.

Start with Phase 0.
