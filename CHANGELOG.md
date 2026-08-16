# Changelog

All notable changes to Ground Control (`grndctrl`) are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been released yet — v1 is still in specification. Until the first
release, everything lands under **[Unreleased]**.

## [0.1.1] — 2026-08-16

First working release. `npx grndctrl` runs on Windows, macOS and Linux.

`0.1.0` was published the same day and is broken on Windows and macOS; it is
superseded and should be treated as withdrawn. See below for what it was.

## [Unreleased]

### Fixed

- **`npx grndctrl` was broken on Windows and macOS in 0.1.0.** `@grndctrl/desktop`
  shipped `native/better_sqlite3.node` inside the tarball. One tarball goes to
  every platform, `release.yml` runs on `ubuntu-latest`, so **every user on every
  operating system received a Linux x86-64 binary**. Windows answered
  `ERR_DLOPEN_FAILED: … is not a valid Win32 application`.

  The package's own `native/manifest.json` recorded `"platform": "linux"` the
  whole time. Nothing read that field — the same shape as almost every defect
  this project has found: written by one side, read by nobody.

  **Why three green packaging jobs missed it.** The matrix built a tarball *on*
  each platform and tested it *on that same platform*, so every job's binary
  matched its machine by construction. The arrangement that actually ships — one
  Linux-built tarball installed on Windows — was the single combination never
  tried. The workflow now packs **once**, on Linux, and the matrix installs *that
  artifact* everywhere.

  **The fix.** A native addon is specific to (ABI, platform, arch); an npm
  tarball is specific to none of them, so the binary stops travelling in the
  package. `@grndctrl/desktop` now ships only `native/requirements.json` — the
  Electron version, the ABI, and the `better-sqlite3` version, three facts true
  on every machine — and the launcher fetches the matching prebuild for the
  machine it is on, beside the Electron runtime it already downloads. The digest
  of what it extracted is recorded and re-checked on every later launch; that
  catches a truncated cache entry and, stated plainly because the distinction
  matters, does not authenticate a first download — better-sqlite3 publishes no
  checksum file to verify against.

  Two guards added, both probed. `nativePlatformMismatch` reads the platform and
  arch that were previously written and ignored, so a checkout whose binding was
  built under WSL and launched from Windows gets a sentence instead of a dlopen
  crash. And the packaging job fails if any `.node`, `.dll`, `.dylib` or `.so`
  appears in the universal tarball — run against the shipped 0.1.0 artifact it
  fires and names the file; against 0.1.1 it stays quiet over a listing verified
  non-empty first, because a guard that "passes" on an unread archive is the
  empty-versus-could-not-look trap wearing a different hat.

  Verified end to end on Windows against a tarball containing no binary at all:
  the binding downloaded for `win32-x64`, SQLite loaded, both databases
  migrated, the renderer painted, and a second run downloaded nothing.

  0.1.0 is deprecated on npm rather than unpublished — unpublishing every version
  of a package blocks republishing that name for 24 hours, which would have held
  the fix hostage.

### Security

- **SC-010 re-verified properly** (T170). The claim previously rested on a
  capture of a few minutes against a spec that asks for thirty. It now rests on
  two: a **35-minute idle run** with the poll scheduler live on real
  credentials, and a **driven pass** over every path that can egress — Jira
  auth, search, bulk changelog; GitHub auth, repository read, branch
  comparison. The duration catches anything on a timer; the driven pass catches
  what an idle window never touches. Neither substitutes for the other. Both
  reached `api.github.com` and the configured Jira site and nothing else, across
  five recorder-loaded processes.

  Probed by stripping the loader marker from a capture: it fails, because
  "nothing was contacted" and "nothing was watching" are the same empty list and
  opposite facts.

- **The repository was public for a day with the employer named in it.**
  Discovered by running `gh repo view` instead of assuming — it reported
  `PUBLIC`, created 2026-08-14. Exposed: the employer's name and Jira site in
  `STATUS.md`, and statistics derived from a real client's backlog in
  `STATUS.md`, `CHANGELOG.md`, `sync.ts` and one test. Not exposed: any
  credential. `.env.local` was never committed and every token-shaped string in
  history is a test placeholder. Zero forks, zero stars, zero watchers.
  The repository is now private, which with no forks ends public access to every
  object rather than hiding the current tip.

### Added

