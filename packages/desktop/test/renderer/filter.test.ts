import { describe, expect, it } from 'vitest'
import { filterHistory } from '../../src/renderer/filter.js'
import type { Filter } from '../../src/renderer/filter.js'
import type { Project, TicketHistoryEntry } from '../../src/renderer/types.js'

/**
 * The project chips, over the one list that has no project on it.
 *
 * `filterWork` and `filterSessions` compare a `projectId` to a `projectId` and
 * are checked end to end, where there is a real board to narrow. This one is
 * here because it matches on a *string derived from a key*, which is the only
 * place in the renderer that does — and the edges are all in that match: a
 * project key that is a prefix of another, an entry whose ticket left the mirror
 * years ago, and a project with no Jira binding at all.
 */

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p-merc',
  code: 'MERC',
  name: 'Mercury',
  colorIndex: null,
  jiraProjectKey: 'MERC',
  documentationUrl: null,
  ...over,
})

const filter = (over: Partial<Filter> = {}): Filter => ({
  projectId: null,
  mineOnly: false,
  select: () => undefined,
  toggleMine: () => undefined,
  only: null,
  ...over,
})

/** Narrowed to one project, the way `useFilter` reports it. */
const narrowed = (only: Project, mineOnly = false): Filter =>
  filter({ projectId: only.id, only, mineOnly })

const entry = (issueKey: string | null): TicketHistoryEntry => ({
  // The natural key is branded in core and constructed by `ticketKey()` there,
  // which the renderer must not import — it is a `better-sqlite3` module away.
  // The cast is the same one the IPC boundary makes when a key arrives as JSON.
  ticketKey: (issueKey === null
    ? 'malformed'
    : `jira:acme.atlassian.net/${issueKey}`) as TicketHistoryEntry['ticketKey'],
  issueKey,
  line: `Something happened on ${issueKey ?? 'nothing'}.`,
  notes: null,
  ticketSummary: null,
  authorKind: 'agent',
  authorId: 'claude-code',
  revision: 1,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
})

const keys = (entries: readonly TicketHistoryEntry[]): (string | null)[] =>
  entries.map((e) => e.issueKey)

describe('narrowing the ticket history by project', () => {
  const entries = [entry('MERC-1184'), entry('APOL-77'), entry('MERC-1150')]

  it('keeps everything when no chip is pressed, which is the common case', () => {
    expect(keys(filterHistory(entries, filter()))).toEqual(['MERC-1184', 'APOL-77', 'MERC-1150'])
  })

  it('keeps the selected project’s entries and drops the rest', () => {
    expect(keys(filterHistory(entries, narrowed(project())))).toEqual(['MERC-1184', 'MERC-1150'])
    expect(
      keys(filterHistory(entries, narrowed(project({ id: 'p-apol', jiraProjectKey: 'APOL' })))),
    ).toEqual(['APOL-77'])
  })

  it('keeps an entry whose ticket the mirror no longer holds', () => {
    // The whole reason this region exists (FR-149). MERC-1150 closed a month
    // ago and has no row to read a `projectId` off — a filter that needed one
    // would drop exactly the entries the history is kept for.
    expect(keys(filterHistory([entry('MERC-1150')], narrowed(project())))).toEqual(['MERC-1150'])
  })

  it('does not match a project key that is merely a prefix of another', () => {
    // `MERC` against `MERCURY-4`. The separator is part of the comparison, so
    // this is a real distinction rather than a `startsWith` that happens to work
    // on the keys anybody has tried.
    expect(filterHistory([entry('MERCURY-4')], narrowed(project()))).toEqual([])
  })

  it('matches regardless of case, because a key is stored uppercase and typed either way', () => {
    expect(keys(filterHistory([entry('MERC-1184')], narrowed(project({ jiraProjectKey: 'merc' }))))).toEqual(
      ['MERC-1184'],
    )
  })

  it('drops an entry whose key is malformed rather than showing it under every chip', () => {
    // `issueKey` is null only when the stored key is not a `jira:` key at all,
    // which nothing writes. It belongs to no project, so it belongs to no
    // narrowed board — and it is still there when the chip is released.
    const odd = [entry(null)]
    expect(filterHistory(odd, narrowed(project()))).toEqual([])
    expect(filterHistory(odd, filter())).toHaveLength(1)
  })

  it('shows nothing for a project with no Jira binding, like its ticket lane', () => {
    // A repository-only project from 0.3.0 (FR-110). It can have no tickets, so
    // it can have no history — and the honest answer is empty rather than all.
    expect(filterHistory(entries, narrowed(project({ jiraProjectKey: null })))).toEqual([])
  })

  it('ignores the court toggle, which a finished ticket can never satisfy', () => {
    // Every entry is about work that is done, so nothing here is in anybody's
    // court. Honouring `mineOnly` would empty the region every time the operator
    // narrowed to their own work.
    expect(filterHistory(entries, filter({ mineOnly: true }))).toHaveLength(3)
    expect(keys(filterHistory(entries, narrowed(project(), true)))).toEqual([
      'MERC-1184',
      'MERC-1150',
    ])
  })
})
