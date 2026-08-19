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
 */

const NOW = '2026-08-14T12:00:00Z'
const ACTIVITY = '2026-08-14T09:00:00Z'
const FETCHED = '2026-08-14T11:59:30Z'
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
    githubConnectionId: 'gh-1',
    repoOwner: 'acme',
    repoName: code.toLowerCase(),
    documentationUrl: null,
    checkoutPaths: [],
    statusOverrides: {},
  }))

  const tickets = []
  const pullRequests = []
  const branches = []
  const perProject = new Array(projectCount).fill(0)

  for (let i = 0; i < itemCount; i++) {
    const p = i % projectCount
    const code = codes[p] ?? 'MERC'
    const number = 1000 + i
    perProject[p] = (perProject[p] ?? 0) + 1

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
      createdAt: '2026-08-01T09:00:00Z',
      updatedAt: ACTIVITY,
      lastRealActivityAt: ACTIVITY,
      lastStatusChangeAt: ACTIVITY,
      url: `https://acme.atlassian.net/browse/${code}-${number}`,
      fetchedAt: '2026-08-14T11:57:00Z',
    })

    // Half carry a pull request and a branch, so correlation has real joining
    // to do and the lanes are not three copies of one list.
    if (i % 2 === 0) {
      const repo = code.toLowerCase()
      const head = `feature/${code}-${number}`
      pullRequests.push({
        key: `gh:acme/${repo}#${number}`,
        connectionId: 'gh-1',
        number,
        title: `feat: work item ${number}`,
        author: me,
        headBranch: head,
        headSha: `sha${number}`,
        baseBranch: 'main',
        state: 'open',
        isDraft: false,
        reviewDecision: 'approved',
        requestedReviewers: [],
        unresolvedThreadCount: 0,
        mergedAt: null,
        closedAt: null,
        lastRealActivityAt: ACTIVITY,
        url: `https://github.com/acme/${repo}/pull/${number}`,
        fetchedAt: FETCHED,
      })
      branches.push({
        key: `repo:github.com/acme/${repo}#${head}`,
        connectionId: 'gh-1',
        name: head,
        headSha: `sha${number}`,
        updatedAt: ACTIVITY,
        url: `https://github.com/acme/${repo}/tree/${head}`,
        fetchedAt: FETCHED,
      })
    }
  }

  const scenario = {
    description: `${itemCount} work items across ${projectCount} projects — the board SC-013 measures against.`,
    now: NOW,
    freshness: [
      { connectionId: 'jira-1', resourceKind: 'tickets', lastSuccessAt: '2026-08-14T11:57:00Z', lastFailureAt: null, failureReason: null, nextAttemptAt: null },
      { connectionId: 'gh-1', resourceKind: 'pulls', lastSuccessAt: FETCHED, lastFailureAt: null, failureReason: null, nextAttemptAt: null },
    ],
    input: {
      projects,
      tickets,
      pullRequests,
      branches,
      checks: [],
      workspaces: [],
      comparisons: [],
      sessions: [],
      noteCounts: {},
      openQuestionSubjects: [],
      operatorAccountIds: ['me'],
    },
  }

  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-large-'))
  const path = join(dir, 'large-board.json')
  writeFileSync(path, JSON.stringify(scenario))

  return { path, projects: projectCount, items: itemCount, inFirstProject: perProject[0] ?? 0 }
}