- **The client-reference audit** (`scripts/audit-client-refs.ts`). Zero hits is
  the only pass, with no allow-list of expected occurrences — the same terms as
  the secret audit, for the same reason. Two properties carry the design. **The
  denylist is not in the repository**, because writing the terms into a constant
  publishes on every clone the strings the gate exists to suppress;
  `.client-denylist` is gitignored and reaches CI as a secret. **A missing or
  empty denylist fails**, because "nothing was found" and "nothing was looked
  for" are the same empty list and opposite facts.

  A second arm catches any `*.atlassian.net` host outside the invented
  placeholder set — a denylist only finds what someone thought to list, and on
  the first run this arm identified the real site on two lines without being
  told the name. The report prints file and line and never the matched value,
  because Actions logs are public on a public repository and a report that names
  what it found would republish it on every failing run.

  Probed four ways: 13 hits across the tree, 97 across 558 history blobs, a hard
  fail with the denylist removed, and a planted term caught and then cleared.
  Two of its catches were the author's own: the test file, which plants matching
  strings to prove the matcher works and so failed on its own source, and the
  audit's docblock, which quoted the real figures as an illustration.

### Changed

- **History rebuilt rather than rewritten.** 97 occurrences across the old
  history meant scrubbing the files and committing the fix would leave every
  earlier version reachable by SHA. `clean-main` is a single squashed commit
  whose history has never held a client string — 315 blobs, zero hits — with the
  full development history retained privately. File inventories match at 316
  both sides.
- **Client-derived specifics generalized** in `STATUS.md`, `CHANGELOG.md`,
  `packages/core/src/services/sync.ts` and `multi-project-sync.test.ts`. The
  numbers are generalized rather than deleted: they were the evidence for the
  assignee filter and for the pagination bug, and deleting them would have cost
  the reasoning to save the digits.
- **`fixtures/{jira,github,git}` gitignored** ahead of T038–T040, so recorded
  provider payloads stay on the machine that recorded them.

### Changed

- **The repository is public** (2026-08-16). Sequence, in this order and not
  another: merge, then the full release workflow as a **dry run on the merged
  tree** — client audit over tree and complete history, dependency audit,
  verify, native module, build, four tarballs packed — then flip, then re-audit
  the public result **from a fresh clone**: 665 sources, every ref, zero hits.

  That last check nearly went wrong in an instructive way. Run from inside the
  clone but pointed at the *original* script, it reported **98 occurrences** and
  looked like a live leak. `run-audits.ts` sets `cwd: ROOT` from its own
  location, so it had audited the local repository — which deliberately holds
  the archive refs — and not the clone at all. Byte-identical output to an
  earlier local run is what gave it away. **A tool that hardcodes its own repo
  root cannot audit a different checkout**, and an alarming result deserves the
  same scepticism as a reassuring one.

  `grndctrl-archive` confirmed still private in the same pass.

### Removed

- **The `ai-tools` agent toolkit** — `.claude/`, `.specify/`, `stacks/`,
  `MANIFEST.md`, `AGENTS.md`, `CLAUDE.md`. 41 files. A toolkit whose purpose is
  to travel into other codebases cannot do that from inside a product
  repository, so it now lives only at `github.com/jonupchurch/ai-tools`.

  **Backported before removing, not after.** That copy was a month stale — nine
  rules where this one had ten, and no `stacks/electron.md` at all. Only five
  files genuinely differed; the other 36 were identical once line endings were
  ignored, so they were left alone rather than rewritten wholesale. Principle X
  went back into the reference constitution as 2.1.0, generalised on the way:
  the Electron pack no longer names this product, and its Part II citations now
  state the rule they cite, so a project without a Part II can still read them.

  Nothing is lost either way — every file remains in this repository's history
  and in `grndctrl-archive`.

- **`.specify/memory/constitution.md` moved to `docs/constitution.md`** rather
  than leaving with the toolkit. Part II is Ground Control's own design gates,
  cited in 47 files including `packages/cli/src/index.ts`, the conformance
  tests and the specs — deleting it would have removed the definition of gates
  the code enforces. Exactly one reference named it by path, in `README.md`.
  It was a product document that happened to live in a toolkit directory.

### Fixed

- **A replay assertion that was wrong and had never run** (T039). It required
  `reviewDecision` to match kebab-case `review-required` / `changes-requested`.
  Core has always emitted `reviewRequired` / `changesRequested`, and so does
  every consumer — the type, the correlation engine, the renderer. The
  assertion could only ever have passed on `approved`.

  It survived because it was guarded by `if (pull.reviewDecision !== null)` and
  the recording it ran against came from a repository with no reviewed pull
  requests. Fifty iterations, zero executions of the assertion, a green test.
  Re-recording against an active public repository made it fail on the first
  run — which is the entire argument for recording fixtures from the wire
  rather than writing them from belief.

  The fix is not just the pattern. The test now counts how many pull requests
  actually carried a decision and **fails if that count is zero**, so a future
  recording cannot quietly return it to a test that cannot fail; and a second
  test requires more than one distinct decision, since one value would satisfy
  the count while proving a single branch of the normaliser. Probed by putting
  the kebab-case spelling back (fires), making the loop body unreachable as the
  old fixture did (fires), narrowing the set to a single decision (fires), and
  a control edit that changes nothing (still passes).

