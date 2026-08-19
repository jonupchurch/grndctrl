import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A board at the size SC-013 names: 200 work items across 6 projects.
 *
 * Generated rather than checked in. A 200-item scenario file is a quarter of a
 * megabyte of near-identical JSON that nobody will ever read and every diff will
 * carry — and the thing that actually matters about it, "two hundred, six
 * projects, spread evenly", is one line of code and invisible in the file.
 *
 * Six projects is not incidental either: the palette has exactly six colours
 * (decision 8), so this is also the largest board on which every project still
 * has one, and the point past which a seventh falls back to a neutral chip.
 *
 * **It used to build a pull request and a branch for every other item**, on the
 * argument that correlation needed real joining to do rather than three copies
 * of one list. Both lanes are gone and so is that joining, so 200 items are now
 * 200 rows exactly — which `perf.spec.ts` asserts as a literal number rather
 * than reading it back off this file.
 */

/**
 * Offsets, not dates (FR-118), resolved by whichever reader loads this.
 *
 * The activity cycle is the one that earns its keep: four offsets spanning the
 * ticket lane's 72-hour threshold put every severity band on the measured board,
 * so the timings below are over the board's real drawing cost — four mark shapes
 * and four row treatments — rather than over two hundred identical rows.
 */
const NOW = 'now'
const FETCHED = 'now-30s'
const ACTIVITY = ['now-1h', 'now-4d', 'now-7d', 'now-10d']
const me = { accountId: 'me', displayName: 'Jon', email: null }
const them = { accountId: 'them', displayName: 'Sam', email: null }

export interface LargeBoard {
  path: string
  projects: number
  items: number
  /** How many items belong to the project the performance test filters to. */
  inFirstProject: number
}

export function writeLargeBoard(projectCount = 6, itemCount = 200): LargeBoard {
  const codes = ['MERC', 'ORBT', 'APOL', 'GMNI', 'VOYG', 'CASS'].slice(0, projectCount)

  const projects = codes.map((code, i) => ({
    id: `p-${code.toLowerCase()}`,
    code,
    name: `${code} programme`,
    colorIndex: i,
    jiraConnectionId: 'jira-1',
    jiraProjectKey: code,
    documentationUrl: null,
    statusOverrides: {},
  }))

  const tickets = []
  const perProject = new Array(projectCount).fill(0)

  for (let i = 0; i < itemCount; i++) {
    const p = i % projectCount
    const code = codes[p] ?? 'MERC'
    const number = 1000 + i
    perProject[p] = (perProject[p] ?? 0) + 1
    const activity = ACTIVITY[i % ACTIVITY.length] ?? NOW

    tickets.push({
      key: `jira:acme.atlassian.net/${code}-${number}`,
      connectionId: 'jira-1',
      issueKey: `${code}-${number}`,
      summary: `Work item ${number} in ${code}`,
      // A third in someone else's court, so the court filter has something to
      // remove — measuring a filter that removes nothing measures nothing.
      assignee: i % 3 === 0 ? them : me,
      reporter: them,
      statusName: i % 4 === 0 ? 'In Review' : 'In Progress',
      statusCategory: 'indeterminate',
      isBlocked: false,
      // Cycled rather than constant, and every fifth ticket carries neither —
      // the wide ticket grid has to be measured with its placeholders in it,
      // because those are the rows a real backlog is mostly made of.
      priority: ['Highest', 'High', 'Medium', 'Low', null][i % 5] ?? null,
      storyPoints: [1, 2, 3, 5, null][i % 5] ?? null,
      // Three sprints and a gap, on a different cycle from the other two, so a
      // sort by any one of them has ties to keep stable rather than a column of
      // distinct values that would order the same way however it was compared.
      sprint: ['Sprint 12', 'Sprint 13', null][i % 3] ?? null,
      createdAt: 'now-40d',
      updatedAt: activity,
      lastRealActivityAt: activity,
      lastStatusChangeAt: activity,
      url: `https://acme.atlassian.net/browse/${code}-${number}`,
      fetchedAt: FETCHED,
    })
  }

  const scenario = {
    description: `${itemCount} work items across ${projectCount} projects — the board SC-013 measures against.`,
    now: NOW,
    freshness: [
      {
        connectionId: 'jira-1',
        resourceKind: 'tickets',
        lastSuccessAt: FETCHED,
        lastFailureAt: null,
        failureReason: null,
        nextAttemptAt: null,
      },
    ],
    notes: [],
    input: {
      projects,
      tickets,
      sessions: [],
      operatorAccountIds: ['me'],
    },
  }

  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-large-'))
  const path = join(dir, 'large-board.json')
  writeFileSync(path, JSON.stringify(scenario))

  return { path, projects: projectCount, items: itemCount, inFirstProject: perProject[0] ?? 0 }
}
