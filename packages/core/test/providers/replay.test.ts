import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jiraProvider } from '../../src/providers/jira/index.js'
import { replayFetcher } from '../fixtures/record.js'

/**
 * The provider, against payloads a real provider actually sent (T038–T040).
 *
 * Every other provider test in this repository is written from a payload the
 * author believed the provider returns, which means it agrees with that belief
 * whether or not the belief is right. That is not a hypothetical weakness: the
 * day these providers first met live data, eight bugs surfaced in code with a
 * green suite, and several were shapes nobody had thought to write down — a
 * `nextPageToken` on a response, a `statusCategory` nested one level deeper
 * than assumed, an assignee that is `null` rather than absent.
 *
 * These fixtures are recorded from a live connection by
 * `scripts/record-fixtures.ts`, scrubbed, and **kept out of the repository by
 * decision** — real payloads derived from a real client's tracker do not belong
 * in a published tree, even scrubbed. `fixtures/jira` is gitignored.
 *
 * **Two of the three describes are gone**, with the GitHub and local git
 * providers. The guard below is the thing to keep hold of while deleting two
 * thirds of a file: it is what stops this test rotting into a green no-op, and
 * it is easy to lose along with the blocks it sat between.
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