- **T166 ticked.** `npx` from a packed tarball on Windows was verified last
  session; the checkbox was missed. The task count in `STATUS.md` is corrected
  from a hand-tallied 162/175 to a counted 168/176.

### Added

- **A dialog layer** (T148–T152). The design system stops at the board and has
  no overlay in it, so the modal primitive is the one component built rather
  than transcribed — a native `<dialog>`, which supplies the top layer, the
  inert background, focus containment and Esc from the platform instead of from
  five hand-written pieces. Esc closes it; a backdrop click does not, because
  both dialogs hold something the operator typed.
- **Notes on the board** (T149, T150). Read, add, edit, delete and answer, from
  a row badge in the trailing slot — the slot reserved for it since T134, so
  deferred decision 18 displaces nothing. The count is per subject rather than
  the work item's total: on one of three pull request rows the aggregate would
  show 6 and then open showing 1. The badge is drawn at all times and only its
  emphasis changes, because a version that appeared once a note existed made the
  first note on any subject unwritable from the board.
- **The drift confirmation flow** (T151, XVI). Minting the token and enqueueing
  happen back to back with nothing in between that could decide differently, and
  the dialog says plainly that Ground Control holds read-only credentials and
  will not perform the action itself.
- **Outbox state, including who is listening** (T152, FR-066). Each action shows
  its own state and history; when no agent session is running it says so
  outright rather than letting "queued" read as "sent". Only `running` counts —
  a silent session has missed its heartbeat, and a crashed agent cannot report
  its own crash.
- **The window remembers itself** (T154, FR-082). It reopens where it was left
  — unless that position is on a display that is no longer attached, which is
  refused: restoring those coordinates produces a window that is running,
  focused, receiving keystrokes and invisible, and nothing inside the
  application can recover it. A maximised, minimised or full-screen window is
  not saved either, because its bounds are the screen and restoring them
  overwrites the restore size with the screen size. The active project filter
  and the court filter persist alongside it.
- **An always-on-top toggle** in the titlebar (T176, operator request). It takes
  no new channel: the renderer writes a setting and main applies it to the
  window by watching `settings.update` go past. `setAlwaysOnTop` is a
  `BrowserWindow` method and the bridge exposes no window handle, which is the
  point of the bridge — and a second channel would be a second way to change one
  fact.
- **The filter-performance test** (T159, SC-013): 200 work items across six
  projects, filtered in 16ms against a 100ms budget. Timed inside the page from
  the click to two animation frames later — the first moment the result could be
  seen — rather than from the test process, which would fold in Playwright's own
  round trip and measure the harness. It is also what pins the decision to
  filter in the renderer over data already fetched rather than server-side.
- **The greyscale legibility check** (T158, SC-015). Colour is removed
  outright rather than desaturated — four hues desaturate to four *different*
  greys, and a test that passed on those would be asserting the luminance
  distinction the shapes exist to replace. The marks are then compared as
  images, every pair, so a shape changed to match another or a dropped
  `clip-path` fails rather than merely looking similar. Comes with
  `fixtures/scenarios/every-severity.json`, which produces one work item at
  each severity from facts rather than by declaring them.
- **The degradation end-to-end test** (T157, US6). Not "does it show an error"
  but "is it still usable": with all three providers unusable, every lane keeps
  its rows, the filters work, drift still reasons over the cached records, and
  notes — which are authored data and have nothing to do with a provider — can
  still be written. That last one is the case where an operator most wants to
  write down what they just found out.
- **A notice when the board cannot refresh itself** (FR-006), naming which
  connections and saying that pressing Refresh cannot help. Worded differently
  for a missing credential and an unreachable keychain, because signing in again
  is the answer to one and cannot possibly help with the other.
- **The golden-path end-to-end test** (T155): configure, render, open each of
  the three row types, write a note and watch the badge follow it, lose a
  revision race on purpose and see what it lost to, confirm a dispatch, and find
  the action still pending after a restart.
- **The board refreshes itself** (T074, FR-013). A poll scheduler in
  `packages/core/src/runtime/scheduler.ts`: 60 seconds for GitHub, five minutes
  for Jira, both configurable, with per-connection exponential backoff capped at
  half an hour so a revoked token is not retried sixty times an hour and a fixed
  one recovers without a restart. Local git is scheduled like a connection under
  its own reserved id, since the branches lane had nothing else to refresh it.
  Timers and the clock are injected, so the cadence and the backoff are unit
  tests that run in milliseconds rather than a stopwatch.

  Its polls travel through the same observed dispatch the window uses, which is
  the part worth stating: a background sync that skipped it would refresh the
  mirror and leave the window showing the previous board — with the freshness
  reading underneath saying the data was current.


