# Feature Specification: Ground Control v1

**Feature Branch**: `001-ground-control-v1`

**Created**: 2026-08-14

**Status**: Draft

**Input**: Ground Control (`grndctrl`) v1 — a local-first desktop command station that correlates Jira tickets, GitHub pull requests and CI, local git state, and AI agent sessions into one board, detects when those sources disagree, and lets the operator act on the disagreement.

> **Source of truth.** Where this spec and `resources/grndctrl-claude-code-kickoff.md` disagree, this spec wins; the brief is a historical input. The decisions that override it are recorded in `STATUS.md` under *Locked decisions* and *Decided in the spec*. Constitution v4.0.0 Part II (XI–XVIII) are hard gates on everything below.

---

## The problem

A developer running several projects at once holds the same question in their head all day: **what actually needs me right now?** Answering it means checking a ticket tracker, a code host, a CI dashboard, a local terminal, and — increasingly — one or more agent sessions, then mentally joining them: *this ticket has that branch, which has that PR, whose checks are red, and an agent is mid-edit on it.* The join is done by hand, repeatedly, and it silently rots: a PR merges and its ticket stays In Review for a week; an agent finishes and nobody notices; a branch sits with uncommitted work behind a branch that moved on.

Ground Control does the join once, keeps it fresh, shows what disagrees, and gets the operator to the right page in one click.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One board of everything in flight (Priority: P1)

The operator configures one or more projects — each a ticket project, a code repository, and optionally a documentation link — and points the app at the local checkouts. The app pulls tickets, pull requests, CI results, and local git state, joins them into **work items**, and shows them on a single page: three lanes (tickets, pull requests, open branches), a set of headline counts, and a ball-in-court panel. Every row states how fresh its data is, how long since anything real happened to it, and whose move it is. Clicking any row opens that thing in the browser.

**Why this priority**: This is the product's floor. Without the correlated board there is nothing to detect drift on, nothing to attach notes to, and nothing to dispatch from. It is also independently valuable on its own — a single page replacing four tabs is worth using even if nothing else ships.

**Independent Test**: Configure one project against a real ticket project and repository with a local checkout. The board renders tickets, PRs, and branches correlated into work items, each with a freshness indicator, a staleness gauge, a severity mark, and a ball-in-court label. Clicking each row type opens the correct provider page.

**Acceptance Scenarios**:

1. **Given** no projects configured, **When** the operator opens the app, **Then** it shows an empty state that explains what a project is and how to add one — not an error and not a blank page.
2. **Given** a project bound to a ticket project, a repository, and a local checkout, **When** the first sync completes, **Then** every ticket, open PR, and open branch appears in its lane, and PRs, branches, and tickets that belong together are joined into a single work item.
3. **Given** a ticket with three open PRs, **When** the board renders, **Then** it appears as **one** work item with three related PRs — not three work items.
4. **Given** any row on the board, **When** the operator clicks it, **Then** the corresponding provider page opens in the default browser and the app does not navigate away from the board.
5. **Given** a branch that has never been pushed, **When** the operator clicks it, **Then** the repository page opens (there is no branch page to open) and the row shows only facts local git can supply.
6. **Given** several projects configured, **When** the operator selects one project's chip, **Then** every lane and panel filters to that project and a header appears with that project's ticket-project, repository, and documentation links.
7. **Given** data last refreshed some minutes ago, **When** the operator reads any lane, **Then** the age of that data is visible without hovering or clicking.

---

### User Story 2 - Catch the sources disagreeing (Priority: P2)

The app continuously compares what each source claims. When they disagree — a merged PR under a ticket that is still In Review, an active agent session on a ticket nobody moved out of Todo, a branch named for a ticket that does not exist — it raises a **drift finding** at the top of the page, in an Attention region, with both sides of the evidence, how long the disagreement has stood, and a suggested resolution.

**Why this priority**: This is the differentiator. Every other feature exists in some other tool; nothing else the operator uses knows that the ticket and the PR contradict each other. It depends on US1's correlation but is separately demonstrable and separately valuable.

**Independent Test**: Run the correlation engine against a fixture set of recorded provider states — no network, no desktop shell — and assert the exact set of drift findings produced for each fixture, including the ones that must produce none.

**Acceptance Scenarios**:

