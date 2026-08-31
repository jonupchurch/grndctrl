import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { ConnectionNotice } from './components/ConnectionNotice.js'
import { NoProjects } from './components/EmptyState.js'
import { NotesModal } from './components/NotesModal.js'
import { StatTiles } from './components/StatTiles.js'
import { filterHistory, filterSessions, filterWork, summarise, useFilter } from './filter.js'
import { RegionsProvider, useRegionState } from './regions.js'
import { Tickets, type NotesAccess } from './lanes/Lanes.js'
import { LaneBoundary } from './lanes/LaneBoundary.js'
import { ActiveTicket, type ActiveTicketView } from './panels/ActiveTicket.js'
import { TicketHistory } from './panels/TicketHistory.js'
import { call } from './bridge.js'
import { useOperation, usePushInvalidation, worstFreshness, type Envelope } from './query.js'
import { Settings } from './settings/Settings.js'
import { Titlebar } from './Titlebar.js'
import type { AgentSession, Note, Project, TicketHistoryEntry, WorkItem } from './types.js'

/**
 * One page (T137).
 *
 * Everything the operator needs is here at once — the three tiles, the ticket
 * lane, what is being worked, and what has been recorded about work that is
 * done. There is no navigation and no second screen, because the value of this
 * application is entirely in the *relationships between* the systems it reads,
 * and a relationship you have to navigate to see is one you will not see.
 *
 * **The board is narrower than it has been, twice over.** 006 took the pull
 * request lane, the branch lane and the Attention region off it; 007 filled the
 * space with an agent console — sessions, ball-in-court, an update stream and a
 * prompt shelf — and on **2026-08-31 the operator removed all four of those**,
 * leaving one column at the full width of the window. What went with them is
 * recorded where each read used to be, rather than only in the git history:
 * three regions were the only place a session's reported status, an agent's
 * running commentary and a recorded prompt were shown.
 *
 * Two structural decisions:
 *
 * **Each lane has its own error boundary** (T141, XV). Without one, a single
 * malformed ticket unmounts the whole tree and the operator's board goes white
 * because Jira returned something odd. Every boundary that remains is still one
 * per region — the count has only ever fallen because regions left, never
 * because a surviving region gave one up.
 *
 * **Every lane narrows from one snapshot.** The reads happen here and the
 * filtering happens in `filter.ts`, so the number in a tile and the length of
 * the list beneath it cannot disagree — which they would if each lane fetched
 * its own filtered copy.
 */