- **The privacy audits** (T169–T171), and the results of running them. These are
  the promises that cost the most to break, so each is a script that checks
  rather than a sentence that asserts — and each was made to fail before it was
  believed.

  **Secrets** (SC-011) scans the whole data directory, including everything
  Chromium writes there, in several encodings. The one that matters is
  `base64(identity:secret)`: Jira authenticates with `Authorization: Basic
  base64(email:token)`, so a cached header holds the credential in a form a
  search for the token itself comes back clean on. The identity is read from the
  connection rather than typed, because an address one character off makes that
  arm run, find nothing, and prove nothing while the report still says PASS.
  Nothing is ever printed. Files that could not be read are named as a gap in
  coverage rather than counted as clean. **Result: 51 files, both live
  credentials, zero hits.**

  **Egress** (SC-010) is two halves that fail differently — every absolute URL
  compiled into the built artifacts, and every host actually contacted during a
  session, recorded by a `--require` hook that sits ahead of `fetch`,
  `https.request` and `http.request`. Neither is sufficient: a static scan
  cannot see a URL assembled at runtime, and a capture of any length cannot see
  a destination that has not fired yet. **Result over a live session: two hosts,
  `api.github.com` and the operator's Jira site. Nothing else.**

  **Dependencies** (XI) walks the *production* tree — what a user installs, not
  what a contributor does — for packages whose job is reporting, and for
  lifecycle scripts, which run arbitrary code on a stranger's machine at `npx`
  time. Matched on exact name and scope rather than substring, so
  `matomo-css-parser` is not a finding and `@sentry/electron` is. **Result: 236
  packages, clean.**

- **A README and `docs/agents.md`** (T173, T174). The agent document is the tool
  list, the two contracts an agent has to honour — heartbeat, and poll the
  outbox at start-up rather than relying on the notification — and the things
  agents structurally cannot do: enqueue their own actions, write to a provider,
  or touch the working tree. Its tool list was checked against the code rather
  than written from memory, which found two tools missing from it.

- **`npx grndctrl`** (T160–T162, T164–T166). The launcher resolves the Electron
  runtime, verifies its checksum against the one published in the same release,
  caches it per machine and per version, checks that its ABI matches the bundled
  native modules, and only then spawns the app. Three ordering rules, each of
  which fails silently if it is lost: nothing is extracted before it verifies,
  nothing is spawned before its ABI is checked, and a download that fails leaves
  no cache entry — the last because unpacking into the final directory means an
  interrupted download is treated as a hit by every launch afterwards.

  The runtime cache is machine-level and deliberately not scoped by
  `GRNDCTRL_DATA_DIR`: the end-to-end suite gives every spec its own data
  directory, and sixty specs would otherwise mean sixty downloads.

  The ABI check asks the runtime what it is — `ELECTRON_RUN_AS_NODE=1 electron
  -p process.versions.modules` — rather than consulting a table of Electron
  majors, which is a copy of somebody else's release schedule and goes stale
  without saying so. When it fires it names both runtimes and both module
  versions, and explicitly does *not* suggest `npm rebuild`: the person reading
  it has no checkout and no toolchain, and Node's own message sends them
  looking for one.

- **The fixture recorder** (T037, research R9). Records a live provider
  response, scrubs it, and replays it. The hard part is not the scrubbing —
  replacing everything with `"x"` would be perfectly safe and perfectly
  useless — but keeping what makes a fixture able to fail: an alias table so
  one ticket key stays the same string across an issue, a branch name, a pull
  request title and a commit message, because noticing they are the same string
  is the correlation engine's entire job. Prose keeps its length, its
  punctuation and the position of its ticket keys, and loses its words. Status
  categories, review decisions, check conclusions, timestamps, counts and
  booleans are left exactly as sent, because they are the fixture. A credential
  surviving the scrub raises rather than being masked.
- **Windows paths, tested end to end** (T056, XVII, FR-087). CRLF, spaces,
  non-ASCII, UNC shares and two checkouts of one repository on two drives —
  four cases that break on this platform and nowhere else, and all four end in
  the same place: a different natural key for the same worktree, which orphans
  every note attached to it. Backslashes in the fixtures are built rather than
  typed, because `'D:\work\repo'` is `D:` + `w` + a carriage return + `epo` and
  looks entirely fine on screen.

### Fixed

- **A Windows drive letter was read as an SSH host.** A remote of
  `D:\mirrors\repo.git` — a clone from a local mirror or a mapped drive —
  matched the scp-style `git@host:path` pattern with `D` as the host, and came
  out as `d/\mirrors\repo`. The forward-slash spelling was already excluded by
  a lookahead; on Windows both are written, and only one was covered.