1. **Given** a ticket in a non-terminal status whose only PR merged more than the grace period ago, **When** correlation runs, **Then** a drift finding is raised naming both the ticket and the PR, with the age of the disagreement and a suggested resolution of moving the ticket to its terminal status.
2. **Given** a ticket in a backlog status with an active branch, PR, or agent session, **When** correlation runs, **Then** a drift finding is raised suggesting the ticket move to in-progress.
3. **Given** a branch whose name contains a ticket key that exists in no bound project, **When** correlation runs, **Then** a drift finding is raised for the unknown key and **no** work item is created for it.
4. **Given** a ticket and PR that agree, **When** correlation runs, **Then** no drift finding is raised for them.
5. **Given** a drift finding that has been raised, **When** the underlying disagreement is resolved at the source and a sync completes, **Then** the finding disappears without operator action.
6. **Given** a drift finding the operator judges to be noise, **When** they dismiss it, **Then** it stays dismissed across restarts unless the underlying evidence changes.
7. **Given** correlation runs twice over unchanged inputs, **When** the results are compared, **Then** they are identical, including finding identifiers.

---

### User Story 3 - Agent sessions as first-class work (Priority: P3)

Agent sessions report themselves to the app as they run — what they are working on, that they are still alive, what they need. They appear as their own lane, feed the headline counts, and take their turn in ball-in-court alongside the operator and other people. A session that stops reporting is shown as **silent**; a session that has asked a question is shown as **needing you**.

**Why this priority**: An agent working unattended is exactly the work most likely to be forgotten, and it is invisible in every other tool the operator has. It is additive to US1 and US2 — pull it out and the board still works.

**Independent Test**: Start a session through the agent interface, send heartbeats, change its reported status, stop sending heartbeats, and end it. The session lane reflects each transition, including going silent on a missed heartbeat, without any provider involvement.

**Acceptance Scenarios**:

1. **Given** an agent reports a session start against a work item, **When** the board refreshes, **Then** a session row appears in the session lane, attributed to the correct project and work item.
2. **Given** a running session, **When** its heartbeat interval elapses without a heartbeat, **Then** the row moves to a silent state and the elapsed time since last contact is shown.
3. **Given** a silent session, **When** a heartbeat arrives again, **Then** the row returns to running without creating a second session.
4. **Given** a session with an open question for the operator, **When** the board refreshes, **Then** the session shows as needing the operator, the question surfaces in Attention, and ball-in-court for that work item resolves to the operator.
5. **Given** a session that reports completion, **When** the board refreshes, **Then** it shows as finished and stops counting toward live sessions.
6. **Given** the app restarts while a session was running, **When** it comes back up, **Then** the session is still listed, with its liveness re-evaluated against the heartbeat rule rather than assumed.

---

### User Story 4 - Durable context on the work, shared with agents (Priority: P4)

The operator — or an agent — attaches typed notes to a ticket, PR, or branch: a decision, a gotcha, a question for the human, a to-do. Each row shows how many notes it carries; clicking opens a modal to read and edit them. Questions for the human also surface in Attention. Notes are authored data: they survive resync, provider outages, and cache rebuilds, and they re-attach if their subject reappears.

**Why this priority**: This is the only place in the system where knowledge that exists nowhere else is stored, and it is the shared channel between operator and agent. It has no dependency on drift or dispatch.

**Independent Test**: Attach one note of each type to a ticket, a PR, and a branch; delete and rebuild the entire mirrored cache; confirm every note is still attached to the right subject with its type and text intact.

**Acceptance Scenarios**:

1. **Given** a row with no notes, **When** the operator adds one, **Then** a count appears on the row and the note is retrievable after a restart.
2. **Given** a note of type question-for-human, **When** the board refreshes, **Then** it appears as a nudge in Attention in addition to its row count.
3. **Given** the mirrored provider cache is discarded and rebuilt from scratch, **When** the board renders, **Then** every note is still attached to its original subject.
4. **Given** an agent writes a note through the agent interface, **When** the operator opens that row, **Then** the note is visible and editable by the operator, and vice versa.
5. **Given** the operator has a note open in the modal and an agent writes to the same note, **When** the operator saves, **Then** the stale save is rejected and the conflict is shown — the other party's text is never silently overwritten.
6. **Given** a note attached to a branch that is deleted and later recreated with the same name in the same repository, **When** it reappears, **Then** the note re-attaches to it.

