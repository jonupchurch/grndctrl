# Changelog

All notable changes to Ground Control (`grndctrl`) are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Released versions are at the top, newest first. The v1 releases are summarised
there and their detail is in **[Unreleased]** below them, which holds the
accumulated working record of that build. **0.4.0 carries its own detail**
instead: it is a removal, and what an upgrader needs is the list of what is gone,
not a sentence saying a lot is.

## [0.4.0] — 2026-08-19

**Ground Control is a Jira board and an agent board.** The GitHub provider, the
local git reader and drift detection are removed — all of them, not a subset.
Two of the four lanes, the Attention region and the DRIFTING tile go with them.

### Breaking

Read this list before upgrading. Everything in it is a removal, and there is no
compatibility shim for any of it.

- **Operations.** `drift.list`, `drift.dismiss` and `drift.undismiss` are gone
  from the registry, so they are gone from IPC, the loopback API and MCP at once.
  The MCP tool `grndctrl_get_drift` went with them. Nothing returns an empty
  list in their place: a tool that always answers "nothing" is a claim this
  application is no longer entitled to make.
- **`sessions.start` and `sessions.activity` no longer accept `workspaceKey`**,
  and both are now strict — an agent still sending it is told, rather than
  having it silently dropped (FR-115).
- **`links.resolve` lost four of its seven targets**: `pull-request`, `branch`,
  `check` and `workspace`. Each is now a validation error naming the targets that
  exist, rather than a fallback to the ticket page. A caller asking for a pull
  request link and handed the ticket has been answered wrongly in a way it cannot
  detect.
- **Work items lost five fields**: `pullRequests`, `checks`, `branches`,
  `comparisons` and `workspaces`. **`ticket` is no longer nullable** — every row
  is a ticket now, so the null is unreachable.
- **`board.summary` lost `drifting`**, and `lanes` lost its `pulls` and
  `branches` entries. The three counts that remain — `yourCourt`, `stalled`,
  `agentsLive` — keep their definitions exactly; the numbers get smaller because
  the board is smaller.
- **`projects.upsert` and `projects.list` lost five fields**:
  `githubConnectionId`, `repoOwner`, `repoName`, `checkoutPaths` and
  `ticketKeyPattern`. A project is a Jira project key, a code, a name and an
  optional documentation URL. **`projects.upsert` now refuses a project that
  names no ticket project.**
- **`connections.list` returns only `jira` connections**, and its `kind` is a
  one-member enum. The credential channel has refused any other kind since the
  first commit of this change.
- **Settings changed shape.** `pollIntervalSec.github` is gone.
  `laneThresholdHours` is now `{ tickets, sessions }`: `pulls` and `branches`
  went with their lanes, and `sessions` **takes the old `pulls` value of 24
  hours** rather than defaulting, because that is what the number meant. The
  migration carries it across. `driftGraceHours` is deleted.
- **`ActionKind` narrowed** to `transition-ticket` and `investigate`.
  `request-review` and `cleanup-workspace` are retired. The `outbox_actions.kind`
  column deliberately has **no** CHECK constraint, so a queued action of a
  retired kind written before the upgrade still reads, still claims and still
  completes — an action the operator confirmed is theirs, and a narrowing type is
  not entitled to make it unopenable.
- **`ResourceKind` is now `tickets` alone**, which narrows `sync.now` and every
  freshness reading.

### Data

Two migrations run on first launch, and one of them touches data that has no
copy anywhere.

- **`mirror.db` migration 4** deletes every non-Jira connection, rebuilds
  `connections` with `CHECK (kind IN ('jira'))`, and drops `pull_requests`,
  `check_results`, `branch_refs`, `comparisons` and `local_workspaces`. The
  mirror is a cache; everything in it comes back from Jira on the next sync.
- **`authored.db` migration 2** drops four columns from `projects` and
  `workspace_key` from `agent_sessions`, and reshapes the settings payload.
  **Nothing the operator wrote is deleted.** A project bound to a repository and
  no Jira project is *kept*, not removed, even though the current write path
  would refuse to create one (FR-110).
- **Notes survive on subjects that no longer exist.** A note written against a
  pull request, a branch or a checkout is still listed and still editable, and
  reads as orphaned — which is what it is, and is better than deleting something
  a person wrote (FR-122). Finding dismissals are retained for the same reason,
  with the consequence that the `D1`—`D9` identifier namespace is spent: any
  future finding scheme starts at `D10`.
