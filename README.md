# Ground Control

A local-first command station for the work you are actually holding. It
correlates your Jira tickets, your GitHub pull requests and CI, the git
checkouts on your disk, and the AI agent sessions running against them — and
tells you where they disagree.

Not a dashboard. A dashboard shows you numbers. This shows you the ticket that
says "In Progress" over a pull request that merged four days ago, and whose turn
it is.

---

## What it does

**Correlates.** A ticket, the branch someone cut for it, the pull request that
branch opened, the commits on it, and the checks that ran — joined into one work
item, on evidence rather than on naming conventions alone.

**Notices drift.** A merged pull request under an open ticket. A branch three
weeks stale with unpushed commits. A pull request waiting on a review that never
came. Each finding says what it saw, so you can disagree with it.

**Says whose turn it is.** Every row carries a ball-in-court: you, a colleague,
CI, or an agent. The lanes sort by it, so the board answers "what is waiting on
me" without you reading it.

**Is honest about what it does not know.** Every lane shows how fresh it is, and
a provider that cannot be reached says so rather than rendering as empty. "No
open branches" and "could not read the checkout" are different sentences.

**Talks to your agents.** `grndctrl-mcp` gives a coding agent the same board you
see, plus a durable action queue: you confirm an action, an agent claims it and
reports back. The agent cannot enqueue its own work — see
[docs/agents.md](docs/agents.md).

## What it will not do

These are design constraints, not a roadmap.

- **It never writes to your providers.** Ground Control's credentials are
  read-only against Jira and GitHub by construction: there is no
  `transitionIssue`, no `createComment`, no `merge` in the provider interface to
  call. When a drift finding suggests an action, the app queues it for an agent
  with your confirmation; the app itself does not perform it.
- **It never touches your working tree.** No `git checkout`, no `git commit`, no
  `git fetch`. Every git command it runs is on an allow-list and every one of
  them is a read.
