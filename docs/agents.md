# Agents

Ground Control exposes its board to coding agents over MCP. This is what the
surface is, what it deliberately is not, and the two contracts an agent has to
honour to behave well.

## Connecting

```json
{
  "mcpServers": {
    "grndctrl": {
      "command": "npx",
      "args": ["-y", "grndctrl-mcp"]
    }
  }
}
```

The app must be running. `grndctrl-mcp` is a thin adapter — it holds no
database and no credentials — and finds the app through a handshake file in the
data directory carrying the loopback port and a bearer token. The file is
created readable only by your user account, and it is deleted when the app
stops: a stale handshake would send the server to a port some other process now
owns.

If the app is not running, every tool fails saying so. That is the intended
answer; there is no headless mode that quietly opens the databases behind a
running app's back.

---

## The shape of the surface

**Everything an agent can do is an operation in one registry**, the same
registry the window uses. There is no MCP-only behaviour and no UI-only
behaviour that a tool works around. Some operations are marked `ui-only` and are
absent here on purpose — see [What agents cannot do](#what-agents-cannot-do).

### Reading the board

| Tool | What it answers |
| --- | --- |
| `grndctrl_get_board` | The whole board: work items, the counts, freshness |
| `grndctrl_list_work` | Work items, filtered |
| `grndctrl_get_work_item` | One item and everything correlated into it |
| `grndctrl_get_freshness` | How current each connection is, per resource kind |
| `grndctrl_refresh` | Force a refresh now |
| `grndctrl_list_projects` | The operator's projects — a Jira project key each |
| `grndctrl_resolve_link` | The URL a row opens |

`grndctrl_get_drift` was here until 0.4.0, with the nine rules behind it. Drift
compared a ticket against a code host and a checkout, and with one provider there
is no second system left to disagree with. The operations are gone rather than
returning an empty list — a tool that always answers "nothing" is a claim this
application is no longer entitled to make.

Use `grndctrl_resolve_link` rather than assembling a URL yourself. Provider data
is not trusted for this: the resolver refuses any scheme but `https`. Four of its
seven targets went with the code host, and a removed target is an explicit error
rather than a silent fallback. A hand-built URL is a guess that looks like a
fact.

Every provider-derived reply carries a freshness envelope. **Read it.** A reply
is not a claim that the data is current — it is a claim about what the mirror
last saw, and it says when. An agent that acts on a `partial: true` board
without noticing is acting on a board with a provider missing from it.

### Notes

Notes are the shared channel between you and the operator. Typed, attached to a
subject (a ticket or an agent session), and readable and writable from both
sides.

A note written before 0.4.0 against a pull request, a branch or a checkout is
still listed and still editable. Those subjects have no rows behind them any
more, so such a note reads as orphaned — which is what it is, and is better than
deleting something a person wrote.

| Tool | |
| --- | --- |
| `grndctrl_list_notes` | Notes on a subject |
| `grndctrl_list_questions` | Open `question-for-human` notes, across everything |
| `grndctrl_count_notes` | Counts, for deciding what to open |
| `grndctrl_add_note` | Write one |
| `grndctrl_update_note` | Edit one — **requires the revision you read** |
| `grndctrl_delete_note` | Remove one |

The four types earn their keep:

- **`decision`** — what was chosen and why. The thing that is otherwise lost
  when a session ends.
- **`gotcha`** — the trap you hit, so the next session does not.
- **`question-for-human`** — a blocker. It moves the work item's ball-in-court to
  the operator and puts the session into `needs-you`, and their answer arrives as
  a reply on the same subject. This is how an agent asks something without
  stopping. **The dedicated place these are listed is not on the board today**:
  the Attention region that showed them went with drift in 0.4.0 and the agent
  console restores it. Until then the signal reaches the operator through the
  row, not through a list of questions.
- **`todo`** — work you found and did not do.

**Updates take the revision you read.** If the operator edited the note in
between, the write is refused with `conflict` and the error carries the current
version, so the agent can merge rather than clobber. Do not retry with a fresh
read and the same body — that is the clobber, taking a longer route.

### The active ticket

One ticket at a time, shown to the operator in its own panel on the board. Set it
when you pick work up; clear it when you are done.

| Tool | |
| --- | --- |
| `grndctrl_set_active_ticket` | Declare which ticket you are working |
| `grndctrl_get_active_ticket` | What is being worked, and who set it |
| `grndctrl_clear_active_ticket` | Put it down |

**This is a pointer, not a claim on the work.** Setting it does not start a
session, does not assign the ticket to anyone, and does not touch Jira — it
changes one local value the operator's board reads. Two agents setting it in turn
is not a conflict, it is the second one winning, and the panel shows who set it
so the operator can tell. Use `grndctrl_start_session` to say *you* are working;
use this to say *what* is being worked.

**Read it before you choose your own work.** If something is already active it is
almost certainly the thing to be on.

**A key that has not synced is fine.** Only the shape is checked. The board shows
the key and says plainly that it has no summary or status for it, rather than
going and fetching one — a pointer you set must not become a network request
the operator did not ask for.

**The description comes with the ticket.** `grndctrl_get_work_item` and
`grndctrl_list_work` carry `ticket.description` already converted out of
Atlassian Document Format <E> a small node tree of paragraphs, headings, lists,
code blocks, quotes, rules, tables, mentions and links, with `unsupported` nodes
naming anything Ground Control does not render. There is no separate call for it
and no ADF anywhere on this surface.

`null` means no description has reached the mirror; `[]` means the tracker says
there is none. They are different facts and are worth telling apart before
concluding a ticket has no acceptance criteria.

Links inside a description arrive as an `href` on a text node's marks. They are
the provider's own strings and are not resolved or checked on this surface —
use `grndctrl_resolve_link` for anything you intend to open, exactly as with
every other URL here.

**Clear it when the work ends.** A stale active ticket is worse than an empty
panel: the operator reads that panel as "this is happening now".

### Saying something

| Tool | |
| --- | --- |
| `grndctrl_post_update` | Tell the operator something worth reading |
| `grndctrl_list_updates` | What agents have said, newest first |

**There are now four things in this neighbourhood and they are not
interchangeable.** Getting this wrong is the difference between a board that is
useful to watch and one nobody looks at:

- **`grndctrl_heartbeat`** — "the process is alive". On a timer. Says nothing
  about work.
- **`grndctrl_report_activity`** — "work happened". Advances the activity clock,
  which is what stops a stuck agent looking busy. Machine-facing: it moves a
  colour.
- **`reportedStatus`** on your session — "what I am doing", one line,
  **overwritten** each time. The current state, not a record.
- **`grndctrl_post_update`** — "here is something worth reading". Appended,
  kept, shown as a stream.

The distinction that decides it: **a status is replaced and an update is added.**
Post an update when there is news — a decision made, a surprise found, a
direction changed — not on a timer. An agent that posts every thirty seconds has
written a log nobody asked for; an agent that only overwrites its status has left
the operator with the last thing it said and no idea it said anything else.

**Who posted it is taken from the session**, not from your payload, so you cannot
post as another agent. **The ticket is captured too** — whatever was active when
you posted — and it stays that ticket afterwards, so an update is not
re-attributed when the operator moves on.

Updates are **append-only**. There is no edit and no delete. Said something
wrong? Say something else; the operator is reading a history.

Each session keeps its most recent 50, pruned as each one is written.

### Sessions

| Tool | |
| --- | --- |
| `grndctrl_start_session` | Announce yourself: agent, work item, what you are doing |
| `grndctrl_heartbeat` | Say you are alive |
| `grndctrl_report_activity` | Say what changed |
| `grndctrl_end_session` | Say you are done |
| `grndctrl_list_sessions` | Who else is working |

**Heartbeat or you are dead.** A session that misses its interval by the
configured multiple is treated as gone — not as running-but-quiet. This is
deliberate: a crashed agent cannot report its own crash, and a board that shows
a dead agent as "working" makes the operator wait for something that will never
arrive. Heartbeat at least as often as the interval says; ending cleanly is
better than being timed out.

### The action outbox

The operator confirms an action. An agent claims it, does it, and reports back.

| Tool | |
| --- | --- |
| `grndctrl_pending_actions` | Confirmed actions nobody has claimed |
| `grndctrl_list_actions` | Everything in the queue, with state |
| `grndctrl_claim_action` | Take one. Exclusive — a second claim fails |
| `grndctrl_complete_action` | Done, with what happened |
| `grndctrl_fail_action` | Could not, with why |

`grndctrl://outbox/pending` is a subscribable resource that fires when the queue
changes.

---

## The polling contract, and why there is no push

**The queue is the contract. The notification is an accelerator.**

MCP transport is client-initiated. An agent that is not connected when the
operator confirms an action will not be told about it, ever — so the outbox is a
durable table rather than a message, and it survives both sides restarting.

That gives one rule: **poll `grndctrl_pending_actions` when you start, and after
any gap.** An agent that only acts on the resource notification misses every
action confirmed while it was offline, and the failure is silent — the queue
looks empty because nobody looked.

The notification exists to turn "up to a minute late" into "a few seconds late"
for an agent that is already connected. Nothing should be load-bearing on it.

The same reasoning applies to the board: there is no "tell me when a ticket
changes". Freshness is on every reply, `grndctrl_get_freshness` gives it
directly, and the refresh cadence is the operator's setting rather than yours.

---

## What agents cannot do

These are structural, not policy. The operations do not exist on this surface.

**Enqueue an action.** There is no `grndctrl_enqueue_action`, and there must
never be one. The outbox exists so that a *human* decides an action is worth
taking; an agent that could fill its own queue and then claim from it would have
turned a confirmation step into a loop with no person in it. `outbox.enqueue`,
`outbox.mintConfirmation` and `outbox.cancel` are `ui-only`, and a conformance
test fails the build if any of them appears on the MCP or HTTP surface.

**One thing worth saying plainly about the queue in 0.4.0**: nothing in the
interface can put anything into it. The only route from a screen to the outbox
ran through a drift finding's suggested action, and that route left with drift.
The queue, its durability and the claim protocol are all still here and still
tested — the operator's half of the handshake is what is missing, and it comes
back with the agent console.

**Write to Jira.** Not through Ground Control. Its credentials are read-only
against the provider by construction — the provider interface has no
`transitionIssue` and no `createComment` to call. When you claim an action, you
perform it with **your own** credentials and tools, and report the outcome back.
Ground Control is the board and the record; it is not the hand.

**Touch the operator's disk.** There is no local git reader any more and no
checkout binding to point one at. The application spawns no child process at
all, and a test fails the build if one appears in it.

---

## Behaving well

A short list, in the order the mistakes actually happen:

1. **Start a session and heartbeat.** An agent working invisibly is an agent the
   operator's ball-in-court is wrong about.
2. **Poll pending actions at start-up**, not just on notification.
3. **Read the freshness envelope** before treating a board as current, and
   before concluding a lane is empty. `partial: true` means a provider is
   missing, not that there is no work.
4. **Send the revision on a note update**, and merge on `conflict` rather than
   re-reading and overwriting.
5. **Ask with `question-for-human`** rather than guessing and writing a
   `decision`. The first raises a nudge the operator will see; the second is a
   guess that now looks like a record.
6. **Write the `gotcha` before you forget it.** It is the note type with the
   highest value per character and the one that never gets written, because by
   the time the work is finished it feels obvious.