- **Credentials for removed connections are deleted from the keychain.** The
  connection row is the only record of where its secret lives, so the handles are
  read *before* the migration runs and the keychain entries are deleted after it
  (FR-112). Without that ordering, a revoked-looking connection would leave a
  live token behind that no screen could reach.

### Removed

- **The GitHub provider**, the pull-request lane, the branch lane, CI check
  results, and branch comparisons.
- **The local git reader.** No checkouts, no working trees, no `git`. **The
  application now spawns no child process at all**, and a test fails the build if
  one appears in the shipped tree.
- **All nine drift rules**, the Attention region, the DRIFTING tile, the
  dismissal read and write paths, and the confirm-and-dispatch route that ran
  from a finding's suggested action into the action queue.
- **The age column**, which only the two removed lanes still drew. The fact is
  not lost: the staleness bar in the leftmost track is derived from the same
  timestamp and carries the exact age in its `title`.
- **`--repo` and `--checkout`** from `scripts/bind-project.mjs`.

### Added

The agent console, arriving with the removal above rather than after it: 006
leaves a board thin enough that the layout deserved a second look, so both
changes ship as one release.

- **Every region on the board folds**, and the choice survives a restart.
  Collapsing renders no children rather than hiding them — `display: none`
  would leave a folded two-hundred-row lane in the page, and both the
  performance budget and the greyscale count use `querySelectorAll`, which
  cannot tell a hidden row from a visible one. What stays visible when a region
  is folded is its count and its freshness: tidying the board must not become a
  way of not being told it cannot refresh. Only the folded regions are stored,
  so expanding one deletes its key rather than accumulating a dead one.

- **An active ticket**, in a panel of its own, settable by an agent over MCP.

  Three new operations — `focus.get`, `focus.set`, `focus.clear` — all at
  exposure `all`, with `grndctrl_set_active_ticket` and its two companions on
  the MCP surface. This is the one that must not be `ui-only`: parking the
  pointer on `settings` would have been less code and would have put it out of
  reach of the caller it exists for.

  **Who set it comes from the transport, never from the payload.** An agent
  cannot record the operator as having set a ticket itself.

  **A key the mirror does not hold is legal and is not fetched.** An agent may
  set focus before the sync that would fetch the ticket, and a ticket that is
  not the operator's is never in this mirror at all — so the panel shows the
  key, says plainly that it has no summary or status for it, and still offers
  the link. Turning an agent's input into a network call the operator did not
  ask for is the thing being avoided.

  The ticket lane's rows gained a matching control, so the operator can set it
  by hand from the row they are looking at.

- **The ticket description**, converted and rendered as structured content.

  Jira Cloud returns `description` as Atlassian Document Format, a JSON node
  tree. Ground Control converts it **at ingest** through a whitelist and stores
  the result: paragraphs, headings, lists, code blocks, block quotes, rules,
  tables, mentions, inline cards, and the `strong` / `em` / `code` / `link`
  marks.

  **A node outside the whitelist becomes a labelled placeholder naming it**, and
  is never dropped. A description whose acceptance criteria were in a `panel`
  node reads as complete once the node is gone, with nothing on screen to
  suggest otherwise.

  Neither `expand=renderedFields` nor an ADF renderer package was used. The
  first would put provider HTML on a page whose CSP is `default-src 'none'`; the
  second would bring a large React tree into an application with four production
  dependencies.

  **Links inside a description open**, and the renderer still cannot choose a
  destination. A click sends the URL *and the ticket it is on*, and main refuses
  any URL that ticket's own description does not contain, checked against core's
  copy rather than the page's. So an injected script may send any string it
  likes and every string that is not already on the operator's board is refused.
  The link is a `<button>` with no `href`: there is no live destination in the
  DOM to read, drag or middle-click.

  This adds a third non-operation IPC channel, `grndctrl:open-url`. It is
  separate from the launcher channel rather than a field on it, so that "the
  launcher path has no URL argument" stays exactly true and the narrower
  capability can be audited on its own.

### Known gaps

Named rather than left to be discovered.

- **Two of the new panels are empty until an agent uses them.** The active
  ticket is populated by MCP in the normal case; nothing in this application can
  make an agent call a tool.
- **Nothing in the interface can put an action in the outbox.** The queue, its
  durability and the claim protocol are all still here and still tested; the only
  route to it from a screen ran through a drift finding, and that route left with
  drift. Agents can still list, claim and complete. The operator's half comes
  back with the agent console.