- **`worktreeId` claimed a stability it does not have.** Its comment said the
  hash meant "a drive-letter change or a moved checkout does not orphan the
  notes attached to it". It does: the id is derived from the path, so a
  secondary worktree that moves gets a new one. That is the right trade — two
  worktrees of one branch are distinguishable only by where they are, and the
  *primary* worktree is exempt — but the comment described the opposite of the
  behaviour, which is worse than no comment.
- **CRLF was stripped twice and provable nowhere.** `normalize` lived in the
  real runner and again in the test double, so deleting it from the runner
  changed no test result: every test went through the other copy. The child
  process is now injectable, so the contract is tested against the real runner,
  and the double normalises *because* the runner does rather than as a
  coincidence. Same shape in `parseStatus`, where a `startsWith('#')` skip and
  an anchored record-type test both rejected header lines — neither could be
  made to fail, so the anchor could have been dropped with the suite still
  green. One guard now, and it is the one with the test.
- **Nothing polled.** `pollIntervalSec` has been in the settings schema since
  M2, and the only thing reading it was the *freshness* calculation: a lane goes
  stale at three times the poll interval. So the board has been saying "this is
  stale because we should have refreshed twice by now" while nothing refreshed
  at all, and the numbers were only ever current because the operator kept
  clicking Refresh. Same shape as most defects here — a field both halves agree
  about that nothing connects.
- **A refresh scoped to one connection re-read every checkout on disk.** Local
  git ignored the `connectionId` the other two providers honoured, so clicking
  Refresh on the tickets lane spawned a git subprocess per checkout and then
  stamped the branches lane as freshly synced — a freshness claim about a
  question the operator had not asked. It also made per-target backoff
  impossible, because every other connection's poll retried a checkout that had
  just failed.

- **A conflict could not show what it conflicted with.** The preload typed its
  error as `{ code, message }` while `details` crossed IPC at runtime
  regardless, so the `current` note core attaches to every rejected revision
  was discarded at the boundary. The preload's own comment said "`conflict`
  opens the note modal's conflict state" — nothing could, because nothing
  downstream could see the payload. Now carried on `BridgeError`, and a lost
  race shows the other version beside the draft it lost to.
- **A refresh that could not happen reported success.** A connection whose
  credential had been revoked was given no provider, and a missing provider was
  indistinguishable from having nothing bound to sync — both produced no
  results at all. So `sync.now` returned `ok: true`, wrote nothing, recorded
  nothing, and left every lane it feeds ageing quietly. It is now a failed
  refresh, against that connection and that resource, through the same freshness
  path every other failure uses.
- **An unreachable checkout was reported as having no branches.**
  `git remote get-url origin` fails for three different reasons and this
  answered all three with an empty list — so a checkout on a drive that was not
  mounted produced "No open branches", stated confidently, with a green
  freshness reading beside it. A real repository with no `origin` still answers
  empty; a path that is gone or is not a repository now fails.
- **A failed local read deleted the branches it could not see.** `syncLocal`
  wrote the partial set even when a path failed, on the argument that an
  unreadable checkout is one that is not on disk — which does not survive an
  external drive or a dropped VPN. It now keeps the cache and reports the
  failure, the same rule the GitHub fetch already followed.
- **The credential gap was computed and never shown.** `sync.status` has
  carried `unavailable` since M2 and no screen ever called it, so FR-006 —
  report clearly that the credential store is unavailable, and do not fall back
  — had nothing rendering it.
- **A lane blamed the token when none was stored.** `auth` covers both a
  rejected credential and an absent one, and the lane said "the credential was
  refused" for both.
- **"1 days ago".**
- **A pressed `.ghost` button looked unpressed.** The rule styling
  `aria-pressed="true"` covered the project chips and the segmented control but
  not `.ghost`, so the titlebar's first pressable ghost button announced its
  state to a screen reader and showed it as a one-character glyph difference at
  11px.
- **`size="wide"` on a dialog did nothing.** It set `max-width`, which lets a
  panel shrink to its content, so the attribute matched its rule and the dialog
  came out the default width anyway.
- **`user-select: text` on a row title stopped working** the moment the row was
  covered by a button to make the whole row one click target. Removed rather
  than left in the file looking like a feature; the title is still selectable in
  the Attention strips and the confirmation dialog.

Eight defects found by running the application against live Jira and GitHub for
the first time. None was caught by the 533 tests that were passing; every one
was in code already marked done. Each fix was probed by reverting it and
confirming only its own assertions fail.

- **A connection serving several projects destroyed data.** Every `replaceX` on
  the mirror deletes by connection id while the sync fetched per project, so the
  second project deleted the first's rows and both were reported `ok: true`.
  Three real projects on one Jira connection kept a third of their tickets. The
  fetch unit now matches the write unit.
