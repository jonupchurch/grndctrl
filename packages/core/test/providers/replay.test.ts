import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jiraProvider } from '../../src/providers/jira/index.js'
import { githubProvider } from '../../src/providers/github/index.js'
import { localGitProvider } from '../../src/providers/git/read.js'
import { replayFetcher } from '../fixtures/record.js'
import { replayGitRunner } from '../fixtures/record-git.js'

/**
 * The providers, against payloads a real provider actually sent (T038–T040).
 *
 * Every other provider test in this repository is written from a payload the
 * author believed the provider returns, which means it agrees with that belief
 * whether or not the belief is right. That is not a hypothetical weakness: the
 * day these providers first met live data, eight bugs surfaced in code with a
 * green suite, and several were shapes nobody had thought to write down — a
 * `nextPageToken` on a response, a `statusCategory` nested one level deeper
 * than assumed, an assignee that is `null` rather than absent.
 *
 * These fixtures are recorded from live connections by
 * `scripts/record-fixtures.ts`, scrubbed, and **kept out of the repository by
 * decision** — real payloads derived from a real client's tracker do not belong
 * in a published tree, even scrubbed. `fixtures/{jira,github,git}` are
 * gitignored.
 *
 * ## Why skipping is safe here, when it usually is not
 *
 * A test that skips when its data is missing is normally a test that quietly
 * stops testing. Two things make this one different, and both are asserted
 * rather than assumed:
 *
 * - It skips on **the directory being absent**, which is a fact about the
 *   machine, not about the code — a fresh clone has never had them.
 * - If the directory exists but is empty, or holds nothing this test recognises,
 *   it **fails** rather than skipping. "Recorded nothing" and "recorded fixtures
 *   that do not match" are the two ways this could rot into a green no-op, and
 *   neither is allowed to look like a pass.
 *
 * The suite is therefore green on a clone with no fixtures and green on a
 * machine with them, and there is no third state where it is green because it
 * did nothing.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures')

/** Recorded requests in a fixture directory, or null when it was never recorded. */
function recorded(kind: string): string[] | null {
  const dir = join(ROOT, kind)
  if (!existsSync(dir)) return null
  return readdirSync(dir).filter((f) => f.endsWith('.json'))
}

const jira = recorded('jira')
const github = recorded('github')
const git = recorded('git')

describe('Jira, replayed from a recording', () => {
  it.skipIf(jira === null)('has fixtures that are actually fixtures', () => {
    // The guard against the silent no-op: a directory somebody created and
    // never filled must not read as "nothing to check here".
    expect(jira ?? []).not.toHaveLength(0)
  })

  it.skipIf(jira === null)('parses a real search response into tickets', async () => {
    const provider = jiraProvider({
      site: 'example.atlassian.net',
      email: 'operator@example.com',
      apiToken: 'replayed',
      fetcher: replayFetcher(join(ROOT, 'jira')),
    })

    const page = await provider.searchIssues({ jql: 'assignee = currentUser()' })

    expect(page.tickets.length).toBeGreaterThan(0)
    for (const ticket of page.tickets) {
      // The fields correlation joins on. A provider that returns rows with no
      // key produces a board that silently drops them.
      expect(ticket.key).toMatch(/^jira:/)
      expect(ticket.statusCategory).toMatch(/^(new|indeterminate|done)$/)
      expect(typeof ticket.summary).toBe('string')
      // `updated` is displayed and deliberately not used for staleness, because
      // automation moves it (FR-027). `lastRealActivityAt` is what staleness
      // reads, and a recording is the only way to check it survives a real
      // changelog rather than a hand-written one.
      expect(ticket.lastRealActivityAt === null || typeof ticket.lastRealActivityAt === 'string').toBe(
        true,
      )
    }
  })
})

