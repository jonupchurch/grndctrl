# Status — Ground Control (`grndctrl`)

**Last updated:** 2026-08-18 (0.2.0 cut, not yet tagged) · **Stage:** released · **On npm:** 0.1.3 is `latest` on all four packages — `npx grndctrl`. 0.1.0 is deprecated on `grndctrl` and `@grndctrl/desktop`; 0.1.1 works but has no agent-push.

**0.2.0 is bumped in the tree and not on the registry.** Four manifests and two
version constants say `0.2.0`; nothing is tagged, so nothing is published. The
release is one command — `git tag v0.2.0 && git push origin v0.2.0` — and it must
be run from `main` after `005-priority-and-points` merges.

**0.1.2 is the first release published by the workflow rather than by hand.**
Trusted publishing is configured per package, so a release is now: bump, commit,
tag `vX.Y.Z`, push. It carries SLSA provenance, which hand-published 0.1.1 does
not — a difference that doubles as a control when checking that the tag-driven
route was the one taken.

A living snapshot of where the project actually is. Update it whenever a phase
completes, a decision closes, or a blocker appears — it should never be more
than one session out of date. Historical detail belongs in `CHANGELOG.md`; this
file describes only the present and the immediate next step.

## Where we are

### 0.2.0: two ticket columns, headings, and the drift panel moved down

Three changes the operator asked for, and one defect found while making them.

**The ticket lane carries priority and story points.** Priority is the tracker's
own word, unmapped — the same discipline `statusCategory` already encodes, and
without even a category to fall back on, because Jira's priority field carries a
name and an icon and nothing that orders them. Story points needed a lookup:
there is **no fixed field id**, since `Story Points` and `Story point estimate`
are different custom fields numbered per site. The provider reads
`/rest/api/3/field` once per sync, prefers the company-managed field when both
exist, and refuses `timeestimate` — numeric, not custom, and worth 57,600 points
on a two-day ticket. A failed lookup loses the column and not the lane.

`mirror.db` is at **migration 2**. Two nullable columns, no `DEFAULT`: a
`DEFAULT 0` would have told the operator that every ticket they had ever synced
was estimated at zero.

**Unknown is never `0`.** `Number(null)`, `?? 0` and `|| 0` all produce one, all
typecheck, and all put an estimate on a row that nobody made. Store and row keep
a genuine zero-point estimate distinct from an absent one.

**All three lanes now name their columns**, per lane — a ticket has a summary, a
pull request has a title, a branch has a ticket. The two ticket columns exist on
the ticket lane only: a column that can never hold anything is noise rather than
the meaningful absence the row's other placeholders carry.

**The Attention panel moved below the tickets.** It was above all three lanes
because drift is the one thing on this board that nothing else reports. The
argument missed that the panel is *tall*, so a board with three findings opened
on the disagreements and pushed the work below the fold.

**The defect the headings exposed: columns did not line up down a lane.** The
row's last two grid tracks were `auto`, and the note badge is `+` on one row and
`12` on the next. Each row is its own grid container, so the wider badge came out
of the flexible title column and shifted every column after it on that row alone.
The claim at the top of `Row.tsx` — that the eye reads a column rather than
re-parsing each row — had been quietly false. Both tracks are pinned now, and two
end-to-end tests assert the pixel offsets. **Both were made to fail before being
relied on.**

Second lesson from the same change: the heading was written as `row row--head`,
which made it a row to everything that looks for one. `perf.spec.ts` counts
`.row` to assert SC-013's two hundred items and read 302. It is `lane__headings`
now — it borrows the grid and takes none of the identity.

**Not fixed, and not mine: `greyscale.spec.ts` fails on `main`.** Three of its
five tests cannot find a `good` severity on the board. `every-severity.json`
carries absolute timestamps from 2026-08-14, and severity is derived partly from
staleness — so past the three-day threshold the scenario no longer produces the
severity it is named for, and the file ages out of its own purpose. Confirmed by
running it on a clean checkout with none of this session's changes. The fix is a
scenario whose timestamps are relative to the run, which is a change to how
seeding works rather than a line edit.


### The repository was public, and it named the employer

Found by asking rather than assuming: `gh repo view` said `PUBLIC`, created
2026-08-14. It had been public for a day with the employer's name and Jira site
in `STATUS.md`, and with statistics derived from a real client's backlog in
`STATUS.md`, `CHANGELOG.md`, `sync.ts` and one test. **Zero forks, zero stars,
zero watchers**, and no credential ever entered the repository — `.env.local`
was never committed and every token-shaped string in history is a test
placeholder.

**The repository is now private.** With no forks, that ends public access to
every object rather than merely hiding the current tip.

**`scripts/audit-client-refs.ts` is the gate**, on the secret audit's terms:
zero hits is the only pass, with no allow-list of expected occurrences. Two
properties are the whole design:

- **The denylist is not in the repository.** Writing the terms into a constant
  publishes, on every clone, the strings the gate exists to suppress.
  `.client-denylist` is gitignored; CI gets it as a secret.
- **A missing or empty denylist fails.** "Nothing was found" and "nothing was
  looked for" are the same empty list and opposite facts — the rule that already
  made the egress recorder write a marker when it loads.

A second arm finds any `*.atlassian.net` host outside the invented placeholder
set, because a denylist only finds what someone thought to list. On the first
run it identified the real site on two lines **without being told the name**.

