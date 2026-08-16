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
behaviour that a tool works around. Three operations are marked `ui-only` and
are absent here on purpose — see [What agents cannot do](#what-agents-cannot-do).

### Reading the board

| Tool | What it answers |
| --- | --- |
| `grndctrl_get_board` | The whole board: work items, drift findings, dangling records |
| `grndctrl_list_work` | Work items, filtered |
| `grndctrl_get_work_item` | One item and everything correlated into it |
| `grndctrl_get_drift` | Drift findings, with the evidence for each |
| `grndctrl_get_freshness` | How current each connection is, per resource kind |
| `grndctrl_refresh` | Force a refresh now |
| `grndctrl_list_projects` | The operator's projects — a Jira key plus a repository each |
| `grndctrl_resolve_link` | The URL a row opens |

Use `grndctrl_resolve_link` rather than assembling a URL yourself. Provider data
is not trusted for this: the resolver refuses any scheme but `https`, and it
falls back to the repository — saying so — for a branch the host has never seen.
A hand-built URL is a guess that looks like a fact.

Every provider-derived reply carries a freshness envelope. **Read it.** A reply
is not a claim that the data is current — it is a claim about what the mirror
last saw, and it says when. An agent that acts on a `partial: true` board
without noticing is acting on a board with a provider missing from it.

### Notes

Notes are the shared channel between you and the operator. Typed, attached to a
subject (a ticket, a pull request, a branch), and readable and writable from
both sides.

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
- **`question-for-human`** — a blocker. It raises an Attention nudge on the
  board, and the operator's answer arrives as a reply on the same subject. This
  is how an agent asks something without stopping.
- **`todo`** — work you found and did not do.

**Updates take the revision you read.** If the operator edited the note in
between, the write is refused with `conflict` and the error carries the current
version, so the agent can merge rather than clobber. Do not retry with a fresh
read and the same body — that is the clobber, taking a longer route.

### Sessions

| Tool | |
| --- | --- |
| `grndctrl_start_session` | Announce yourself: agent, workspace, what you are doing |
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
`outbox.mintConfirmation` and `drift.dismiss` are `ui-only`, and a conformance
test fails the build if any of them appears on the MCP or HTTP surface.

**Write to Jira or GitHub.** Not through Ground Control. Its credentials are
read-only against the providers by construction — the provider interface has no
`transitionIssue`, no `createComment`, no `merge` to call. When you claim an
action, you perform it with **your own** credentials and tools, and report the
outcome back. Ground Control is the board and the record; it is not the hand.

**Touch the operator's working tree.** Every git command is on an allow-list and
every one is a read. Nothing fetches, nothing checks out, nothing commits.

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