- **A partial provider failure deleted good cached rows.** One unreachable
  repository used to write whatever else succeeded, discarding the failed
  repository's cached work while freshness read "fresh". Now nothing is written
  unless every repository answered, and XV reports the connection stale.
- **Ticket search dropped every page after the first.** The provider seam
  returned a `nextPageToken` and offered no parameter to send one back — 100 of
  several hundred, silently, with no total available to notice against.
- **`fetchChangelogs` exceeded the bulk endpoint's ceiling.** It named every
  issue in a single request; the one-page search had been keeping it under the
  limit by accident. Now batched.
- **Nothing ever resolved who the operator is.** `viewerIdentity` was written
  null at import and never revisited, so `operatorAccountIds` was empty and
  every ball-in-court rule that asks "is this mine?" answered no. The board
  filed the operator's own tickets under someone else and claimed the unassigned
  ones instead. Now resolved on every sync, so a token swapped for a different
  account is followed rather than cached.
- **The renderer read four fields that had never been sent.** Its hand-written
  copy of the domain types had drifted: `aheadBy`, `behindBy` and `repoKey` do
  not exist in core; `unpushedCommitCount` was typed non-null when null means
  "no upstream"; `reviewDecision` was compared against GitHub's raw casing when
  the provider normalises it, so **no pull request could ever render "Changes
  requested"**; and Attention nudges filtered on `!n.resolved` when the wire
  carries `resolvedAt`, passing every note.
- **Ahead/behind was fetched, stored, and never read.** `comparisons` was a
  correlation input nothing consulted, so the branches lane printed "in sync"
  for a branch 83 commits behind and for one that had never been pushed —
  the sentence FR-018 exists to forbid.

### Changed

- **The board holds only the operator's own assigned work.** The ticket query
  carries `assignee = currentUser()`; unassigned work never reaches the mirror.
  Scoped at the fetch rather than as a display filter, because a filter can be
  toggled and a fallback can resurrect what it hid. Narrower than FR-032
  implies — the unassigned fallback is now unreachable rather than removed.
- **The renderer imports domain types rather than restating them.** The ESLint
  boundary allows `import type` from `@grndctrl/core` and still rejects value
  imports; types are derived with `Pick`, so a field core does not have is a
  compile error. The first typecheck after the change found two further drifts
  on its own.
- **Ahead/behind is carried on the `WorkItem`**, not folded into
  `LocalWorkspace` — which is documented as what local git alone knows and
  cannot produce a comparison without the network read FR-017 forbids.

### Added

- **Live provider connections.** Jira and GitHub are configured and both Phase 0
  unknowns are settled against real credentials rather than documentation: a
  read-only fine-grained token can run `Ref.compare` (R3), and the bulk
  changelog returns history, so ticket staleness is genuine "last real activity"
  rather than the `updated` fallback FR-027 exists to distrust.
- **A project binding script** (`packages/desktop/scripts/bind-project.mjs`) —
  a stopgap until T153's settings screens exist, binding a Jira project, a
  repository, or either alone.

- **M4 — The shell, in progress.** The application launches and the board is on
  screen. The Electron main process, the IPC adapter — the third surface the
  constitution XII conformance gate now covers — a hand-enumerated preload
  bridge with no generic `invoke`, `shell.openExternal` gated on
  `links.resolve`, a CSP with no network reachable from the page, the design
  system's tokens ported verbatim, and the one-page board: four tiles, Attention
  carrying both sides of each drift finding, three lanes with independent error
  boundaries, agent sessions, and ball in court. 518 unit tests, 23 end-to-end.
- **A dev seed** (`packages/desktop/scripts/seed.mjs`) loading the checked-in
  scenarios into a real pair of databases, so the interface is developable and
  testable before any credential exists. It refuses to write to the default data
  directory.
- **T163 pulled forward from packaging.** `better-sqlite3` is compiled against
  one ABI and this repository needs two — Node for the suite, Electron for the
  app. `node_modules` stays as npm built it and a second copy lives beside the
  desktop package, selected by `process.versions.electron`.
- **`project:<id>` as a subject key**, so the header's Jira, repository and
  documentation links resolve through `links.resolve` like every other URL.
- **`GRNDCTRL_DATA_DIR`**, so the end-to-end suite never opens the operator's
  real databases.

### Fixed

- **The app intermittently refused its own renderer's first call.** The IPC
  sender check compared `senderFrame.url` against the renderer entry point, and
  that URL is not reliably settled when the first message arrives. Frame
  identity replaces it.
- **A stale handshake survived a force kill**, leaving a file naming a port
  another process may own. `readHandshake` now checks the process is alive.
- **Every lane announced "never synced" on a healthy board**, because they
  shared one board-wide worst-case freshness reading. Each lane reports its own
  resource (XV).