Probed four ways: 13 hits across the tree, 97 across 558 history blobs, a hard
fail with the denylist removed, and a planted term caught then cleared. Two
things it caught that were mine: the test file, which plants matching strings to
prove the matcher works and so failed on its own source, and the audit's own
docblock, which quoted the real figures as an illustration. **The example is
always the last place anyone looks.**

**History was rebuilt, not rewritten.** 97 occurrences across the old history
meant scrubbing the files and committing the fix would leave every previous
version reachable by SHA. `clean-main` is a single squashed commit whose history
has never contained a client string — verified with `--scope history --rev
clean-main`, 315 blobs, zero hits — with the old history retained privately.
File inventories match at 316 both sides, so nothing was lost in the rebuild.

**Since done (2026-08-16):** the clean history was pushed to a new repository,
`jonupchurch/grndctrl`, which is **public**. The old one is retained privately as
`grndctrl-archive` and must stay that way — it holds the pre-scrub history. The
gate runs on every push and again in `release.yml` before `npm publish`.

### Packaging is verified on all three platforms, and finding that fixed two bugs

`.github/workflows/packaging.yml` packs the tarballs, installs them into a
directory with no relationship to the workspace, and runs `npx grndctrl` with an
empty runtime cache on Windows, macOS and Linux. **All three green.** The app
reports on itself through `GRNDCTRL_SMOKE`, so a runner can verify what
previously needed a person watching a window.

What that proves: the tarballs install standalone, the runtime downloads and its
checksum verifies, it unpacks leaving no staging directory, the ABI check
passes, Electron boots, the native module *loads* (`app.status` reads both
databases), the renderer paints, and a second run downloads nothing. **What it
does not prove: that a human would recognise the board.** That remains a Windows
claim, made by eye, and is not asserted elsewhere.

Two real bugs came out of building it, neither findable by reading:

- **`npx grndctrl` could not start on Linux at all.** Electron ships
  `chrome-sandbox`, which Chromium requires to be root-owned and setuid; npm
  unpacks as the invoking user and cannot arrange that, so Chromium aborted
  rather than run unsandboxed. Fixed by falling back to the **namespace
  sandbox** (`--disable-setuid-sandbox`) — a different sandbox, not a weaker
  one — and refusing outright when neither is available, with both one-line
  fixes printed. Never `--no-sandbox`: the renderer displays strings fetched
  from the network, which is the entire reason the sandbox is there.
- **`app.status` was registered by nothing.** Implemented, exported, reachable
  from no surface. Its stated purpose was to give the packaging failure a place
  to surface, so the ABI diagnostic for the riskiest failure in the project was
  itself unreachable. The XII conformance gate could not catch it: an operation
  nobody registered is not in the registry to check.

**T163 is closed as not needed**, on evidence rather than by assumption:
`fetch-native.mjs` fetched a working Electron-ABI `better-sqlite3` on all three
platforms, so publishing our own prebuilds would solve a problem no shipped
platform has. It reopens if a platform upstream does not cover is added —
darwin-x64, linux-arm64 and win32-arm64 are untested because nothing ships to
them.

### The product

**171 of 176 tasks** (175 planned plus T176, the always-on-top toggle added
mid-M4; the count said 162 and was hand-tallied — it is now counted from the
file). **734 unit tests, 60 end-to-end. The application launches,
the board is on screen, and the golden path runs end to end** — configure,
render, open each row type, write a note, confirm a dispatch, and find the
action still queued after a restart.

**The board now refreshes itself** (T074). Until today nothing polled:
`pollIntervalSec` had been in the settings schema since M2 and only the
*freshness* calculation read it, so lanes went stale on the schedule of a poll
that did not exist and the numbers were current only because Refresh was being
clicked. The scheduler is in core with injected timers — 60s GitHub, 5min Jira,
per-connection backoff capped at 30 minutes, local git scheduled under its own
reserved id — and its polls travel through the same observed dispatch the window
uses, so a background refresh moves what is on screen.

**It now runs on live provider data**, and that is where the day went. Jira is
connected (a real Jira Cloud site) and GitHub is connected against a personal
account. Both Phase 0 unknowns are settled against real credentials rather than
documentation: a read-only fine-grained token **can** run `Ref.compare` (R3), and
the bulk changelog **does** return history, so ticket staleness is real "last
activity" and not the `updated` fallback FR-027 exists to distrust.

**Pointing it at real data found eight bugs in code that was marked done and had
passing tests. None of the 533 tests failed on any of them.** Five commits, each
probed by reverting the fix and confirming only its own assertions fail:

- One connection serving several projects **deleted two thirds of the data** and
  reported `ok: true` for every project. Every `replaceX` deletes by connection
  while the sync fetched per project. Invisible because every fixture bound one
  project to one connection.
- Ticket search **dropped every page after the first** — the seam returned a
  `nextPageToken` and took no parameter to send one back. 100 of several hundred.
- `fetchChangelogs` named every issue in one request; the single page had been
  keeping it under Atlassian's ceiling by accident. Now batched.
- `viewerIdentity` was **never resolved by anything**, so `operatorAccountIds`
  was empty and every "is this mine?" answered no. The board filed the
  operator's own tickets under someone else and claimed the unassigned ones.
- The renderer's hand-copied domain types had **drifted**: it read `aheadBy`,
  `behindBy` and `repoKey` off a workspace, none of which core has ever sent;
  typed `unpushedCommitCount` non-null when null means "never pushed"; compared
  `reviewDecision` against GitHub's raw casing when the provider normalises it,
  so **no pull request could ever render "Changes requested"**; and filtered
  Attention nudges on `!n.resolved` when the wire carries `resolvedAt`.