- **Open questions have nowhere dedicated to be shown.** A `question-for-human`
  note still moves its work item's ball-in-court to the operator and still puts
  the session into `needs-you`, so the signal reaches the row. The *list* of them
  was in the Attention region. Also the agent console.

### Fixed

- **The severity fixture had aged out of producing the severities it is named
  for.** `every-severity.json` carried absolute 2026-08-14 timestamps, and
  severity derives partly from staleness, so a fortnight later every item in it
  had passed 3× the ticket threshold and the scenario meant to show four bands
  showed one. Three greyscale tests had been failing on `main` for long enough to
  look like scenery. Scenario timestamps are now offsets resolved when the file
  is loaded, and a test asserts the four bands still appear a year out.
- **A scenario meant two different boards depending on which program read it.**
  `noteCounts` was stated in the file and could only be honoured by the text
  board; the desktop seed writes a real authored store, where the count comes
  from the notes that are actually in it. Scenarios state their notes now, and
  both readers derive the rest.
- **`sessions.activity` would have built invalid SQL** for any caller still
  passing `workspaceKey`. The column was dropped by the migration and the patch
  type lost the field with it, but the service still forwarded it.

## [0.3.0] — 2026-08-19

The ticket lane now shows the **sprint** each ticket is in, and **every column
heading sorts its lane**. The ticket lane gave up its age column to make room —
only that lane, and only because the staleness bar beside every row already
carries the same fact. A minor rather than a patch because the mirror gains a
third migration and `Ticket` gains a field.

## [0.2.0] — 2026-08-18

The ticket lane now shows **priority** and **story points**, all three lanes name
their columns, and the drift panel has moved **below** the tickets rather than
above them. A minor rather than a patch because the mirror gains a schema
migration and `Ticket` gains two fields.

## [0.1.3] — 2026-08-16

The setup screen no longer asks for a GitHub permission that does not exist.
Settings → Connections, `README.md` and `.env.example` all told new users to
grant a fine-grained token read on "Checks"; GitHub's picker has no such entry.
All three agreed with each other and none agreed with GitHub. See below.

## [0.1.2] — 2026-08-16

The board now updates when an **agent** acts, not only when the window does. In
0.1.1 a session could start, run and end with an open board showing none of it —
push events were wired to the IPC dispatch and not to the loopback one agents
use. First release cut from a tag. See below for the detail, including the push
loop the first version of the fix introduced.

## [0.1.1] — 2026-08-16

First working release. `npx grndctrl` runs on Windows, macOS and Linux.

`0.1.0` was published the same day and is broken on Windows and macOS; it is
superseded and should be treated as withdrawn. See below for what it was.

## [Unreleased]

### Added

- **The sprint a ticket is in**, on the ticket lane.

  Sprint is a Jira **custom field** like story points, so it has no fixed id
  either — but unlike story points it has one exact answer available: Jira
  Software stamps every sprint field with the schema key
  `com.pyxis.greenhopper.jira:gh-sprint` whatever the site has renamed the field
  to. So the lookup matches on the schema key first and falls back to an exact
  name only for payloads that omit `schema`. A text field somebody called
  "Sprint" is refused, and so is `Sprint Goal`.

  Both custom field ids now come out of **one** `/rest/api/3/field` request.
  Asking twice would spend a round trip on a payload already in hand, and would
  let the two columns disagree about which fetch they came from if one call
  failed and the other did not.

  **A ticket is usually in several sprints**, and the column shows one. Jira's
  sprint field is an array and a carried-over ticket keeps every sprint it has
  been through — so the provider chooses at ingest: the active sprint, else the
  nearest future one, else the most recent closed one, and within a rank the last
  entry, because Jira returns them oldest first. Rendering the first entry would
  put a sprint that ended a month ago on the row.

  Two payload shapes are read, because two are sent: Jira Cloud's objects and the
  older Java `toString` form (`…Sprint@1[id=7,name=Sprint 12,state=CLOSED,…]`),
  which a site answering it would otherwise show as a class name. A name with a
  comma in it survives.

  A ticket in no sprint is the **placeholder, never "Backlog"** — Jira's backlog
  is a specific place a ticket can be in or out of, and a ticket can be outside
  every sprint without being in it.

  `mirror.db` migration **3**, one nullable column with no default.

