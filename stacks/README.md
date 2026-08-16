# Stack packs

Repo-local, framework-specific conventions to read **before** writing code in a
given stack. Each file is a short, opinionated defaults sheet — not a tutorial.

## Why these live here (and not as plugin skills)

Session-level plugin skills (e.g. the Vercel plugin's Next.js skills) are
excellent but they **don't travel** when you copy `.claude/` + `.specify/` into
a target repo — they live in your Claude Code install, not the repo. These
stack packs *do* travel, so the guidance is present in whatever codebase you
land in, even offline.

They're also subordinate to the target repo: if the codebase you're working in
already does something differently, **the codebase wins** (constitution
Principle III). A stack pack is the default you reach for only when the repo
hasn't already established a pattern.

## How to use

- When a job is in a stack you have a pack for, read that pack during
  orientation (`/orient`), alongside whatever `codebase-scout` reports about
  how *this* repo actually does things.
- If the repo and the pack conflict, follow the repo and say so out loud.

## Available packs

- [`electron.md`](electron.md) — Electron + React + SQLite, delivered via npm.
  The pack for this project.
- [`nextjs.md`](nextjs.md) — Next.js App Router. Carried in with the toolkit;
  **not applicable to Ground Control**, kept only for reuse elsewhere.

## Adding a pack

Copy the shape of `nextjs.md`: a short "defaults" section, a "where things go"
section, a "don't" list, and a "verify" checklist. Keep it to one screen —
it's a reference to glance at, not documentation to read through.