export function App(): ReactElement {
  usePushInvalidation()
  const client = useQueryClient()
  const [syncing, setSyncing] = useState(false)
  // The one view that is not the board. Not navigation in FR-070's sense —
  // that rule is about project *selection*, which stays a filter. This is
  // configuration, which has to live somewhere and is not part of the board.
  const [showSettings, setShowSettings] = useState(false)
  /** The subject whose notes are open, with the label the row showed. */
  const [notesFor, setNotesFor] = useState<{ key: string; label: string } | null>(null)

  const projects = useOperation<Project[]>('projects.list')
  const work = useOperation<Envelope<WorkItem[]>>('work.list')
  const sessions = useOperation<AgentSession[]>('sessions.list')
  /**
   * Open questions from agents.
   *
   * **This read is not Attention's, and taking it out along with Attention is
   * the mistake this comment exists to have prevented** (FR-121). Two other
   * things depend on it and neither is going: the asking set below puts the
   * question mark on a row's note badge, and core's ball-in-court hands an item
   * to the operator when an agent is waiting on them.
   *
   * 007 gave the questions a *display* of their own in the agent update panel,
   * and that panel was removed on 2026-08-31. The badge is what is left: a row
   * with an unanswered question carries `?` in its trailing slot and opens the
   * note that asked it. **A question on a ticket that is not on the board can no
   * longer be seen** — that is the cost of the removal, and it is stated here
   * rather than left to be discovered.
   */
  const questions = useOperation<Note[]>('notes.questions')

  /**
   * The one ticket being worked (FR-127).
   *
   * Read here rather than inside the panel so that it and the ticket lane see
   * the same answer: the lane draws which row is active, the panel draws what it
   * is, and two reads of the same pointer would disagree for a frame every time
   * an agent moved it. Same rule as the note counts above — one snapshot, many
   * consumers.
   */
  const active = useOperation<ActiveTicketView | null>('focus.get')

  /*
   * `updates.list` and `prompts.list` were read here, for the agent update
   * stream (FR-132) and the prompt shelf (FR-136). **Both regions were removed
   * on 2026-08-31**, on the operator's instruction, along with the agent session
   * lane and ball-in-court — see the board below.
   *
   * The reads went with them rather than being left in place "for later". A
   * `useOperation` with no consumer is a poll nobody watches: it refetches on
   * every push, keeps its answer in the query cache, and shows up in the
   * performance budget as work the board does not use. The *operations* are
   * untouched — agents still record updates and prompts over MCP, and nothing
   * about the store changed — so putting a region back is a component and a
   * read, not a migration.
   */

  /**
   * The curated ticket history (008/FR-156).
   *
   * Read whole and filtered in the panel, with no `q` here. The search is the
   * operator typing, and a dispatch per keystroke would put a round trip inside
   * their own search — as well as generating a `history.list` per character,
   * which is the read-announces-a-change shape that produced a push loop once
   * already (`main/push.ts`).
   *
   * The limit is the operation's own ceiling rather than a page: this list has
   * no retention bound by design, so the one thing the interface must not do is
   * quietly show the newest few and read as complete.
   */
  const history = useOperation<TicketHistoryEntry[]>('history.list', { limit: 1000 })

  /**
   * Every subject a row could carry a badge for, in one call (T150).
   *
   * Taken from the **unfiltered** snapshot on purpose. Keying the query on the
   * filtered set would refetch every time the operator pressed a project chip,
   * for counts that had not changed — and would put the lanes' badges a frame
   * behind the rows they sit on while it did.
   */
  const subjectKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const item of work.data?.data ?? []) keys.add(item.ticket.key)
    // The operation caps at a thousand keys. A board past that has other
    // problems, but truncating silently would show empty badges on the tail and
    // read as "no notes" — so the slice is deliberate and the sort makes which
    // keys survive stable rather than dependent on iteration order.
    return [...keys].sort().slice(0, 1000)
  }, [work.data])

  // An empty list is a legal input and answers `{}`, so there is no enabled
  // flag here — a board with nothing on it asks a cheap question and gets a
  // cheap answer, rather than leaving the query in a permanent pending state
  // that the badges would have to distinguish from "no notes".
  const noteCounts = useOperation<Record<string, number>>('notes.counts', { subjectKeys })

  /**
   * The settings that belong to this screen rather than to the theme (T154).
   *
   * `ThemeProvider` reads the same row for appearance and density and does it
   * once, imperatively, because a theme must be applied before first paint. The
   * filter and the on-top toggle are ordinary state that changes while the app
   * is running, so they go through the query cache like everything else — which
   * is also what lets a write here invalidate and re-read in one place.
   */
  const settings = useOperation<{
    activeProjectId: string | null
    mineOnly: boolean
    alwaysOnTop: boolean
    collapsedRegions: Record<string, boolean>
  }>('settings.get')

  const writeSettings = useCallback(
    (patch: Record<string, unknown>) => {
      void call('settings.update', patch)
        .then(() => client.invalidateQueries({ queryKey: ['settings.get'] }))
        .catch(() => undefined)
    },
    [client],
  )

  const filter = useFilter(projects.data ?? [], {
    ...(settings.data === undefined
      ? {}
      : {
          saved: {
            activeProjectId: settings.data.activeProjectId,
            mineOnly: settings.data.mineOnly,
          },
        }),
    persist: writeSettings,
  })

  /**
   * Which regions are folded away (T102, T103).
   *
   * **The ids are literals, here and in each component that names one**:
   * `summary`, `connections`, `tickets`, `active-ticket`, `ticket-history`.
   * They are the keys of a stored preference, so a generated one would change
   * between builds and quietly unfold everything the operator had put away — and
   * would leave a dead key behind each time.
   *
   * `updates`, `prompts`, `sessions` and `court` were four more until
   * 2026-08-31. A stored map that still holds them is harmless and is left
   * alone: the map records only what is *collapsed*, nothing reads a key it has
   * no region for, and rewriting the operator's settings row to tidy up four
   * dead booleans is a migration with nothing to gain. There is no registry of them and there deliberately is
   * not: a region whose id is wrong shows up immediately as a fold that does not
   * survive a restart, and a list to keep in step is a second place to get it
   * wrong.
   */
  const regions = useRegionState({
    ...(settings.data === undefined ? {} : { saved: settings.data.collapsedRegions }),
    persist: writeSettings,
  })

  /**
   * Both directions of the pointer, from the row and from the panel.
   *
   * Nothing is invalidated here. `focus.set` and `focus.clear` are mutations, so
   * main's push wrapper announces `focus:changed` when either returns — on the
   * agent's path as well as this one — and `usePushInvalidation` refetches.
   * Invalidating here too would work and would leave two code paths producing
   * the same number, which is the thing `main/push.ts` exists to avoid.
   *
   * A failure is swallowed rather than surfaced, and that is a gap rather than a
   * decision: there is nowhere on this board to put a transient error yet. The
   * observable symptom is a control that does not take, which is at least not a
   * lie about what is active.
   */
  const clearActive = useCallback(() => {
    void call('focus.clear', {}).catch(() => undefined)
  }, [])

  /**
   * Curating the history: the operator's two operations (FR-154).
   *
   * These return promises where `deletePrompt` above swallows, and the
   * difference is that both of these can fail in a way the operator has to see.
   * A revise loses a revision race — that is the whole point of carrying one —
   * and the panel shows the refusal with their draft still in the box. Nothing
   * is invalidated here: both mutate, so main's push wrapper announces
   * `history:changed` and `usePushInvalidation` refetches, on the agent's path
   * as well as this one.
   */
  const reviseHistory = useCallback(
    async (request: {
      ticketKey: string
      revision: number
      line: string
      notes: string | null
    }) => {
      await call('history.revise', request)
    },
    [],
  )

  const deleteHistory = useCallback(async (request: { ticketKey: string; revision: number }) => {
    await call('history.delete', request)
  }, [])

  const refresh = useCallback(() => {
    setSyncing(true)
    // The push events do the invalidating (`query.ts`), so nothing is refetched
    // here. `finally` rather than `then`: a sync that failed has still finished,
    // and a button stuck on "Refreshing…" reads as "still working".
    void call('sync.now', {}).finally(() => setSyncing(false))
  }, [])

  if (projects.isError) {
    return (
      <main className="board">
        <p className="failed" role="alert">
          Ground Control could not reach its own service: {projects.error.message}
        </p>
      </main>
    )
  }

  if (projects.isPending) {
    return (
      <main className="board">
        <p className="muted">Starting…</p>
      </main>
    )
  }

  if (showSettings) return <Settings onClose={() => setShowSettings(false)} />

  const known = projects.data
  const items = filterWork(work.data?.data ?? [], filter)
  const live = filterSessions(sessions.data ?? [], filter)
  // Narrowed here rather than in the panel, with the rest of them, so the count
  // in the region header and the rows beneath it come from one snapshot.
  const pastWork = filterHistory(history.data ?? [], filter)
  const counts = summarise(items, live)
  // The lane reports its own resource, not the board-wide worst. The header
  // summarises only what is on screen — an envelope also carries freshness for
  // kinds nothing displays, and letting those decide put every lane into
  // "never synced" because `comparisons` had no row yet.
  //
  // Two names for one read, for now. They are two different claims — what this
  // lane knows, and what the whole board knows — and they coincide only because
  // there is one displayed resource kind left. 007 adds a second lane and the
  // header's set widens again; collapsing them here would have to be undone.
  const ticketFreshness = worstFreshness(work.data, 'tickets')
  const freshness = worstFreshness(work.data, 'tickets')

  /**
   * What the lanes need to draw and open notes (T150).
   *
   * `undefined` until the counts have arrived, which is what suppresses the
   * badges rather than rendering every row with a zero. A badge reading 0 is a
   * claim; an absent badge is not.
   *
   * The asking set is built from `notes.questions` — unfiltered, so a badge
   * appears on a row whose project is currently filtered out the moment the
   * filter widens again.
   */
  const notes: NotesAccess | undefined =
    noteCounts.data === undefined
      ? undefined
      : {
          counts: noteCounts.data,
          asking: new Set(
            (questions.data ?? []).flatMap((n) => (n.resolvedAt === null ? [n.subjectKey] : [])),
          ),
          open: (key, label) => setNotesFor({ key, label }),
        }

  return (
    <RegionsProvider value={regions}>
      <Titlebar
        projects={known}
        filter={filter}
        freshness={freshness}
        syncing={syncing}
        {...(settings.data === undefined
          ? {}
          : {
              alwaysOnTop: settings.data.alwaysOnTop,
              // Main applies it to the window by watching `settings.update` go
              // past — the renderer has no window handle and must not have one.
              onToggleAlwaysOnTop: () => writeSettings({ alwaysOnTop: !settings.data.alwaysOnTop }),
            })}
        onRefresh={refresh}
        onOpenSettings={() => setShowSettings(true)}
      />

      <main className="board">
        {known.length === 0 ? (
          <NoProjects />
        ) : (
          <>
            <StatTiles
              yourCourt={counts.yourCourt}
              stalled={counts.stalled}
              agentsLive={counts.agentsLive}
              totalSessions={live.length}
              mineOnly={filter.mineOnly}
              onToggleMine={filter.toggleMine}
            />

            {/* Above the tiles, because it is about whether the numbers in
                them can be trusted to be current — not about any one item. */}
            <LaneBoundary lane="Connections">
              <ConnectionNotice onOpenSettings={() => setShowSettings(true)} />
            </LaneBoundary>

            {/*
              **One column, the full width of the window** (2026-08-31).

              It was a two-column grid: the work in a wide main track, context in
              a 400px rail holding the agent sessions, ball-in-court and the
              prompt shelf, with the agent update stream below the active ticket.
              The operator removed all four regions. What is left is the work,
              and a main column still sized as though a rail sat beside it would
              hold a quarter of the window empty for panels that are not coming
              back — so the regions take the width instead.

              The order is unchanged and still means what it did: what is on your
              plate, what is being worked right now, and — last, below the fold —
              what happened. Nothing moved column, because there is only one.
            */}
            <div className="board__stack">
              <LaneBoundary lane="Tickets">
                <Tickets items={items} projects={known} freshness={ticketFreshness} notes={notes} />
              </LaneBoundary>

              {/*
                T145 put a "no longer mine" lane here, between the tickets and
                the active ticket. **It was dropped on 2026-08-20**, by the
                operator, rather than shipped as an approximation: it needed
                JQL history operators verified against a real Jira and there
                was none to reach. Nothing was ever built, so nothing was
                removed from this file — this note exists so the next reader
                does not re-derive the lane from the specification and wonder
                where it went. See `specs/007-agent-console/spec.md`.
              */}

              <LaneBoundary lane="Active ticket">
                <ActiveTicket
                  active={active.data}
                  // The **unfiltered** snapshot. The active ticket is one
                  // pointer, not a lane: blanking it because the operator
                  // pressed a project chip would read as "nothing is active".
                  items={work.data?.data}
                  onClear={clearActive}
                />
              </LaneBoundary>

              {/*
                Last, and the only region on the board that is not about now.
                Everything above it answers "what is happening"; this answers
                "what happened", which is a question asked far less often and
                from further away — so it goes below the fold rather than
                competing with the work for the top of the screen.
              */}
              <LaneBoundary lane="Ticket history">
                <TicketHistory
                  // Narrowed by the project chips like every other list here
                  // (`filterHistory`), and **not** by the court toggle: a
                  // finished ticket is in nobody's court, so honouring it would
                  // empty the region every time the operator narrowed to their
                  // own work. The panel's search box narrows further, over what
                  // this hands it.
                  entries={pastWork}
                  onRevise={reviseHistory}
                  onDelete={deleteHistory}
                />
              </LaneBoundary>
            </div>
          </>
        )}
      </main>

      {/*
        The dialog lives here rather than inside the row that opens it. A
        `<dialog>` rendered from inside a lane would unmount the moment its row
        left the list — which happens on any sync that reorders the lane, and on
        every project chip press — closing itself mid-sentence with the
        operator's draft in it.
      */}
      {notesFor !== null && (
        <NotesModal
          subjectKey={notesFor.key}
          subjectLabel={notesFor.label}
          onClose={() => setNotesFor(null)}
        />
      )}
    </RegionsProvider>
  )
}
