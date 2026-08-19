import { describe, expect, it } from 'vitest'
import { pullRequestKey, ticketKey, type NaturalKey } from '../../src/domain/keys.js'
import type { Project, Ticket } from '../../src/domain/types.js'
import { isOperationError } from '../../src/registry/errors.js'
import { resolveLink, safeExternalUrl } from '../../src/services/links.js'
import { tempServices } from '../helpers/services.js'

/**
 * FR-077: every URL the product opens comes from provider data, and provider
 * data is hostile input.
 *
 * The concrete attack this closes: a Jira issue whose `self` link is
 * `javascript:` or `file:`. Handed to `shell.openExternal` unchecked, the first
 * executes in whatever context the shell provides and the second opens a local
 * file — from a string that arrived over the network. So resolution happens in
 * exactly one place, and that place accepts one scheme.
 *
 * **Three of the four hostile-input cases here were removed with their targets**
 * and one was replaced rather than dropped. A pull request, a check run and a
 * branch can no longer be resolved at all, so their poisoned URLs have nowhere
 * to arrive; what stays is a test that a key of a removed kind is *refused*
 * rather than resolved to something plausible, which is the property the removal
 * has to preserve.
 */

const TICKET = ticketKey('acme.atlassian.net', 'MERC-1184')
/** A key of a kind that no longer resolves. It still parses, deliberately. */
const PULL = pullRequestKey('Acme', 'Mercury', 451)

const HOSTILE = [
  'javascript:alert(document.cookie)',
  'JavaScript:alert(1)',
  'file:///C:/Windows/System32/drivers/etc/hosts',
  'file:///etc/passwd',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'grndctrl://outbox/pending',
  // Plain http is refused too. Every provider here is HTTPS, so an http URL is
  // either a misconfiguration or a downgrade someone arranged.
  'http://acme.atlassian.net/browse/MERC-1184',
]

function ticket(url: string): Ticket {
  return {
    key: TICKET,
    connectionId: 'c-jira',
    issueKey: 'MERC-1184',
    summary: 'Reconcile worktree state',
    assignee: null,
    reporter: null,
    statusName: 'In Review',
    statusCategory: 'indeterminate',
    isBlocked: false,
    priority: null,
    storyPoints: null,
    sprint: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    lastRealActivityAt: null,
    lastStatusChangeAt: null,
    url,
    fetchedAt: '2026-08-14T09:00:00.000Z',
  }
}

const project: Project = {
  id: 'p1',
  code: 'MERC',
  name: 'Mercury',
  colorIndex: 0,
  jiraConnectionId: 'c-jira',
  jiraProjectKey: 'MERC',
  documentationUrl: null,
  statusOverrides: {},
}

const sources = (overrides: { tickets?: Ticket[]; projects?: Project[] }) => ({
  tickets: overrides.tickets ?? [],
  projects: overrides.projects ?? [project],
})

describe('safeExternalUrl', () => {
  it('refuses every scheme but https', () => {
    for (const raw of HOSTILE) {
      expect(safeExternalUrl(raw), `${raw} should be refused`).toBeNull()
    }
  })

  it('refuses garbage that is not a URL at all', () => {
    for (const raw of ['', '   ', 'not a url', '//example.invalid', null, undefined]) {
      expect(safeExternalUrl(raw)).toBeNull()
    }
  })

  it('accepts an ordinary https link', () => {
    expect(safeExternalUrl('https://acme.atlassian.net/browse/MERC-1184')).toBe(
      'https://acme.atlassian.net/browse/MERC-1184',
    )
  })
})

describe('a hostile provider', () => {
  it('cannot get a ticket row to open a javascript or file URL', () => {
    for (const raw of HOSTILE) {
      try {
        const { url } = resolveLink(TICKET, 'ticket', sources({ tickets: [ticket(raw)] }))
        throw new Error(`resolved ${raw} to ${url} instead of refusing`)
      } catch (e) {
        // "No usable link" rather than a fallback to something plausible. A
        // link that goes somewhere unexpected is worse than a row that will not
        // open.
        expect(isOperationError(e) && e.code).toBe('not_found')
      }
    }
  })

})

/**
 * A subject of a removed kind is refused, not redirected.
 *
 * This is the assertion that keeps the removal honest. `subjectKindOf` still
 * recognises `pr:`, `repo:`, `ws:` and `check:` — deliberately, because a note
 * written before this change carries one of those keys and must stay readable
 * (T040). So the keys reach `resolveLink` and parse cleanly; what must not
 * happen is that one of them lands on the ticket, or on the project board,
 * because a caller handed a plausible-looking URL has been answered wrongly in a
 * way it cannot detect.
 */