---

### User Story 5 - Act on what you found (Priority: P5)

When the operator sees drift or decides something needs doing, they can hand the work to an agent. Confirming an action places it in a durable outbox. Any agent that connects — now or later — can list pending actions, claim one, do it with its own credentials and its own authority, and report the result. The operator watches the action's state on the board. Ground Control itself never writes to a provider.

**Why this priority**: Highest leverage but the most dependent: it needs correlation to find the work, drift to justify it, and sessions to execute it. Nothing else breaks without it.

**Independent Test**: With no agent connected, confirm an action; it persists as pending across a restart. Connect an agent afterwards; it lists, claims, and completes the action, and the board reflects each state change.

**Acceptance Scenarios**:

1. **Given** a drift finding with a suggested resolution, **When** the operator activates it, **Then** they are asked to confirm that specific action before anything is queued.
2. **Given** the operator confirms an action while no agent is connected, **When** the app restarts, **Then** the action is still pending and still claimable.
3. **Given** a pending action and a connected agent, **When** the agent claims it, **Then** the action shows as claimed with the claiming agent and time, and no second agent can claim it.
4. **Given** a claimed action, **When** the agent reports completion, **Then** the action shows as complete and the next sync reflects the resulting provider change through the normal read path.
5. **Given** a claimed action whose agent never reports, **When** the claim window elapses, **Then** the action returns to pending and is claimable again.
6. **Given** any sync, drift rule firing, or timer, **When** it runs, **Then** no action is ever created or dispatched as a side effect of it.
7. **Given** the operator wants nothing to happen, **When** they cancel a pending action, **Then** it is removed from the outbox and never delivered.

---

### User Story 6 - Keep working when a source is down (Priority: P6)

One provider being unreachable, rate-limited, or unauthorized degrades only what that provider feeds. The rest of the board keeps working, keeps showing the last known good data, and says plainly that it is stale and why.

**Why this priority**: Cross-cutting resilience rather than a feature, but it is the difference between a tool that is trusted daily and one that is abandoned the first morning a token expires. It is independently testable against every prior story.

**Independent Test**: With a fully populated board, revoke or block each provider in turn. Lanes fed by that provider show a degraded state with the reason and the age of the last good data; every other lane stays live and interactive.

**Acceptance Scenarios**:

1. **Given** the ticket provider is unreachable, **When** the board refreshes, **Then** the ticket lane shows its last known data marked stale with the failure reason, and the PR, branch, and session lanes remain live.
2. **Given** a provider returns an authorization failure, **When** the board refreshes, **Then** the operator is told which connection needs re-authorization and where, without other lanes erroring.
3. **Given** a provider is rate-limited, **When** the board refreshes, **Then** the lane shows when refresh will be retried rather than repeatedly failing.
4. **Given** local git cannot read a configured checkout because the path has moved, **When** the board refreshes, **Then** the branch lane says which checkout is missing, and remote-derived facts about those branches still render.
5. **Given** any provider failure, **When** the operator looks at affected rows, **Then** *stale* and *failed to refresh* are visibly different states.

---

### Edge Cases

- **A ticket key matches nothing.** A branch or PR carries a key from no bound project — raised as a drift finding, never rendered as a work item.
- **Work with no ticket.** A branch and PR with no key at all still form a work item, keyed on the workspace, and are shown as unlinked.
- **One ticket, many workspaces.** A ticket with branches in more than one repository or worktree stays one work item listing all of them.
- **Two projects, one repository.** The same repository bound to two projects — each project's key pattern claims only its own tickets; a branch matching both is attributed to the first match and flagged.
- **A never-pushed branch.** Ahead/behind is unknown, not zero; the row shows only what local git knows and says so.
- **A branch deleted upstream while a local worktree still points at it.** Raised as drift; the worktree remains listed as abandoned.
- **Uncommitted changes with no session running.** Distinct from uncommitted changes with a live agent session — the first is likely forgotten work, the second is expected.
- **The heartbeat that never stops.** A session whose agent process died but whose heartbeat is still being sent by something else — the session ages on last *real* activity, not on the heartbeat alone.
- **Clock skew.** An agent reports a timestamp in the future — clamped to receipt time rather than sorting to the top of the board forever.
- **A duplicate session start.** The same session identifier started twice — treated as a resumption, not a second row.
- **Concurrent note edits.** Operator and agent editing the same note — the later write is rejected, not merged, and the conflict is surfaced.
- **A note whose subject vanishes.** A ticket deleted at the provider — the note is retained and shown as orphaned, never destroyed.
- **Dispatch with nobody home.** No agent has ever connected — the action waits in the outbox and the board shows plainly that nothing is listening yet.
- **Dispatch to an agent that cannot do it.** The claiming agent lacks provider write access — it reports failure with a reason and the action is shown as failed, not silently lost.
- **More projects than colors.** Beyond the defined project colors, projects fall back to a neutral chip carrying only the short code.
- **The keychain is unavailable.** The operating system credential store cannot be reached — the app says so and refuses to fall back to storing credentials anywhere else.
- **First run with no clock on the data.** Nothing has ever synced — lanes show *never synced* rather than an age of zero.
- **Rate limit exhaustion mid-sync.** A partial sync leaves some resources fresh and others stale — freshness is tracked per resource kind, not per app.