describe('GitHub, replayed from a recording', () => {
  it.skipIf(github === null)('has fixtures that are actually fixtures', () => {
    expect(github ?? []).not.toHaveLength(0)
  })

  it.skipIf(github === null)('parses a real repository, with normalised review state', async () => {
    const provider = githubProvider({
      token: 'replayed',
      fetcher: replayFetcher(join(ROOT, 'github')),
    })

    const { pullRequests, branches } = await provider.fetchRepository({
      owner: 'example',
      repo: 'example',
    })

    expect(pullRequests.length + branches.length).toBeGreaterThan(0)

    let decided = 0
    for (const pull of pullRequests) {
      // The renderer compared this against GitHub's raw casing for weeks, so no
      // pull request could ever render "Changes requested". A fixture recorded
      // from the wire is what makes the normalisation checkable rather than
      // asserted against the same belief that produced it.
      if (pull.reviewDecision !== null) {
        decided += 1
        expect(pull.reviewDecision).toMatch(/^(approved|changesRequested|reviewRequired)$/)
      }
    }

    // The guard above is why this assertion existed for a week without ever
    // running: the first recording came from a repository nobody had reviewed,
    // every `reviewDecision` was null, and the loop body was skipped fifty
    // times over. It passed, and it was checking nothing — and when a fixture
    // finally did reach it, the pattern turned out to be wrong too, written in
    // kebab-case against a value core has always emitted in camelCase.
    //
    // So the count is the real assertion. A conditional check needs something
    // that proves the condition was met, or the next fixture quietly returns
    // this to a test that cannot fail.
    expect(decided, 'no pull request in the fixture carries a review decision').toBeGreaterThan(0)
  })

  it.skipIf(github === null)('covers more than one review decision', async () => {
    const provider = githubProvider({
      token: 'replayed',
      fetcher: replayFetcher(join(ROOT, 'github')),
    })

    const { pullRequests } = await provider.fetchRepository({ owner: 'example', repo: 'example' })
    const seen = new Set(pullRequests.map((pull) => pull.reviewDecision).filter((d) => d !== null))

    // One distinct value would satisfy the check above while proving only that
    // a single branch of the normaliser works. Which values a public repository
    // happens to be showing is not ours to choose, so this asserts on the
    // spread rather than on any particular member of it.
    expect(seen.size, `only saw ${[...seen].join(', ') || 'nothing'}`).toBeGreaterThan(1)
  })
})

describe('local git, replayed from a recording', () => {
  it.skipIf(git === null)('has fixtures that are actually fixtures', () => {
    expect(git ?? []).not.toHaveLength(0)
  })

  it.skipIf(git === null)('parses real porcelain into a workspace', async () => {
    const provider = localGitProvider(replayGitRunner(join(ROOT, 'git')))

    // The path is not the key. It was scrubbed on the way in, so a replay that
    // had to match it would only ever work on the machine that recorded it.
    const workspaces = await provider.readWorkspaces({ repoPath: '/repo' })

    expect(workspaces.length).toBeGreaterThan(0)
    for (const workspace of workspaces) {
      // `ws:<canonicalRemote>#<branch>@<worktree>` — the natural key
      // correlation joins on. Derived from the remote, so this is also the
      // assertion that the scrub kept the remote coherent: a recording whose
      // remote differs between two files produces workspaces that cannot be
      // joined to anything.
      expect(workspace.key).toMatch(/^ws:github\.com\/example\/repo#/)
      expect(typeof workspace.branch).toBe('string')
      // `null` means "never pushed" and is rendered as that rather than as
      // zero, which is the distinction the renderer got wrong for weeks.
      expect(
        workspace.unpushedCommitCount === null ||
          typeof workspace.unpushedCommitCount === 'number',
      ).toBe(true)
    }
  })

  it.skipIf(git === null)('refuses a command it never recorded, rather than answering empty', async () => {
    // The property that makes every assertion above mean something. An empty
    // stdout for an unrecorded command is how a parser test passes against
    // output nobody ever produced.
    const runner = replayGitRunner(join(ROOT, 'git'))
    await expect(runner.run('/repo', ['log', '--oneline'])).rejects.toThrow(/No recorded git fixture/)
  })
})