- **It never phones home.** No telemetry, no analytics, no crash reporting, no
  update check. See [Privacy](#privacy) for how that is checked rather than
  claimed.
- **Your credentials live in the OS keychain and nowhere else.** Not in a
  dotfile, not in an environment file, not in either database, not in a log.

---

## Install

```
npx grndctrl
```

The first run downloads the Electron runtime (about 100 MB), verifies its
checksum against the one published in the same GitHub release, and caches it per
machine. Later runs start straight away. Nothing is extracted before it
verifies.

Requires **Node 22 or newer**. On Linux it also needs `unzip`.

### Linux: one command, on some distributions

Chromium will not run without a sandbox, and it has two. The first uses a setuid
helper that must be owned by root — which an `npx` install cannot arrange,
because npm unpacks as you. The second, the user-namespace sandbox, needs no
root at all, and Ground Control falls back to it automatically and tells you it
has.

On **Ubuntu 24.04 and later** the fallback is disabled by default too, through
AppArmor. If both are unavailable Ground Control refuses to start and prints the
two ways out; the easier one is:

```
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

(add it to `/etc/sysctl.d/` to make it persist). The alternative, if you would
rather grant the stronger sandbox than relax a system setting, is to `chown
root:root` and `chmod 4755` the `chrome-sandbox` file — the refusal message
names the exact path.

**Ground Control will not start itself with the sandbox turned off.** The window
renders ticket and pull request titles fetched from the network, and the sandbox
is what stands between those and the rest of your machine. That is why this is a
refusal you have to answer rather than a warning it prints while carrying on.

### From a checkout

```
npm install
npm run build
npm run dev --workspace=@grndctrl/desktop
```

## First run

The window opens with nothing on it, because it has nothing yet. **Settings**
in the titlebar is where you connect it.

### 1. Connect Jira

You need an Atlassian API token — Atlassian account → Security → API tokens.

In **Settings → Connections**, add a Jira connection with your site
(`yourcompany.atlassian.net`), the email you sign in with, and the token. The
token goes to your OS keychain; the connection row stores a lookup handle.

### 2. Connect GitHub

A fine-grained personal access token with **read** access to the repositories
you care about. `Contents: Read`, `Pull requests: Read`, `Metadata: Read`,
`Checks: Read` are enough.

> If the repositories belong to an organisation, the token's **resource owner**
> must be that organisation, and an org owner has to approve it. A token owned
> by your personal account will authenticate happily and then see none of the
> org's repositories — which looks like an empty board rather than a permission
> problem.

### 3. Bind a project

In **Settings → Projects**, a project ties together:

- a **Jira project key** (`MERC`) and the pattern that finds its keys in branch
  names and pull request titles,
- a **repository** (`acme/mercury` — a browser URL works too),
- one or more **checkout paths** on this machine.

The checkout paths are what make the local half work. Without them the board
still shows tickets and pull requests; it just cannot tell you that the branch
is sitting on your disk with three unpushed commits.

### 4. Watch it fill in

It refreshes on its own — 60 seconds for GitHub, five minutes for Jira, both
adjustable in Settings. Refresh in the titlebar forces it.

## Connect an agent

Point your MCP client at the server; it finds the running app itself.

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

The app must be running: the MCP server reaches it over a loopback API whose
port and token are published in a file only your user account can read. Nothing
listens on an external interface.

Full tool list, the polling contract, and why there is no push:
[docs/agents.md](docs/agents.md).

## Privacy

Three promises, and the script that checks each one rather than asserting it:

| Promise | Check |
| --- | --- |
| No credential is written anywhere but the keychain | `node --experimental-strip-types scripts/run-audits.ts secrets --secret <a token you have stored> --identity <your jira email>` |
| Nothing in the shipped dependency tree reports usage, crashes or updates | `node --experimental-strip-types scripts/run-audits.ts deps` |
| A session reaches your providers and nothing else | see below |

The egress audit needs a recorded session, because a static scan cannot see a
URL assembled at runtime:

```
GRNDCTRL_EGRESS_LOG=/tmp/egress.txt \
NODE_OPTIONS="--require ./scripts/egress-recorder.cjs" \
npm run dev --workspace=@grndctrl/desktop
# use the app, then:
node --experimental-strip-types scripts/run-audits.ts egress --log /tmp/egress.txt
```

The secret audit searches your whole data directory — both databases, their
write-ahead logs, and everything Chromium stores — for the credential in several
encodings, including the base64 form a Jira `Authorization: Basic` header would
leave behind. **Zero hits is the only pass.** It never prints the value it is
looking for.

## Where things are

| | |
| --- | --- |
| Your data | `%LOCALAPPDATA%\grndctrl` · `~/Library/Application Support/grndctrl` · `~/.local/share/grndctrl` |
| The Electron runtime cache | `%LOCALAPPDATA%\grndctrl\runtime` · `~/Library/Caches/grndctrl/runtime` · `~/.cache/grndctrl/runtime` |
| Your credentials | The OS keychain. Never a file. |

`mirror.db` is a cache of what the providers said and is safe to delete — it
rebuilds. `authored.db` holds what **you** wrote: notes, dismissals, the action
queue, settings. It is the one worth backing up, and nothing that syncs is
allowed to touch it.

Environment variables:

| | |
| --- | --- |
| `GRNDCTRL_DATA_DIR` | Use a different data directory. Scopes everything — a scratch board, or a second configuration. |
| `GRNDCTRL_RUNTIME_CACHE` | Put the downloaded runtime somewhere else. |
| `GRNDCTRL_DISPLAY` | Open on a particular monitor, 1-based. |

## Contributing

```
npm run verify        # typecheck, lint, unit tests
npm run test:e2e -w @grndctrl/desktop
```

The design gates this project is built under are in
[docs/constitution.md](docs/constitution.md) — Part I is process, Part II is the
product non-negotiables the tests actually enforce. Two are worth knowing before
you change anything:

- **The engine builds and tests with Electron uninstalled.** `packages/core` is
  the whole service layer; the shell, the loopback API and the MCP server are
  thin adapters over one operation registry. CI enforces this as its own job.
- **Every gate is deliberately made to fail before it is trusted.** If you add
  one, break it once and watch the test go red. If it does not, read the
  assertion before concluding the gate was unnecessary — on this project, a
  probe that does not fire has been the test's fault far more often than the
  code's.

Current state, open decisions and what is next: [STATUS.md](STATUS.md).

## Licence

MIT.