---

## Requirements *(mandatory)*

### Configuration and credentials

- **FR-001**: The operator MUST be able to define a **project** as one ticket project, one code repository, and an optional documentation URL, plus one or more local checkout paths for that repository.
- **FR-002**: The system MUST support multiple provider accounts, and a project MUST be bound to a specific account rather than to a globally configured one.
- **FR-003**: The system MUST default a project's ticket-key pattern from its bound ticket project's key, and MUST allow the operator to override it.
- **FR-004**: The documentation URL MUST be stored and rendered as a link only — never authenticated against, called, or polled.
- **FR-005**: Provider credentials MUST be stored in the operating system credential store. The system MUST NOT write them to a configuration file, environment file, local database, log, or crash record, and MUST NOT include them in any exported or copied diagnostic output.
- **FR-006**: If the credential store is unavailable, the system MUST report that clearly and MUST NOT fall back to any other storage location.
- **FR-007**: The system MUST allow a connection to be tested, re-authorized, and removed, and removal MUST delete the stored credential.
- **FR-008**: The system MUST send no telemetry, analytics, crash reports, or usage data anywhere, and MUST make no network request to any host other than the operator's configured providers.

### Acquisition and freshness

- **FR-009**: The system MUST acquire data by polling on a schedule, per provider, and MUST NOT require any inbound network connection, webhook, tunnel, or listening port reachable from outside the machine.
- **FR-010**: Poll intervals MUST be configurable per provider, defaulting to 60 seconds for the code host and 5 minutes for the ticket tracker.
- **FR-011**: The system MUST record, per connection and per resource kind, when data was last successfully refreshed and when a refresh last failed, and MUST treat those as distinct facts.
- **FR-012**: Provider-derived data MUST NOT be displayed anywhere without its freshness being visible in the same view.
- **FR-013**: The system MUST visibly distinguish **stale** (last refresh succeeded, but a while ago) from **failed to refresh** (last attempt errored) from **never synced**.
- **FR-014**: The system MUST allow the operator to force an immediate refresh, globally or for one provider.
- **FR-015**: When rate-limited, the system MUST back off, MUST show when the next attempt will occur, and MUST NOT retry in a tight loop.
- **FR-016**: The system MUST read local git state — current branch, uncommitted changes, unpushed commits, and the worktree list — from configured checkouts.
- **FR-017**: The system MUST NOT modify the operator's working tree, index, stash, refs, or configuration, and MUST NOT run any git operation that contacts the network. Local git is read-only in every sense.
- **FR-018**: Ahead/behind counts MUST be derived from the code host's view of the branch, not from a local network fetch. For a branch the code host has never seen, ahead/behind MUST be reported as unknown rather than zero.

### Correlation

- **FR-019**: The system MUST join tickets, workspaces (repository + worktree + branch), pull requests, commits, and CI results into **work items**, keyed on the ticket where one exists and on the workspace where one does not.
- **FR-020**: All relations within a work item MUST be many-to-many: a work item MUST support multiple branches, multiple PRs, and multiple CI results without fragmenting into several items.
- **FR-021**: The system MUST associate a branch or PR with a ticket by matching a ticket key in the branch name, PR title, or PR body, in that order of precedence.
- **FR-022**: A ticket key that matches no ticket in any bound project MUST produce a drift finding and MUST NOT produce a work item.
- **FR-023**: The system MUST model worktrees as part of a workspace even though a worktree is not itself a click target.
- **FR-024**: Correlation MUST be deterministic: identical inputs MUST produce identical work items, findings, and identifiers.
- **FR-025**: Correlation MUST be executable and testable without a desktop shell, a display, or a network connection, against recorded provider fixtures.