- `comparisons` was a correlation input **nothing read**. The whole compare path
  fetched ahead/behind, stored it, and dropped it, and the lane printed "in
  sync" over the gap — for a branch 83 commits behind, and for one never pushed.
  FR-018 exists to forbid exactly that sentence.

**Since then: the dialog layer (T148–T153, T155).** A modal primitive built on
native `<dialog>`, the notes modal with the conflict path, note badges on the
row, the drift confirmation flow, the outbox state display, and the golden-path
end-to-end test that drives all of it in one session. Five gates probed by
breaking them; a sixth turned out not to be a gate at all and the comment
claiming it was is now corrected.

Three defects of the same familiar shape came out of it:

- The preload's error type stopped at `{ code, message }` while `details`
  crossed IPC at runtime the whole time. What it dropped was the `current` note
  on a `conflict` — the row core deliberately attaches so a lost revision race
  can show the operator what they lost to instead of forcing a reload that
  discards their draft. The preload's own comment said "`conflict` opens the
  note modal's conflict state"; nothing could.
- `size="wide"` on the modal matched its rule and did nothing, because
  `max-width` lets a panel shrink to its content.
- `.row__title` carried `user-select: text` so a ticket title could be dragged
  out and pasted. Covering the row with a button to make the whole thing one
  click target silently ended that. The declaration is removed rather than left
  in the file looking like a feature — **a real, if small, loss**, taken
  deliberately so the row's primary action stays one honest `<button>` rather
  than a `<div>` behaving like one.

**Window state (T154, T176).** The window reopens where it was left, refusing
a position on a display that is no longer attached — restoring those
coordinates gives a window that is running, focused, taking keystrokes and
invisible, with no way to recover it from inside the application. The active
project and court filters persist too; `windowGeometry`, `activeProjectId` and
`mineOnly` had all been in the settings schema since M2 with nothing writing or
reading them.

The **always-on-top toggle** you asked for is in the titlebar. It takes no new
channel: the renderer writes a setting, and main applies it to the window by
watching `settings.update` go past. A second channel would be a second way to
change one fact.

Two more of the same shape came out of it: `.ghost[aria-pressed="true"]` was
not styled, so the first pressable ghost button in the titlebar announced its
state to a screen reader and showed it as a one-character glyph difference at
11px.

**Degradation (T157).** Writing the e2e found three defects, all in the same
place: the application could not tell "nothing there" from "could not look".
A refresh with the credentials gone reported `ok: true`, an unreachable
checkout reported "no branches", and the credential gap `sync.status` has
always computed was never displayed. The board now says plainly that it cannot
refresh, names which connections, and keeps every lane's cached rows and every
control working.

**Greyscale (T158).** Colour is removed entirely rather than desaturated, and
the four severity marks are compared as images: all six pairs must differ. A
second scenario, `every-severity.json`, exists because severity is derived and
never declared — putting all four on screen means constructing four items whose
facts produce them.

**Filter performance (T159).** 16ms to narrow a 200-item board across six
projects, 33ms for the court filter, against a 100ms budget — measured inside
the page from the click to two animation frames later, which is the first
moment the operator could see it. **M4's end-to-end work is complete.**

**`npx grndctrl` works.** Verified on Windows from packed tarballs into a clean
directory with the runtime cache cleared (T166): the Electron runtime downloads,
its checksum verifies against the one published in the same release, it unpacks
into a per-version slot leaving no staging directory behind, the ABI is checked
against the bundled native modules, and the app launches. A second run
downloads nothing and prints nothing.

**The three privacy promises are checked, and they hold on this machine.**
Not asserted — run (T169–T171):

- **No credential outside the keychain** (SC-011). 51 files in the real data
  directory, both live credentials, several encodings including the
  `base64(email:token)` form a Jira `Authorization: Basic` header leaves behind.
  Zero hits.
- **No egress but the operator's own providers** (SC-010). **Two captures, not
  one**, because they catch different things and neither substitutes for the
  other. A **35-minute idle run** with the poll scheduler live, on real
  credentials — the duration is the point, since it is what would catch
  something firing on a timer, an update check or a ping at startup+N. And a
  **driven pass** deliberately exercising Jira auth, search and bulk changelog,
  GitHub auth, repository read and branch comparison — the paths an idle window
  never touches. Both reached `api.github.com` and the configured Jira site and
  **nothing else**, across five recorder-loaded processes. The earlier result
  rested on a few minutes and is superseded.

  Probed: a capture stripped of its loader marker **fails** — "a capture nobody
  took is not a clean capture" — so an empty host list can never be mistaken for
  a clean one.
- **Nothing in the shipped tree reports anything** (XI). 236 production
  packages, no reporter, no unexpected install script.

**~~What is not built yet~~ — superseded, 2026-08-16.** This paragraph listed
T167, T168, T163, T172 and the provider fixtures T038–T040 as outstanding. All
but T172 are now closed: npx is verified on all three platforms by CI, T163 is
closed as not needed on the evidence that upstream prebuilds cover every shipped
platform, and the fixtures are recorded and replaying. **T172 alone remains**,
and the operator deferred it on 2026-08-16. Kept rather than deleted because the
reasoning it recorded still holds: T038–T040 were **ticked without being done**,
and that was found only because a later task needed them.