- **Every column heading sorts its lane** — press for ascending, again for
  descending, a third time for the order core sent.

  Headings rather than a "sort by" dropdown. A dropdown is a second place the
  current order is stated and the two drift: the control reads "Priority,
  descending" while the eye is on a column that no longer looks sorted, and
  nothing on screen resolves it. The caret and the column it sits on are one
  claim.

  **Unsorted is a real state and the one a lane opens in.** Core hands the board
  back ordered by natural key, deterministically, and that order is what makes
  two syncs comparable at a glance; a two-way toggle would have made it
  unreachable after the first click.

  **Unknown sorts last in both directions.** Null means unknown — no estimate, no
  sprint, no priority set — and unknown is not "small". A null-as-zero comparison
  looks right ascending and then opens "points, biggest first" with a screenful
  of tickets nobody has estimated.

  **Priority is ordered, never relabelled.** Alphabetical is actively wrong here
  — `High` above `Highest`, `Low` above `Medium` — so Jira's own ladder gets an
  order for sorting purposes only. Nothing about it is stored or displayed: a
  site using `P1`…`P4` or `Blocker`/`Critical` falls through to alphabetical,
  which for those schemes is the order they intend, and every unknown word sorts
  after every known one rather than interleaved.

  Sort state is **per lane**, because the lanes are not three views of one list,
  and is **not persisted**: the project filter is a standing choice about what
  the board is for, a sort is a question asked of the board as it stands, and one
  restored from last week would present itself as the natural order of things.

  The heading row is **no longer `aria-hidden`**. It was, deliberately — eight
  bare nouns announced once before the list are no more use than reading the
  ruled lines — but `aria-hidden` over a focusable control is a keyboard trap in
  reverse. The sortable headings are real buttons that announce what they do and
  which way the lane is currently ordered; Links, Court and the two blank tracks
  are still hidden individually.

- **Priority and story points on the ticket lane**, with column headings on all
  three lanes.

  Priority is stored and shown **exactly as the tracker spells it** — `Highest`,
  `P2 - Major`, `Blocker` — and is not mapped onto a band of ours. Status already
  taught this lesson: teams rename these, and a normalisation would produce a
  confident wrong word. Unlike status there is no `statusCategory` to fall back
  on, because Jira's priority field carries a name and an icon and nothing that
  orders them.

  Story points needed a lookup rather than a field name. There is **no fixed
  field id**: `Story Points` and `Story point estimate` are different custom
  fields, numbered per site, so the provider reads `/rest/api/3/field` once per
  sync and resolves the id — preferring the company-managed field when a site
  that has migrated project types carries both, refusing `timeestimate` (which
  is numeric, is not custom, and would render a two-day ticket as a
  57,600-point one), and refusing any field declaring itself as something other
  than a number.

  **A failed lookup loses the column, not the lane.** Story points are one
  column; the ticket search is the lane, so a site that answers 403 on the field
  list still gets its tickets. And the id is only named in the search when it
  was actually resolved — Jira rejects a whole search that mentions a field the
  site does not have.

  Unknown is drawn as an en dash and **never as `0`**. `Number(null)`, `?? 0`
  and `|| 0` all produce a zero, all typecheck, and all put an estimate on a row
  that nobody made; the store keeps a genuine 0-point estimate distinct from an
  absent one, and there is a test for exactly that pair.

  `mirror.db` migration **2**, adding two nullable columns with no `DEFAULT`. A
  `DEFAULT 0` would have told the operator that every ticket they had ever
  synced was estimated at zero, by the migration, on their behalf.

- **Column headings**, per lane and named per lane. The third column is a
  ticket's summary, a pull request's title and a branch's ticket, so one shared
  heading would have to be vague enough to be true of all three. The two ticket
  columns exist only on the ticket lane: a pull request has no priority and a
  branch is not estimated, and a column that can never hold anything is noise
  rather than the meaningful absence the row's other placeholders carry.

  The headings were `aria-hidden` when they were labels only: a screen reader
  does not read this layout as a grid, so they would have arrived as eight bare
  nouns before the list and never again, and the cells that need naming carry a
  `title` instead. That held until they became sort controls — see the sorting
  entry above for what replaced it.

### Changed

- **The ticket lane no longer shows an age column.** Three metric columns do not
  fit beside it at any width the board can spare, and age is the only one of them
  with a stand-in on the same row: the staleness bar in the leftmost track is
  derived from the same timestamp and carries the exact age in its `title`. The
  pull request and branch lanes keep theirs, where "stale past 24h" is the whole
  point of the lane.

- **The Attention panel now sits below the ticket lane**, at the operator's
  request. It was above all three lanes because drift is the one thing on this
  board that no other tool reports. What that argument missed is that the panel
  is *tall* — each strip carries both sides of the evidence and its age — so a
  board with three findings opened on the disagreements and pushed the work
  itself below the fold. The "Drifting" tile still reports the count from the
  top.