### Activity, staleness, and severity

- **FR-026**: The system MUST compute, per work item, the time since the last **real activity**, defined as a state change made by a human or an agent: commits, pushes, human review submissions and review comments, ticket status transitions, assignment changes, non-automated comments, PR open/close/merge, and CI result transitions.
- **FR-027**: Automation noise MUST NOT reset the staleness clock: bot comments, label changes, field touches by automation, and CI re-runs that produce an unchanged result.
- **FR-028**: Every row MUST display a staleness gauge derived from time since last real activity, banded on absolute time: under 4 hours, under 24 hours, under 72 hours, under 7 days, and beyond 7 days.
- **FR-029**: The system MUST assign each row a severity of good, warning, serious, or critical, computed as the highest severity produced by any of the following contributions:

  | Contribution | warning | serious | critical |
  |---|---|---|---|
  | Drift | — | participates in an unresolved drift finding | — |
  | Ticket state | awaiting another party (in review) | — | blocked status |
  | PR state | draft, or awaiting review | changes requested | required checks failing |
  | Workspace state | uncommitted changes with a live agent session | uncommitted changes with no live session | branch or worktree no longer exists at the code host |
  | Session state | question outstanding for the operator | silent (missed heartbeat) | — |
  | Staleness | ≥ 1× the lane threshold | ≥ 2× the lane threshold | ≥ 3× the lane threshold |

- **FR-030**: Lane thresholds MUST default to 3 days for tickets and 24 hours for pull requests and branches, and MUST be configurable.
- **FR-031**: Severity MUST be correlation output, not a presentation choice: the same inputs MUST yield the same severity regardless of where it is rendered.
- **FR-032**: The system MUST resolve **ball-in-court** for each work item to the operator, another person, or an agent, using: an outstanding question for the operator, or a PR the operator authored with changes requested or failing checks, or a review requested of the operator, or a ticket assigned to the operator in an actionable status → the operator; awaiting someone else's review or assigned to another person → them; a live agent session owning the workspace with nothing pending from a human → the agent.
- **FR-033**: "The operator" MUST be resolved per account from each provider's notion of the authenticated user. The system MUST NOT attempt to unify a human identity across accounts.

### Drift detection

- **FR-034**: The system MUST evaluate a defined set of drift rules on every correlation pass and produce findings that each carry: a stable identifier, the subject work item, both sides of the evidence with their timestamps, the age of the disagreement, and a suggested resolution.
- **FR-035**: The v1 rule set MUST include, at minimum:

  | # | Condition | Suggested resolution |
  |---|---|---|
  | D1 | Ticket is in a non-terminal status and its only PR merged more than the grace period ago | Move ticket to its terminal status |
  | D2 | Ticket is in a backlog status while a branch, PR, or agent session for it is active | Move ticket to in-progress |
  | D3 | Ticket is in an in-progress status with no branch, no PR, and no session, past the lane threshold | Investigate: no work found |
  | D4 | Ticket is in a terminal status while its PR is still open | Reopen the ticket or close the PR |
  | D5 | PR is merged while a local workspace for that branch still holds uncommitted or unpushed work | Clean up the workspace |
  | D6 | A branch or PR carries a ticket key that exists in no bound project | Correct the key or bind the project |
  | D7 | An agent session has run past the session threshold with no ticket transition | Check the session |
  | D8 | Ticket is in review while its PR has no reviewer requested | Request a review |
  | D9 | A PR or branch exists with no ticket key at all | Link it to a ticket |

- **FR-036**: The grace period before D1 fires MUST default to 24 hours and MUST be configurable.
- **FR-037**: A finding MUST clear automatically when the underlying evidence no longer satisfies its rule.
- **FR-038**: The operator MUST be able to dismiss a finding; a dismissal MUST persist across restarts and MUST expire when the underlying evidence changes.
- **FR-039**: Finding identifiers MUST be stable across restarts and resyncs so that dismissals and notes survive.

### Agent sessions