**~~Blocked on someone else~~ — that blocker was stale, 2026-08-15.** It said
work repositories needed an org-owned fine-grained token and that the current
one reached only two personal repos. Asked directly, the token returns four:
two personal and **two work repositories**. Nothing is waiting on an org owner.

Recorded here because it is the second time this file has carried a resolved
problem as a live one — the leaked credential was written up as revoked when it
was not. **A blocker is a claim about the present and decays like any other; ask
the system rather than the note.**

Separately, the work checkouts are not on this machine, so the local-git
half of correlation belongs wherever the work actually happens — which is what
`npx grndctrl` is for, not a second clone of this repo.

**M4 so far:** the Electron main process, the IPC adapter (the third surface the
XII conformance gate now covers), the hand-enumerated preload bridge, the
`links.resolve` launcher gate, the CSP, the design tokens and primitives, and
the board itself. T163 was pulled forward from Phase 6 because it was what stood
between a built shell and a running one.

**M3 (The agent surface) is complete** — notes, sessions, the durable action
outbox, the loopback HTTP adapter, the handshake file, and `grndctrl-mcp`.

**M3 exit criterion, met:** a real MCP client starts a session over a linked
transport, heartbeats, reports activity, ends it, writes a `question-for-human`
note, and loses a revision race — through the whole path, client → protocol →
tool → loopback HTTP → registry → service → SQLite and back, with no UI in
existence (`packages/mcp/test/server.test.ts`).

### What M3 changed that was not on the plan

- **The registry backlog moved here from M2.** T079–T084 were ticked and never
  built; the registry was empty, which meant the XII conformance gate passed
  vacuously. It now holds 34 operations — 24 of them on the agent surface — and is checked against a *running*
  adapter rather than a declared list. `ALL_ADAPTERS` is gone for the same
  reason: a hand-maintained list agrees with the wiring until it does not.
- **Ten operations are `ui-only`, not three.** The outbox three
  (`mintConfirmation`, `enqueue`, `cancel`), plus `drift.dismiss`/`undismiss` —
  an agent that can hide a finding can suppress the evidence of its own mistake
  — plus configuration (`projects.upsert`/`remove`, `settings.get`/`update`,
  `connections.list`). None is a provider write, so XVI covers none of them; the
  exposure field is what stops them.
