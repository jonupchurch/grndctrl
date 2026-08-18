import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import { Attention } from './components/Attention.js'
import { BallInCourt } from './components/BallInCourt.js'
import { ConfirmAction } from './components/ConfirmAction.js'
import { ConnectionNotice } from './components/ConnectionNotice.js'
import { NoProjects } from './components/EmptyState.js'
import { NotesModal } from './components/NotesModal.js'
import { StatTiles } from './components/StatTiles.js'
import { filterFindings, filterSessions, filterWork, summarise, useFilter } from './filter.js'
import { Branches, PullRequests, Tickets, type NotesAccess } from './lanes/Lanes.js'
import { LaneBoundary } from './lanes/LaneBoundary.js'
import { Sessions } from './lanes/Sessions.js'
import { call } from './bridge.js'
import { useOperation, usePushInvalidation, worstFreshness, type Envelope } from './query.js'
import { Settings } from './settings/Settings.js'
import { Titlebar } from './Titlebar.js'
import type { AgentSession, DriftFinding, Note, Project, WorkItem } from './types.js'

/**
 * One page (T137).
 *
 * Everything the operator needs is here at once — tiles, Attention, three lanes,
 * agent sessions, and who is holding what up. There is no navigation and no
 * second screen, because the value of this application is entirely in the
 * *relationships between* the systems it reads, and a relationship you have to
 * navigate to see is one you will not see.
 *
 * Two structural decisions:
 *
 * **Each lane has its own error boundary** (T141, XV). Without one, a single
 * malformed pull request unmounts the whole tree and the operator's board goes
 * white because GitHub returned something odd.
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
  /** The finding being confirmed for dispatch. One at a time, deliberately. */
  const [confirming, setConfirming] = useState<DriftFinding | null>(null)

  const projects = useOperation<Project[]>('projects.list')
  const work = useOperation<Envelope<WorkItem[]>>('work.list')
  const drift = useOperation<Envelope<DriftFinding[]>>('drift.list')
  const sessions = useOperation<AgentSession[]>('sessions.list')
  const questions = useOperation<Note[]>('notes.questions')

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
    for (const item of work.data?.data ?? []) {
      if (item.ticket !== null) keys.add(item.ticket.key)
      for (const pr of item.pullRequests) keys.add(pr.key)
      for (const ws of item.workspaces) keys.add(ws.key)
    }
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
      : { saved: { activeProjectId: settings.data.activeProjectId, mineOnly: settings.data.mineOnly } }),
    persist: writeSettings,
  })

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
  const findings = filterFindings(drift.data?.data ?? [], filter)
  const live = filterSessions(sessions.data ?? [], filter)
  const nudges = (questions.data ?? []).filter((n) => n.resolvedAt === null)
  const counts = summarise(items, findings, live)
  // Each lane reports its own resource, not the board-wide worst. The header
  // summarises only what is on screen — an envelope also carries freshness for
  // kinds nothing displays, and letting those decide put every lane into
  // "never synced" because `comparisons` had no row yet.
  const ticketFreshness = worstFreshness(work.data, 'tickets')
  const pullFreshness = worstFreshness(work.data, 'pulls')
  const branchFreshness = worstFreshness(work.data, 'local')
  const freshness = worstFreshness(work.data, 'tickets', 'pulls', 'local')

  /**
   * What the lanes need to draw and open notes (T150).
   *
   * `undefined` until the counts have arrived, which is what suppresses the
   * badges rather than rendering every row with a zero. A badge reading 0 is a
   * claim; an absent badge is not.
   *
   * The asking set is built from the same `notes.questions` read that feeds
   * Attention — unfiltered, so a badge appears on a row whose project is
   * currently filtered out the moment the filter widens again.
   */
  const notes: NotesAccess | undefined =
    noteCounts.data === undefined
      ? undefined
      : {
          counts: noteCounts.data,
          asking: new Set((questions.data ?? []).flatMap((n) => (n.resolvedAt === null ? [n.subjectKey] : []))),
          open: (key, label) => setNotesFor({ key, label }),
        }

  return (
    <>
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
              onToggleAlwaysOnTop: () =>
                writeSettings({ alwaysOnTop: !settings.data.alwaysOnTop }),
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
              drifting={counts.drifting}
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

            <div className="board__columns">
              <div className="board__main">
                <LaneBoundary lane="Tickets">
                  <Tickets
                    items={items}
                    projects={known}
                    freshness={ticketFreshness}
                    notes={notes}
                  />
                </LaneBoundary>

                {/*
                  Under the tickets rather than above them, at the operator's
                  request.

                  It sat above all three lanes because drift is the one thing on
                  this board no other tool reports, and the top is where that
                  argument leads. What the argument missed is that the panel is
                  *tall* — one strip carries both sides of the evidence and its
                  age — so a board with three findings on it opened on the
                  disagreements and pushed the work itself below the fold. The
                  tickets are what the operator came for; the drift is what they
                  stay for. It keeps its place in the main column, immediately
                  after the lane whose rows it is usually about, and the
                  "Drifting" tile still reports the count from the top.
                */}
                <LaneBoundary lane="Attention">
                  <Attention findings={findings} questions={nudges} onDispatch={setConfirming} />
                </LaneBoundary>

                <LaneBoundary lane="Pull requests">
                  <PullRequests
                    items={items}
                    projects={known}
                    freshness={pullFreshness}
                    notes={notes}
                  />
                </LaneBoundary>

                <LaneBoundary lane="Open branches">
                  <Branches
                    items={items}
                    projects={known}
                    freshness={branchFreshness}
                    notes={notes}
                  />
                </LaneBoundary>
              </div>

              <aside className="board__side">
                <LaneBoundary lane="Agent sessions">
                  <Sessions sessions={live} />
                </LaneBoundary>

                <LaneBoundary lane="Ball in court">
                  <BallInCourt items={items} />
                </LaneBoundary>
              </aside>
            </div>
          </>
        )}
      </main>

      {/*
        Both dialogs live here rather than inside the row or the strip that
        opens them. A `<dialog>` rendered from inside a lane would unmount the
        moment its row left the list — which happens on any sync that reorders
        the lane, and on every project chip press — closing itself mid-sentence
        with the operator's draft in it.
      */}
      {notesFor !== null && (
        <NotesModal
          subjectKey={notesFor.key}
          subjectLabel={notesFor.label}
          onClose={() => setNotesFor(null)}
        />
      )}

      {confirming !== null && (
        <ConfirmAction
          finding={confirming}
          sessions={sessions.data ?? []}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  )
}