- **FR-040**: Agents MUST be able to report session start, heartbeat, status change, and session end through the agent interface, and the system MUST record sessions as local authored data — never as a provider write.
- **FR-041**: A session MUST be associable with a work item, a project, and a workspace.
- **FR-042**: A session that misses its heartbeat window MUST be shown as **silent**, with time since last contact; the window MUST default to three missed intervals and be configurable.
- **FR-043**: A heartbeat arriving after silence MUST return the session to running without creating a duplicate.
- **FR-044**: A session start for an already-known session identifier MUST be treated as a resumption.
- **FR-045**: Reported timestamps in the future MUST be clamped to receipt time.
- **FR-046**: Sessions MUST survive restarts, with liveness re-evaluated from the heartbeat rule rather than assumed.
- **FR-047**: Sessions MUST contribute to lane counts, headline counts, and ball-in-court on equal footing with tickets and PRs.
- **FR-048**: A session has no provider page; the system MUST NOT fabricate a URL for one.

### Notes

- **FR-049**: Notes MUST support the types decision, gotcha, question-for-human, and to-do, and MUST be attachable to a ticket, a PR, or a branch.
- **FR-050**: Notes MUST attach to a stable natural key for their subject — never to a mirrored row identifier — and MUST re-attach if that key reappears.
- **FR-051**: Notes MUST be stored separately from mirrored provider data, and MUST survive a full discard and rebuild of the mirrored cache.
- **FR-052**: Every row carrying notes MUST show a count; activating it MUST open a modal to read, add, edit, and delete notes for that subject.
- **FR-053**: Notes of type question-for-human MUST additionally surface in Attention and MUST drive their work item's ball-in-court to the operator.
- **FR-054**: Notes MUST be readable and writable by both the operator and agents.
- **FR-055**: Each note MUST carry a revision. A write against a stale revision MUST be rejected and the conflict surfaced to the writer; the system MUST NOT silently overwrite or auto-merge.
- **FR-056**: A note whose subject no longer exists at the provider MUST be retained and shown as orphaned.

### Action outbox and dispatch

- **FR-057**: The system's own credentials MUST be read-only against providers. No part of the system may call a provider write endpoint — create, modify, transition, comment, or delete — using the operator's stored credentials.
- **FR-058**: The system MUST provide a durable **action outbox**. An action MUST record its subject, requested change, the finding or row that motivated it, its state, and its full history.
- **FR-059**: An action MUST be individually confirmed by the operator before entering the outbox. Bulk or blanket pre-authorization MUST NOT be offered.
- **FR-060**: The system MUST NOT create or dispatch an action as a side effect of a sync, a drift rule firing, a timer, or any other automatic trigger.
- **FR-061**: Agents MUST be able to list pending actions, claim one, and report completion or failure through the agent interface.
- **FR-062**: A claim MUST be exclusive; a second agent MUST NOT be able to claim a claimed action.
- **FR-063**: A claim that is not completed within its window MUST return the action to pending.
- **FR-064**: The outbox MUST be durable across restarts, so that an action raised while no agent is connected is claimable later.
- **FR-065**: Connected agents MAY additionally be notified that work is pending, as an accelerator only. Correct behaviour MUST NOT depend on that notification arriving.
- **FR-066**: The board MUST show each action's state — pending, claimed, complete, failed, expired, cancelled — and, when nothing is listening, MUST say so rather than implying delivery.
- **FR-067**: The operator MUST be able to cancel a pending action.
- **FR-068**: The effect of a completed action MUST reach the board only through the normal read path on the next sync.

### The board