- **Three deviations from the contracts, each argued in code**: `notes.update`
  takes `resolved?` (without it a question can only be settled by deleting it);
  `notes.questions` drops its `projectId` filter (subject→project is
  correlation's job, and a second copy would disagree); and the ui-only count
  above.
- **One new spawn site in core.** `handshake.ts` runs `icacls` on Windows,
  because Node's file `mode` says nothing about an ACL. This tripped the
  existing "nothing in core spawns a process" gate, which was right to fire. The
  exemption is named and then constrained by a second test: one binary, one
  platform, no shell, arguments that cannot be influenced.

**M2 exit criteria, all met:**

- The full suite passes with **Electron physically removed from
  `node_modules`** — verified by moving it aside and re-running, not assumed
  (XVIII). Core's only mention of Electron is reading `process.versions` for
  the ABI diagnostic.
- Every drift rule has a firing test **and** a declining test.
- Ten consecutive runs are byte-identical including finding ids, and output is
  unaffected by the order inputs arrive in (SC-004).
- `grndctrl-cli board --fixtures fixtures/scenarios/merged-pr-open-ticket.json`
  prints a correlated board with the D1 finding, both sides of its evidence,
  and its suggested resolution.
- Killing each provider in turn leaves every other lane populated (SC-005), and
  stale / failed / never-synced stay three distinct states (XIV).

**Still true from M1:** two separate database files, the keychain round-tripping
against the real Windows Credential Manager, the XII conformance gate live, a
mirror rebuild preserving every authored row (SC-007), and no credential in any
byte of any file in the data directory (SC-011).

| Phase | State |
|---|---|
| 0 — Bootstrap the toolkit | ✅ Complete |
| 1 — Orient | ✅ Complete |
| 2 — Constitution | ✅ Complete — v4.0.0 |
| 3 — Stack pack (`stacks/electron.md`) | ✅ Complete |
| 3.5 — Design review | ✅ Complete |
| 4 — Specify v1 | ✅ Complete — `specs/001-ground-control-v1/spec.md` |
| 5 — Plan | ✅ Complete — plan, research, data model, contracts, quickstart |
| 6 — Tasks | ✅ Complete — 175 tasks across 7 phases |
| 7 — Implement · Setup | ✅ Complete — T001–T012 |
| 7 — Implement · M1 Skeleton | ✅ Complete — T013–T035 |
| 7 — Implement · M2 Engine | ✅ Complete — T036–T078 |
| 7 — Implement · M3 Agent surface | ✅ Complete — T079–T121, 423 tests |
| 7 — Implement · M4 Shell | 🟡 In progress — T122–T147, T156, T163 done |

## What exists

- ~~The `ai-tools` toolkit~~ — **removed from this repository 2026-08-16.** It
  now lives only at `github.com/jonupchurch/ai-tools`, which is where a toolkit
  meant to travel into other codebases can actually do so. A month of
  improvements made during this build were backported there first — principle
  X, the ten rules, and `stacks/electron.md`, which did not exist there.
  Everything is still in this repository's history and in `grndctrl-archive`.
- **Constitution v4.0.0 — now `docs/constitution.md`.** Part I process
  principles (I–X), Part II product and architecture gates (XI–XVIII). It moved
  rather than left with the toolkit: Part II is Ground Control's own design
  gates, cited by the conformance tests, the specs and the source in 47 files.
  A product document that happened to live in a toolkit directory.
- **`resources/design/`** — three Design Canvas files, reviewed:
  - *Brand* — three wordmark directions; **1a "Tracking" is locked** (Archivo
    600, tracking-ring mark, accent held back from status and project sets).
  - *Design System v0.1* — role-addressed tokens with a real dark palette,
    status as shape + color + label, 34px row primitive with fixed slots,
    staleness gauge, ball-in-court glyphs, motion budget.
  - *Ground Control* — the landing page: titlebar with project chips and
    theme toggle, 4 stat tiles, Attention, Agent sessions, Tickets, Pull
    requests, Open branches, Ball in court.
  - Note: the files reference `./support.js`, which is not in the folder, so
    they will not render locally as-is.
- The product brief and kickoff prompt in `resources/`.

- **`specs/001-ground-control-v1/`** — the v1 spec: six prioritized user
  stories, 87 functional requirements, 15 measurable success criteria, a
  severity rule table, the nine v1 drift rules, and 14 key entities. Alongside
  it, `checklists/requirements.md` records the validation pass and maps every
  constitution Part II gate to the requirements that honour it.

- **The plan** (`plan.md`, `research.md`, `data-model.md`, `contracts/`,
  `quickstart.md`) — closes constitution gate XII with an operation registry and
  a conformance test, sequences the build headless-first across four milestones,
  and records ten resolved unknowns. Two of those unknowns changed the design:
  Jira no longer returns issue history in the search call, and GitHub's
  ahead/behind is a per-branch call with a real rate-limit cost.

- **`tasks.md`** — 175 tasks across setup, the four milestones, packaging, and
  the privacy audits, with a critical path and parallel tracks marked. Three of
  them are gates that fail the build rather than reporting a finding: T027
  (adapter conformance, XII), T071 (eighteen drift tests, XVIII), T108 (no auto
  dispatch, XVI).

- **`packages/`** — the monorepo. `core` holds the framework-free service layer:
  domain and natural keys, both stores, the operation registry, the keychain
  seam, the correlation engine, the nine drift rules, the Jira/GitHub/git
  providers, sync, and now notes, sessions, the outbox, the operation registry's
  34 entries, the loopback HTTP adapter and the handshake file. `cli` renders the
  board as text; `mcp` is the MCP server. `desktop` holds the Electron main
  process, the preload bridge and the React renderer; `launcher` is still
  scaffolded and empty. Three ESLint boundary rules are in force and verified to
  fire: core cannot import Electron or a UI framework (XVIII), adapters cannot
  reach past the registry (XII), and the renderer cannot import core **values**
  — types only, since `import type` is erased before the bundler runs and the
  rule exists to keep `better-sqlite3` out of a sandboxed process.
- **`fixtures/scenarios/`** — checked-in correlation scenarios. The first is the
  canonical drift case named in `quickstart.md`, and a test asserts the
  quickstart's stated expectation so the documented demo cannot rot silently.

- **`packages/mcp`** — `grndctrl-mcp`, the third adapter. 24 tools over the
  registry, holding no database handle, no credentials and no product logic. It
  imports only `@grndctrl/core/handshake`, and a test scans every import
  specifier to keep `better-sqlite3` out of a process delivered by npx.

Missing and expected: **T163** (prebuilds workflow), **T167/T168** (npx verified
on macOS and Linux), **T172** (quickstart on three platforms), and **T038–T040**,
the recorded provider fixtures, which were ticked without being done. The Phase 7
audits are done and have been run — see above. T037 is done —
the recorder, the scrubber and the replayer, with the alias table that keeps a
ticket key the same string across two providers. T056 is done — and it found
three real defects, listed in `CHANGELOG.md`. T074 is done — `runtime/scheduler.ts`, wired in `main/index.ts`
and proved end to end by `test/e2e/polling.spec.ts`, which is the only test that
fails if nobody calls `start()`. T087 is done too — `providers:probe` is what
proved both Phase 0 unknowns against live credentials.

## Locked decisions

From the brief plus this session; not relitigated. Electron desktop app with a
**React** renderer; `npx grndctrl` delivery via npm, Electron runtime fetched
from GitHub releases at first run; TypeScript on Node 22+; core service layer
with the HTTP API and MCP server as thin adapters; **SQLite** via
`better-sqlite3`, mirrored cache and authored state as separate stores; Jira
Cloud (REST v3 + JQL) and GitHub (**GraphQL**, not REST); PAT/API-token auth in
the OS keychain behind a provider seam; polling only, no webhooks; multi-account
above multi-project; light/dark with system default and explicit override; MIT.

**A project** = one Jira project + one git repo + an optional Confluence URL
(a stored link only — no auth, no API, no polling). Tickets, branches, PRs, and
CI follow from those bindings; the Jira-key pattern defaults to the bound
project's key. **One page**: project selection is a filter, and when it narrows
to a single project a header renders the Jira link, repo, and Confluence link.

**Agent sessions ship in v1** (overriding the brief's deferral), ingested via
**`grndctrl-mcp` session tools plus a heartbeat** — start, heartbeat, status,
end. Sessions are local authored data, not provider writes, so constitution XVI
is untouched. "Silent" derives from a missed heartbeat; "Needs you" from a
`question-for-human` note attached to the session.

**MCP is bidirectional.** Inbound, agents report sessions. Outbound, a durable
**action outbox** in the service layer is the source of truth: agents claim work
via MCP tools (get-pending / claim / complete), so an action raised while no
agent is running is still picked up later. Connected agents are additionally
notified so they act without waiting for a poll — push is an accelerator, never
the contract, since MCP transport is client-initiated and can only reach an
agent with an open session.

**Everything is a launcher.** Every row opens its provider in the default
browser — ticket, PR, repo, CI run, Confluence link, and **branches to the
GitHub branch view**. An unpushed local branch has no such URL, so it falls
back to the repo. Worktrees stay modeled (a workspace is repo + worktree +
branch) even though they are not the click target — the primary user does not
use them, peers do. Agent sessions have no web URL and open in their own
client.

**The board holds only the operator's own assigned work** (2026-08-15). The
ticket query carries `assignee = currentUser()`, so unassigned tickets never
reach the mirror. Scoped at the fetch rather than as a display filter: a filter
can be toggled off and a fallback can resurrect what it hid, and both happened —
`mineOnly` in the renderer tests `ballInCourt !== 'you'`, and the ball-in-court
fallback awards an unassigned ticket to the operator because nobody else holds
it, so the filter passed exactly the rows it should have removed. Measured
against real projects, the unfiltered query returned several hundred tickets of
which two thirds were backlog nobody had touched. Recently-closed tickets stay
**inside** the assignee filter,
because drift rules D1 and D4 compare a terminal status against an open or
merged PR. Note this is narrower than FR-032 implies and than the original
implementation: the spec lists four routes to "the operator" and does not
authorise the unassigned fallback, which is now unreachable rather than removed.

**The renderer imports domain types, never values** (2026-08-15). It previously
restated every shape by hand because the ESLint rule banned `@grndctrl/core`
outright; the copies drifted and the board read four fields that had never been
sent. Types are now derived with `Pick` from the domain types — keeping the
original intent that only rendered fields get a name — and a value import still
fails lint, which is what the rule was actually protecting.

## Open decisions blocking the spec

Asked one at a time as selectable options, per constitution Principle X.

1. ~~**Constitution collision**~~ — ✅ merged into one file, two parts.
2. ~~**What defines a "project"**~~ — ✅ see Locked decisions.
3. ~~**Project page vs Command**~~ — ✅ one page, project is a filter.
4. ~~**Confluence depth**~~ — ✅ stored URL only.
5. ~~**Agents in v1**~~ — ✅ in scope, via MCP session tools + heartbeat.
6. ~~**Drift actions are writes**~~ — ✅ **Resolved:** the drift button
   **dispatches to an agent** via the action outbox. Constitution XVI amended
   to 4.0.0 to permit it explicitly: Ground Control's own credentials stay
   read-only and the service layer may never call a provider write API, but it
   may dispatch an individually-confirmed action for an agent to execute with
   its own credentials. Known weakness: it only works when an agent is running
   *and* has provider write access, so the spec must define what the button
   does when neither holds.
7. ~~**Where notes surface**~~ — ✅ **Resolved: both surfaces.** A note count
   sits on the row (ticket, PR, branch), and `question-for-human` notes also
   appear as `nudges` in Attention, driving the Command badge and a session's
   "Needs you" state. Clicking a note opens a **modal** to read and edit it.
   Notes are readable and writable by **both the user and agents** (via MCP).
   Two consequences for the spec: the design system has no dialog primitive
   (buildable from `--raised`, but new), and the 34px row's fixed-width slots
   are fully allocated, so the count badge displaces something.
7a. **Concurrent note edits** — an agent may write a note while the user has it
   open in the modal. Last-write-wins would silently destroy authored data,
   which XIII forbids. *Assumption:* notes carry a revision; a stale write is
   rejected and the modal surfaces the conflict rather than overwriting.
   ← **flagged, not blocking**
### Decided in the spec, not escalated

These are engineering calls rather than product ones. Recorded as assumptions;
correct any of them and the spec changes.

8. **Project chip overflow** — beyond the six defined colors, fall back to a
   neutral chip carrying only the 3–4 character code. Identity degrades to the
   label, which the design system already requires to work alone at 16px.
9. **Severity derivation** — `sev` is correlation output, not styling. Derived
   per lane from drift presence, CI state, review state, and age against that
   lane's threshold. The spec defines the rule table.
10. **Identity across accounts** — "mine" resolves per-account (Jira
    `currentUser()`, GitHub `viewer`). No cross-account human identity in v1.
11. **Fan-out in the join** — a ticket with three PRs is **one** work item.
    All relations many-to-many, keyed on the ticket where one exists, else on
    the workspace. A key matching no known ticket is a drift finding, not a
    work item.
12. **Note durability key** — notes attach to a stable natural key
    (`jira:SITE/PROJ-123`, `repo:<canonical-remote>#<branch>`), never a
    mirrored row id, and re-attach if that key reappears. Required by XIII.
13. **Service placement and MCP transport** — core service in the Electron
    main process, importable without Electron; `grndctrl-mcp` reaches it over
    a tokenized loopback API. Moving the service to `utilityProcess.fork` is a
    plan-time call and the code must not preclude it.
14. **Freshness thresholds** — tracked per connection per resource kind, with
    "stale" and "failed to refresh" distinct (XIV). Poll 60s GitHub / 5min
    Jira; lane thresholds from the design (tickets 3d, PRs 24h).
16. **Credential storage** — `@napi-rs/keyring` (true OS keychain, maintained,
    prebuilt binaries). `keytar` is archived; Electron `safeStorage` stores
    ciphertext you must place somewhere, which sits awkwardly against XI.

15. ~~**Local git fetch**~~ — ✅ **Resolved: never fetch.** Ahead/behind is
    derived from **GitHub**, which Ground Control already polls, so the number
    is as fresh as the last poll with no local mutation whatsoever. Local git
    supplies only what it alone knows — uncommitted changes, unpushed commits,
    worktree list. A never-pushed branch falls back to local-only facts, which
    is correct: GitHub has never seen those commits. Costs one comparison call
    per tracked branch against the rate limit.

    Note: this is *stricter* than XVI requires — the principle permits an
    opt-in fetch, and the product declines to use it. The constitution was
    deliberately **not** amended to match; a principle is a ceiling, and
    rewriting it every time a product decision lands below it turns a
    non-negotiable into a changelog.

### Still yours to decide

17. ~~**v1 sequencing**~~ — ✅ **Resolved: headless first**, in four milestones.
    M1 skeleton (two databases, migrations, registry, keychain) · M2 the engine
    (providers, correlation, drift — proven with Electron uninstalled) · M3 the
    agent surface (notes, sessions, outbox, MCP — with no UI in existence) ·
    M4 the shell (Electron, React, packaging). A dev-only text board lands in M2
    so the engine is demonstrable before there is anything to look at.

18. **Which row element the note count displaces** — the 34px row's fixed slots
    are fully allocated. Deferred to M4, against the real component.
19. **Whether core moves to `utilityProcess.fork`** — v1 runs it in the main
    process, written so the move is cheap. Trigger is a *measured* frame drop,
    not a suspicion.

## Branching note

Governance and setup commit to `main` directly — they define the process rather
than implement a feature. Constitution Principle IX takes effect for feature
work: `speckit-specify` creates the feature branch at Phase 4.

## Next action

**Six decisions closed on 2026-08-15 (late).** They are recorded here because
each one changes what remains, and several override what this file said earlier:

1. **Recorded provider fixtures stay local.** `fixtures/{jira,github,git}` are
   gitignored. Real payloads never enter the tree, so the largest exposure is
   closed by construction rather than by scrubbing. The cost, stated: CI keeps
   running against hand-written inline payloads, so the protection does not
   survive the machine.
2. **The machine-blocked tasks close in CI.** T167/T168 asked for a clean
   machine with an empty runtime cache, and a GitHub Actions runner is exactly
   that. T163's workflow and a cross-platform npx verification replace "borrow a
   Mac". Named weakness: CI proves the runtime downloads, verifies, unpacks,
   passes the ABI check and starts — **it does not prove a human sees a correct
   window**, and that stays unverified off Windows.
3. **v1 publishes** — public repository, four packages on npm. Gated on the
   client-reference audit being green, which it now is on `clean-main`.
4. **T170 gets both captures.** A 30+ minute idle capture with the scheduler
   live, which is the only thing that catches something firing on a timer, plus
   a driven pass over every path that can egress. Neither substitutes for the
   other. The ticked result currently rests on a few minutes.
5. **Archivo gets bundled**, subset and Open-Font-Licensed, so `--f-brand` stops
   naming a font nobody ships.
6. **The public repository is Ground Control only.** The `ai-tools` toolkit is a
   separate thing that is meant to travel into other codebases, and it cannot do
   that from inside a product repository.

**Done since:** the old repository is private and renamed `grndctrl-archive`;
`jonupchurch/grndctrl` is a new **private** repository holding one clean history,
verified by cloning it fresh and auditing the clone (634 sources, tree and
history, zero hits). CI is green on all five jobs; packaging is green on all
three platforms.

**What is left, as of 2026-08-16.** T038–T040, Archivo and T170 are done; the
list below is what actually remains.

1. **Publish** — merge PR #1 (the toolkit is now out of the tree), configure npm
   **trusted publishing** on npmjs.com (`release.yml` uses
   `id-token: write`, so there is no long-lived token in repository secrets),
   tag `v0.1.0`, flip the repository public. `grndctrl`, `@grndctrl/core` and
   `@grndctrl/desktop` are all free on npm.
2. **T172** — **deferred by the operator, 2026-08-16.** CI proves the process
   boots and `npx` works from a packed tarball on all three platforms; what is
   still unverified is a person opening the board on a Mac or a Linux desktop
   and recognising it. That is a real gap, not a closed one, and it is recorded
   as deferred rather than met.

**The repository is public as of 2026-08-16.** PR #1 was merged (rebased, so its
six commits survive as individual records), the `ai-tools` toolkit was removed,
and the release workflow was run as a **dry run on the merged tree** first: the
client audit over tree and full history, the dependency audit, `npm run verify`,
the Electron-ABI native fetch, the build, and all four tarballs packed. Then the
repository was flipped, and the public result was re-audited **from a fresh
clone** — 665 sources, tree and every ref, zero hits.

`grndctrl-archive` is confirmed **still private**, which matters more now than
it did yesterday: it holds the pre-scrub history.

**Published, 2026-08-16.** All four packages are on npm and `latest` is **0.1.1**
everywhere: `grndctrl`, `@grndctrl/core`, `@grndctrl/desktop`, `grndctrl-mcp`.
`npx grndctrl` works on Windows, macOS and Linux.

**0.1.0 is on the registry and is broken on Windows and macOS.** It shipped a
Linux-only native module to every platform; see the Fixed entry in
`CHANGELOG.md`. It cannot be replaced — npm never permits re-publishing a
version — and it is **not** unpublished, because unpublishing every version of a
package blocks republishing that name for 24 hours and would have held the fix.
It should be deprecated instead.

Three things that cost time and are worth not rediscovering:

- **A scoped package on a brand-new organisation takes minutes to become
  readable.** Both unscoped packages appeared instantly and both `@grndctrl/*`
  answered 404 for several minutes — with every publish having returned
  `PUT 200` and `exit 0`. It looked exactly like two of four having failed.
- **`npm publish dist-tarballs/x.tgz` is not a path.** npm reads `a/b` with no
  `./` as a GitHub `owner/repo` shorthand and goes looking over SSH. The leading
  `./` is required.
- **Publishing needs an authenticator code**, so it cannot be done from a
  non-interactive session at all. The operator runs it; chain the four with `&&`
  so a failure cannot leave a dependent published without its dependency.

**Still to do on npmjs.com:** configure trusted publishing on each of the four
packages. Until then `release.yml`'s `id-token: write` path has nothing to
authenticate against. And **do not tag `v0.1.0` or `v0.1.1`** — both versions are
already on the registry, so the tag-triggered workflow would fail at its publish
step. The first tag-driven release is `v0.1.2`.

**T038–T040 are done, and the GitHub recording earned its keep immediately.**
The Jira and git fixtures come from the operator's own machine. The GitHub one
was re-recorded 2026-08-16 from an **active public repository**, using a
fine-grained token scoped to public repositories read-only and stored under its
own connection id (`github-fixtures`) so the operator's working credential was
never overwritten — the recorder reads the keychain by connection and never
touches the connections table for GitHub, which is what makes that possible.

It failed on its first run, against an assertion that had passed for a week
without ever executing. See the Fixed entry in `CHANGELOG.md`. The remaining
uncovered value is `CHANGES_REQUESTED`, which no pull request in the recording
carried; it is still hand-written.

T153 and T155 were pulled forward and are complete, on the evidence that
2026-08-15 produced eight real bugs in code that was marked done and had passing
tests without one of 533 tests failing. That evidence still governs what gets
built next: prefer the test that drives the whole path over the one that checks
a unit in isolation, and run the application and look at it.

**Added to the backlog, 2026-08-15: T176, an always-on-top toggle** in the
titlebar. An operator request, not in the spec — a command station is something
you glance at while working in another window, and one that sinks behind the
editor stops being glanced at. It is window state, so it belongs with T154's
persistence rather than on its own, and it needs `setAlwaysOnTop` in main since
the renderer cannot reach the window.

Then back to plan order for the rest of M4: the modal primitive — which the
design system does not have, so it is new — the notes modal with conflict
surfacing on a stale revision, the note count badge and deferred decision 18,
the drift confirmation flow, the outbox state display, and window-geometry
persistence (T148–T152, T154).

Then the rest of the end-to-end suite (T155, T157–T159) and packaging
(T160–T168).

**Two decisions made under assumption during M4**, either of which can still be
changed cheaply:

- **esbuild for the renderer, and no dev server.** The plan never chose a build
  tool. A dev server would make the CSP and the request blocking different in
  development from production, so the security posture that ships would be the
  one nobody had been running all day. The cost is losing hot module
  replacement.
- **Main is bundled to CommonJS.** Electron 33 will load an ESM main until it
  imports `better-sqlite3`, at which point Node's CJS preparse throws from
  inside its own internals with nothing of this project in the stack.

**Credentials.** Jira expected 2026-08-15. GitHub needs re-issuing — the
original leaked into a session transcript when the IDE sent the changed
`.env.local` into context, and was revoked. Prefer
`$env:GRNDCTRL_GITHUB_TOKEN = '...'; npm run credential:import`: a real
environment variable wins over the file and nothing touches disk. What they
unlock: the one Phase 0 finding that could not be verified (whether Jira's
enhanced search endpoint honours `expand=changelog`), and the golden path in
`quickstart.md` against real data rather than a seeded scenario.

**~~Known gap:~~ closed.** Archivo is bundled — a 7.9 KB printable-ASCII subset
at weight 600, OFL 1.1, licence shipped beside it. Emitted by esbuild as a
*file* rather than a data URL specifically so `font-src 'self'` stays as it is,
since inlining would have meant widening the CSP for every font-shaped thing on
the page in order to serve one.

Verified in the running application by `test/e2e/brand-font.spec.ts`, and the
first version of that test was wrong in the way this project keeps finding:
**`document.fonts.check()` returns `true` when no matching face exists at all.**
It reports that nothing is unloaded, not that the font is present, so deleting
the entire `@font-face` rule left all three assertions passing. It now reads
`document.fonts` for a face in `loaded` state and measures advance widths
against a deliberately absent family — with the rule removed, three of four
tests fail.

One thing that probe taught, worth keeping: a *missing font file* is an esbuild
build error, not a silent fallback, so the first attempt at the probe never ran
— the build failed and Playwright tested the previous `dist/`. That is the
"build failed, this is not the gate firing" trap, hit for a third time.