- **Documentation links resolved to the wrong project** when more than one was
  configured.
- **Rows announced a raw ISO timestamp** to assistive technology, and the board
  had no `h1`.

- **M3 — The agent surface.** Notes, agent sessions, the durable action outbox,
  the loopback HTTP adapter, the handshake file, and `grndctrl-mcp`. 423 tests.
  The milestone's exit criterion is itself a test: a real MCP client starts a
  session, heartbeats, reports activity, ends it, writes a question note and
  loses a revision race — through the whole path, client → protocol → tool →
  loopback HTTP → registry → service → SQLite and back, with no UI in existence.
- **A confirmation that cannot be forged.** An action reaches the outbox only
  with a single-use token bound to a hash of subject, kind and canonicalised
  payload, expiring in two minutes and held only in memory. Sync, correlation
  and drift cannot mint one — not by policy, but because a test walks the import
  graph and asserts the minter is *unreachable* from all three.
- **Three rules that each protect authored data from a plausible-looking bug.**
  A stale note revision is rejected with the current row attached, never merged.
  A heartbeat never advances the activity clock, so a wedged agent reads as idle
  rather than busy. A claim is a conditional update, so two agents polling one
  queue cannot both believe they hold the same action.
- **Orphan status is three-valued.** A boolean would report every note in the
  product as orphaned on first launch, before the mirror has synced anything —
  the same discipline as freshness, where `never` is not `stale`.
- **The registry has operations in it.** 34 of them, ten `ui-only`. The
  conformance gate now compares a *running* adapter against the registry rather
  than a hand-maintained list; the previous version passed vacuously with both
  sides empty. `ALL_ADAPTERS` was removed for that reason.
- **A narrower agent surface than planned.** Dismissing drift became `ui-only` —
  an agent that can hide a finding can suppress the evidence of its own mistake
  — and so did every configuration operation. Neither is a provider write, so
  constitution XVI covers neither; the exposure field is what stops them.
- **The loopback API refuses more than it accepts.** Bound to `127.0.0.1`
  explicitly, ephemeral port, bearer token compared in constant time with the
  length checked first, no CORS headers anywhere, and a refusal for any request
  carrying `Origin` or a non-loopback `Host`.
- **M2 — The engine.** The correlation join, the nine drift rules, severity and
  ball-in-court, all three providers (Jira, GitHub, local git), sync with
  per-provider degradation, and a text board. 299 tests, and the whole suite
  passes with Electron physically removed from `node_modules` — verified by
  moving it aside, not assumed (XVIII).
- **Three rules tightened past the literal spec**, each because the literal
  reading is wrong on a real situation: D1 fires only when *every* PR merged;
  D3 declines when history is unknown rather than flagging every ticket whose
  changelog failed; D9 declines for an unpushed scratch branch rather than
  flagging every experiment.
- **A dev-only CLI** (`grndctrl-cli board --fixtures …`) that renders the
  correlated board as text, so the engine is demonstrable before any UI exists.
  A test pins the expectation `quickstart.md` states by hand, so the documented
  demo cannot rot silently.
- **M1 — Skeleton.** The monorepo (npm workspaces across `core`, `desktop`,
  `mcp`, `launcher`, `cli`), the two SQLite stores with independent migration
  chains, the operation registry, natural keys, the keychain seam, and settings.
  78 tests green; nothing to look at yet, which is the headless-first sequence
  working rather than a gap.
- **Boundary rules that fire rather than document.** ESLint stops `core` from
  importing Electron or a UI framework (XVIII) and stops adapters from reaching
  past the registry (XII); core's tsconfig omits the DOM lib so a stray `window`
  is a compile error. Both rules were probed with deliberate violations to
  confirm they actually reject.
- **Two gates made structural.** An operation marked `providerDerived` cannot be
  registered unless its output is an envelope, so returning provider data
  without its age is a startup failure rather than a review finding (XIV). And
  `checkConformance` compares each adapter's real exposed surface against the
  registry, green today with both empty and failing the moment they diverge (XII).
- **The XIII and XI proofs.** Deleting `mirror.db` preserves every authored row
  byte-identical, and notes re-attach on resync with no repair step (SC-007).
  No credential reaches disk — not in any column, and not in any *byte* of any
  file in the data directory, since a column scan misses a page SQLite has not
  yet reused (SC-011). Both checks are proven to detect the thing they look for.
- **Real-hardware verification, not just doubles.** The keychain round-trip runs
  against the actual Windows Credential Manager.