- **FR-069**: The system MUST present a single page containing: headline counts, an Attention region, lanes for tickets, pull requests, and open branches, a lane for agent sessions, and a ball-in-court panel.
- **FR-070**: Project selection MUST be a filter on that single page, not navigation to another page. Selecting exactly one project MUST additionally render that project's ticket-project, repository, and documentation links.
- **FR-071**: Each lane MUST show its own count, its threshold, and an explicit empty state.
- **FR-072**: The Attention region MUST show drift findings and question-for-human nudges, each with its age and its action.
- **FR-073**: Headline counts MUST cover: items in the operator's court, items drifting, items stalled past the threshold, and live agent sessions. The operator's-court count MUST act as a filter toggle.
- **FR-074**: Status MUST be conveyed by shape and text label in addition to colour, so that it survives greyscale and colour-vision deficiency.

  > **⚠ Departed from on the ticket lane, 2026-08-20, by the operator's
  > decision.** The severity mark was removed from the ticket row to give the
  > summary column more width. `data-severity` on the row is now the only carrier
  > and it is a colour, which is what this requirement forbids. It was raised
  > before the change was made, and asked for again after.
  >
  > **The scope is the ticket row only.** `StatusMark` is unchanged and still
  > drawn by the stat tiles and the session lane, and the correlation badges are
  > a separate alphabet that still obeys this rule.
  >
  > Three end-to-end tests went with it. They could not be repointed at another
  > surface, and that was checked rather than assumed: the tiles can only produce
  > `good` or `serious`, and a session's state maps only to `good`, `serious` or
  > `critical`, so **nothing on the board can produce a `warning` mark any more**
  > — and "all four shapes differ" has no way to put four shapes on a screen.
  > `greyscale.spec.ts` carries the note and the instruction to restore them from
  > history if the mark ever returns.
- **FR-075**: Every row representing a provider object MUST open that object at its provider in the default browser: tickets to the ticket page, PRs to the PR page, CI results to the run, branches to the code host's branch view, repositories to the repository, documentation to its stored URL.
- **FR-076**: A branch with no page at the code host MUST fall back to the repository page.
- **FR-077**: The system MUST open external links only over `https`, and MUST refuse any other scheme regardless of what a provider returned.
- **FR-078**: The system MUST offer light and dark appearance with a system-following default and an explicit override.
- **FR-079**: The system MUST offer a comfortable and a compact row density.
- **FR-080**: Beyond the defined project colours, additional projects MUST fall back to a neutral chip that carries only the project's short code.
- **FR-081**: A failure in one lane MUST NOT prevent the other lanes from rendering.

### Persistence

- **FR-082**: The system MUST persist across restarts: configured projects and accounts, poll intervals and thresholds, window geometry, appearance and density, the active project filter and court filter, per-connection freshness records, notes, sessions, outbox actions, and dismissed findings.
- **FR-083**: Mirrored provider data and authored data MUST be stored separately, and discarding the mirror MUST NOT touch authored data.
- **FR-084**: The system MUST be able to rebuild the mirror from the providers without operator intervention beyond a refresh.
- **FR-085**: All application data MUST live on the local machine. The system MUST NOT synchronise state to any remote service.

### Platform

- **FR-086**: The system MUST run on Windows, macOS, and Linux, with Windows treated as a first-class target — paths, path separators, line endings, credential store, and default browser launch MUST be correct there, not merely tolerated.
- **FR-087**: The system MUST behave correctly for repositories located on paths containing spaces and non-ASCII characters.

---

### Key Entities