### Fixed

- **Columns did not line up down a lane once any row had a note.** The row's
  last two grid tracks were `auto`, which sizes to content — and the note badge
  is `+` on a row with no notes and `12` on a row with twelve. Every row is its
  own grid container, so the wider badge came out of the flexible title column
  and shifted *every column after it* on that row alone. The claim at the top of
  `Row.tsx`, that the eye can read a column rather than re-parse each row, was
  quietly false the whole time.

  Found by adding the headings, which have neither badge nor severity mark and
  so collapsed both tracks to zero and sat 26px out of step with everything
  below — visible immediately, where the row-to-row version had been invisible
  for months. Both tracks are now pinned, and two end-to-end tests assert the
  pixel offsets: one that the headings sit over their columns, one that the row
  the golden path writes a note on still lines up with the row below it. Both
  were made to fail before being relied on.

  The heading also **is not a `.row`**. Written as `row row--head` first, it was
  a row to everything that looks for one — the performance test counts
  `.row` to assert SC-013's two hundred items, and read 302. It borrows the
  grid and takes none of the identity.

- **The first screen a new user meets asked for a permission that does not
  exist.** Settings → Connections told you to grant a fine-grained token read on
  "Metadata, Contents, Pull requests, **Checks** and Commit statuses". GitHub's
  fine-grained picker has no `Checks` entry — confirmed against GitHub's own
  permission reference, and by an operator scrolling the list for it and not
  finding it. The same wrong instruction was in `README.md` and `.env.example`,
  so all three routes into the product agreed with each other and none agreed
  with GitHub.

  Verified the replacement rather than assuming it: a token holding only
  Metadata, Contents, Pull requests and Commit statuses read this repository's
  pull requests over GraphQL and returned **14 `CheckRun` nodes** on PR #3 —
  matching the check count CI actually reported, which is what makes it a
  control and not a coincidence. Every context came back as `CheckRun` rather
  than `StatusContext`, which is the detail behind the confusion: Actions
  produces check runs, and `Commit statuses` is the permission that governs the
  other kind.

  No test guards this. A test asserting a word is absent from prose could not
  fail for the reason that matters — GitHub renaming a permission — and would be
  counted as coverage it does not give.

- **The board never noticed what an agent did.** The Agent Sessions panel says
  *"a session appears here the moment one starts, whether or not this window is
  open."* The second half was true; the first was not. An agent could start a
  session, report activity and end it, and an open window showed none of it
  until an unrelated provider sync happened to invalidate everything — or the
  operator refreshed.

  **The cause was one dispatch too few.** Push events are derived by wrapping a
  dispatch, and `main/index.ts` wrapped the one it hands the **IPC** adapter.
  The loopback adapter that agents use dispatches straight through the registry
  and was wrapped by nothing. So every event fired for what the *window* did and
  none for what an *agent* did — including `outbox:changed`, whose own comment
  claimed it fired "by this window **or by an agent over MCP**."

  Both halves were individually correct, which is why 764 tests passed over it.
  Finding it needed an agent, an open window, and something watching both at
  once — which is now `test/e2e/agent-push.spec.ts`.

  The fix adds a fourth channel (`sessions:changed`) and, more importantly, an
  `onDispatched` hook on the loopback adapter so **both** surfaces feed the same
  `afterDispatch` mapping.

- **A push loop, introduced by the above and caught only by running it.** The
  first version matched `sessions.` by prefix, which also matches
  `sessions.list` — a read. The renderer answers an announcement by refetching,
  the refetch *is* a `sessions.list`, and one agent call produced **hundreds** of
  broadcasts. Every unit test still passed.

  So the rule no longer guesses from a name: `push` takes a `mutates` predicate
  read from the registry, which already records which operations write. That
  also closes the same latent loop on `outbox.list` and `outbox.pending`.

  Probed: removing the agent wiring fails the end-to-end test; removing the
  `sessions.` mapping fails it; a control edit that changes nothing keeps
  passing. A unit test pins the read-does-not-announce rule directly.

  One casualty worth recording: a test asserting "a throwing listener does not
  break the agent's request" was deleted rather than kept. A probe showed it
  could not fail — the response is flushed before the listener runs, so the
  guarantee comes from ordering, not from the `try/catch` it claimed to
  exercise. A test that cannot fail is worse than no test, because it is counted.

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