- **v1 specification** (`specs/001-ground-control-v1/spec.md`) — six prioritized
  user stories from the correlated board through drift detection, agent
  sessions, notes, dispatch, and per-provider degradation; 87 functional
  requirements; 15 measurable success criteria; 14 key entities. Two things the
  spec pins down that were previously only described: the **severity rule
  table** (severity is correlation output, computed as the highest of six
  contributions) and the **nine v1 drift rules** with their conditions and
  suggested resolutions. "Last real activity" is given an explicit definition
  and an explicit exclusion list, so the staleness gauge is falsifiable.
- **v1 task breakdown** (`specs/001-ground-control-v1/tasks.md`) — 175 tasks
  across setup, four milestones, packaging, and the privacy audits, organized by
  milestone rather than by user story because v1 is sequenced headless-first.
  Story labels ride along for traceability. Three tasks are build-failing gates
  rather than findings: adapter conformance (XII), eighteen drift tests — one
  firing and one declining per rule (XVIII), and the no-auto-dispatch assertion
  (XVI).
- **v1 implementation plan** (`plan.md`, `research.md`, `data-model.md`,
  `contracts/`, `quickstart.md`). Constitution gate XII is closed by an
  **operation registry** in a framework-free `core` package, with IPC, loopback
  HTTP, and MCP as three thin adapters over it and a conformance test that fails
  the build when an adapter omits an entry. Two gates became structural rather
  than procedural in the process: freshness is a required `Envelope<T>` output
  schema, so an operation *cannot* return provider data without its age (XIV);
  and `outbox.enqueue` requires a single-use token that only a UI gesture mints,
  so no sync, drift rule, or timer can dispatch an action even by mistake (XVI).
- **Two Phase 0 findings that changed the design** — Jira's search endpoint no
  longer returns issue history or a result total, so "last real activity" needs
  a separate bulk changelog fetch and lane counts can never imply a server-side
  total; and GitHub's ahead/behind is a per-branch comparison with a real
  rate-limit cost, so comparisons must be aliased into one document and skipped
  when a branch head has not moved.
- **Spec quality checklist** (`specs/001-ground-control-v1/checklists/`) — the
  validation pass plus a map from every constitution Part II gate to the
  requirements that honour it. Gate XII is the one left open on purpose; it is
  a plan-time concern.
- **Constitution v3.0.0** — Part I keeps the ten process principles; Part II
  adds eight product and architecture gates (XI–XVIII): local-first and
  single-user, one service layer with thin adapters, mirrored vs authored
  stores, freshness always shown, per-provider degradation, read-only by
  default, cross-platform with Windows first-class, and a mandatory tested
  correlation engine. `speckit-plan` gates every design against Part II.
- **`stacks/electron.md`** — the stack pack for this project: main/preload/
  renderer boundaries and context isolation, IPC patterns, React renderer
  conventions, `better-sqlite3` native-module and ABI handling, OS-keychain
  credential storage, safe `shell.openExternal`, and npx delivery with the
  Electron runtime fetched from GitHub releases at first run.
- Bootstrapped the repo with the `ai-tools` toolkit: the operating rules
  (`AGENTS.md`, `CLAUDE.md`), the Spec-Kit engine and templates (`.specify/`),
  three read-only subagents and five slash commands (`.claude/`), and the
  stack packs (`stacks/`).
- Node/Electron `.gitignore` covering build and packaging output, native
  modules, the cached Electron runtime, and local SQLite state — replacing the
  Next.js-flavored one the toolkit ships.
- Constitution **Principle X — Ask One Question at a Time, With a
  Recommendation**, mirrored into `AGENTS.md` as rule 10 so it is actually
  loaded into a session.
- `CHANGELOG.md` and `STATUS.md`.
- Command page design references under `resources/design/` (brand and design
  system), to be consumed at `speckit-plan`.

### Changed

- Constitution `3.1.0` → `4.0.0` (MAJOR): Principle XVI redefined from
  "Read-Only by Default" to "Read-Only Credentials; Writes Are Dispatched and
  Confirmed". Ground Control's own credentials stay read-only and the service
  layer may never call a provider write API, but it may now dispatch an
  individually-confirmed action through the action outbox for an agent to
  execute with its own credentials. This permits what the previous wording
  forbade, so it is a redefinition of a non-negotiable, not a clarification.
- Constitution `3.0.0` → `3.1.0` (MINOR): Principle X now requires the
  recommendation to be presented as one selectable option among its real
  alternatives, each with its cost and risk stated, rather than as prose.
- Constitution `2.0.0` → `2.1.0` (MINOR: a principle added, none redefined).
- `AGENTS.md` and `MANIFEST.md` updated from nine rules to ten.

### Removed

- `docs/interview-cheat-sheet.md` and every pointer to it. The time-boxed /
  live-engagement mode survives as a concept in the constitution's Governance
  section but no longer has a companion document.

[Unreleased]: https://github.com/jonupchurch/grndctrl/commits/main