- **Account** — an authenticated connection to one provider instance, with the identity of the authenticated user and its own freshness and rate-limit state.
- **Project** — the operator's unit of organisation: one ticket project, one repository, an optional documentation URL, a ticket-key pattern, and one or more local checkouts.
- **Workspace** — a repository plus a worktree plus a branch; the local half of the join. Carries dirty state, unpushed commits, and worktree presence.
- **Ticket** — a mirrored ticket: key, title, status, assignee, timestamps, and its activity history for staleness.
- **Pull Request** — a mirrored PR: number, title, author, state, review state, requested reviewers, head branch, and merge status.
- **Check Result** — a mirrored CI outcome for a commit or PR: state, name, and the run's page.
- **Commit** — the link between a workspace and a PR: identifier, author, timestamp.
- **Work Item** — the correlation output: one unit of work joining a ticket (where one exists), its workspaces, PRs, commits, check results, sessions, and notes; carries severity, staleness, and ball-in-court.
- **Drift Finding** — a detected disagreement: stable identifier, rule, subject work item, both sides of the evidence, age, suggested resolution, dismissal state.
- **Agent Session** — an agent's reported work: identifier, associated work item and workspace, reported status, start time, last heartbeat, last real activity, end time.
- **Note** — authored context: type, body, subject natural key, author (operator or agent), revision, timestamps.
- **Action** — an outbox entry: subject, requested change, motivating finding, state, claiming agent, claim expiry, result, full history.
- **Freshness Record** — per account and resource kind: last successful refresh, last failed refresh with reason, next scheduled attempt.
- **Settings** — appearance, density, poll intervals, lane thresholds, grace and heartbeat windows, active filters, window geometry.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With one project configured, a first-time operator can answer "what needs me right now" from the board alone, without opening any provider, within 10 seconds of the page rendering.
- **SC-002**: 100% of displayed provider-derived values carry a visible freshness indication in the same view; an audit of every rendered lane and panel finds no exceptions.
- **SC-003**: The correlation engine is exercised by a fixture suite covering at least 30 scenarios — including every drift rule, each rule's negative case, multi-PR tickets, unknown keys, unlinked work, and never-pushed branches — and produces the expected work items and findings for 100% of them, with no desktop shell, display, or network.
- **SC-004**: Correlation over identical inputs produces byte-identical output across 10 consecutive runs, including all identifiers.
- **SC-005**: With any one provider made unreachable, every lane not fed by that provider remains populated and interactive, and the affected lane states both the failure reason and the age of its last good data.
- **SC-006**: Every row type opens the correct provider page on first click, verified across all seven link targets (ticket, PR, check run, branch, repository, documentation, fallback-to-repository).
- **SC-007**: 100% of notes survive a full discard and rebuild of the mirrored cache, verified by attaching notes of every type to every subject type and comparing before and after.
- **SC-008**: An action confirmed while no agent is connected is claimable and completable by an agent that first connects after an application restart.
- **SC-009**: Static and dynamic inspection finds zero provider write calls made with the operator's stored credentials, and zero code paths that create an outbox entry without an explicit operator confirmation.
- **SC-010**: A network capture over a 30-minute session shows requests to configured provider hosts only — no telemetry, analytics, crash-reporting, or update-check destination.
- **SC-011**: A filesystem search of the application's data directory, configuration, and logs after a full session finds zero occurrences of any credential value.
- **SC-012**: The full test suite and the golden path pass on Windows, macOS, and Linux, with no platform-conditional expectations in the correlation tests.
- **SC-013**: On a board of 200 work items across 6 projects, applying a project filter updates the page within 100 ms.
- **SC-014**: A session going silent is reflected on the board within one heartbeat interval of the miss.
- **SC-015**: Status is legible in greyscale: every severity is distinguishable by shape and label alone, verified by rendering the board desaturated.

---

## Assumptions

Reasonable defaults chosen where the inputs did not specify. Correct any of these and the spec changes.

1. **Providers.** Ticket data comes from Jira Cloud and code/CI data from GitHub, per the locked decisions. The design mock uses Linear URLs for ticket links; that is a mock artifact, and v1 links to Jira.
2. **Single operator.** One human uses one installation. There is no sharing, no multi-user access control, and no server component.
3. **Agent interface.** Agents reach the system through a locally-hosted tool interface (MCP) exposed by the application, which is also how sessions, notes, and outbox claims travel. Correctness never depends on an agent being connected.
4. **Severity is rule-derived, not copied from the mock.** The sample severities in the design files are illustrative; the rule table in FR-029 governs.
5. **Terminal, backlog, in-progress, and in-review statuses** are derived from the ticket provider's status categories, with an operator override per project, rather than hard-coded status names.
6. **Note conflicts are rejected, not merged.** Revision-based rejection is the v1 behaviour; no three-way merge, no last-write-wins.
7. **Dismissed findings expire on evidence change**, where evidence means the timestamps and states named in the finding — not merely a new sync.
8. **Documentation links are inert.** Confluence or otherwise, a URL only.
9. **Nothing is ever deleted at a provider by this application**, whether by its own credentials or by dispatch — the v1 rule set proposes transitions, reviews, and cleanup, never deletion.
10. **Ahead/behind costs a comparison call per tracked branch** against the code host's rate limit; that cost is accepted in exchange for never touching local git over the network.
11. **The modal is a new component.** The design system has no dialog primitive; one must be built to its tokens.
12. **The row's fixed slots are fully allocated**, so adding a note count displaces an existing element; which one is a design call at plan time.
13. **First-run experience is configuration, not import.** There is no discovery of projects from an account; the operator states the bindings.
14. **Out of scope for v1**: any provider write with the app's own credentials, webhooks, mobile or web deployment, multi-user or team features, historical analytics and trend reporting, ticket or PR authoring, and documentation-provider integration beyond a stored link.