describe('a subject that can no longer be opened', () => {
  it('refuses a pull request key rather than resolving it to something else', () => {
    try {
      const { url } = resolveLink(PULL, 'default', sources({ tickets: [ticket('https://ok.example/x')] }))
      throw new Error(`resolved a pull request key to ${url} instead of refusing`)
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('not_found')
    }
  })

  it('refuses a branch, a repository and a check the same way', () => {
    for (const key of [
      'repo:github.com/Acme/Mercury#feat/reconcile',
      'repo:github.com/Acme/Mercury',
      'check:acme/mercury@abc1234/build',
    ]) {
      expect(() => resolveLink(key as NaturalKey, 'default', sources({}))).toThrow()
    }
  })

  it('refuses a removed target at the schema, before any lookup', async () => {
    const t = tempServices()
    try {
      const ctx = { authorKind: 'user' as const, authorId: null, surface: 'ipc' as const, now: () => new Date() }
      // Not a fallback to the ticket. The enum is the whole check, and it has to
      // be the *operation's* check rather than the service's: a caller reaching
      // the registry with `target: 'branch'` must be told that target does not
      // exist, whatever the service would have done with it.
      for (const target of ['pull-request', 'repository', 'branch', 'check']) {
        await expect(
          t.registry.dispatch('links.resolve', { subjectKey: TICKET, target }, ctx),
        ).rejects.toThrow(/Invalid input/)
      }
    } finally {
      t.dispose()
    }
  })
})

describe('links.resolve through the registry', () => {
  it('refuses a subject key that is not a key at all, before any lookup', () => {
    const t = tempServices()
    try {
      const ctx = { authorKind: 'user' as const, authorId: null, surface: 'ipc' as const, now: () => new Date() }
      return expect(
        t.registry.dispatch('links.resolve', { subjectKey: 'https://evil.invalid' }, ctx),
      ).rejects.toThrow(/Invalid input/)
    } finally {
      t.dispose()
    }
  })

  it('is the same operation on every surface — an agent gets no weaker check', () => {
    const t = tempServices()
    try {
      // XII: if the scheme check lived in the Electron main process instead of
      // here, an agent asking over MCP would receive an unchecked URL.
      expect(t.registry.namesFor('mcp')).toContain('links.resolve')
      expect(t.registry.namesFor('ipc')).toContain('links.resolve')
      expect(t.registry.namesFor('http')).toContain('links.resolve')
    } finally {
      t.dispose()
    }
  })
})

/**
 * Project links (FR-070).
 *
 * The header offers three when the filter narrows to one project, and they go
 * through `resolveLink` like every other URL in the product so the scheme check
 * stays in one place. Added after the desktop header shipped three buttons
 * pointing at `project:<id>` — a key `subjectKindOf` did not recognise, so every
 * one of them threw `invalid` and the failure was swallowed by a `catch` with
 * nowhere to report to.
 */
describe('opening a project', () => {
  const connections = [{ id: 'c-jira', siteOrHost: 'acme.atlassian.net' }]
  const withDocs: Project = { ...project, documentationUrl: 'https://wiki.example/mercury' }

  const projectSources = (p: Project = project) => ({
    ...sources({}),
    projects: [p],
    connections,
  })

  it('opens the Jira board by default', () => {
    expect(resolveLink('project:p1', 'default', projectSources())).toEqual({
      url: 'https://acme.atlassian.net/jira/software/projects/MERC/boards',
      fellBack: false,
    })
  })

  it('opens the documentation link, which is stored and never fetched', () => {
    expect(resolveLink('project:p1', 'documentation', projectSources(withDocs)).url).toBe(
      'https://wiki.example/mercury',
    )
  })

  // A missing binding is `notFound` rather than a fallback to the other one. A
  // link that goes somewhere plausible and wrong is a bug the operator has to
  // discover by clicking. `noJira` is still reachable after 006: `projects.upsert`
  // refuses to create one, but a row written by 0.3.0 can be repository-only and
  // is deliberately kept (FR-110).
  it('refuses rather than substituting when a binding is missing', () => {
    const noJira: Project = { ...project, jiraProjectKey: null }

    expect(() => resolveLink('project:p1', 'default', projectSources(noJira))).toThrow()
    expect(() => resolveLink('project:p1', 'documentation', projectSources())).toThrow()
  })

  it('refuses a project that is not configured', () => {
    expect(() => resolveLink('project:nope', 'default', projectSources())).toThrow()
  })

  it('still refuses a hostile documentation URL', () => {
    for (const url of HOSTILE) {
      const hostile: Project = { ...project, documentationUrl: url }
      expect(() =>
        resolveLink('project:p1', 'documentation', projectSources(hostile)),
      ).toThrow()
    }
  })
})

/**
 * Documentation for a *subject* resolves to that subject's own project.
 *
 * It used to take whichever project had a documentation URL at all, which is
 * indistinguishable from correct with one project configured and opens another
 * team's wiki with two.
 */
describe('documentation for a subject', () => {
  it('uses the subject’s own project, not the first one with a link', () => {
    const mercury: Project = { ...project, documentationUrl: 'https://wiki.example/mercury' }
    const atlas: Project = {
      ...project,
      id: 'p2',
      code: 'ATLS',
      jiraProjectKey: 'ATLS',
      documentationUrl: 'https://wiki.example/atlas',
    }

    const resolved = resolveLink(ticketKey('acme.atlassian.net', 'ATLS-9'), 'documentation', {
      ...sources({}),
      projects: [mercury, atlas],
    })

    expect(resolved.url).toBe('https://wiki.example/atlas')
  })
})
