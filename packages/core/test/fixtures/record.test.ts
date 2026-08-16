import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Aliases, fixtureName, recordingFetcher, replayFetcher, scrub } from './record.js'

/**
 * The fixture recorder (T037).
 *
 * Two things have to be true at once and they pull against each other: nothing
 * identifying may reach the repository, and what is left must still be able to
 * fail. A scrub that replaced every string with `"x"` would satisfy the first
 * completely and make the fixtures worthless — so most of this file is about
 * the second.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-record-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('what must not survive', () => {
  it('replaces the words in a ticket summary', () => {
    const out = scrub({ summary: 'Migrate the billing exporter to the new schema' }) as {
      summary: string
    }

    expect(out.summary).not.toContain('billing')
    expect(out.summary).not.toContain('exporter')
    // Same length: the board truncates, and a fixture whose titles are all
    // short would never show that.
    expect(out.summary).toHaveLength('Migrate the billing exporter to the new schema'.length)
  })

  it('replaces names, emails and account ids', () => {
    const out = scrub({
      displayName: 'Priya Raghunathan',
      emailAddress: 'priya@realcustomer.co.uk',
      accountId: '5f1e2d3c4b5a6978',
    }) as Record<string, string>

    expect(JSON.stringify(out)).not.toContain('Priya')
    expect(JSON.stringify(out)).not.toContain('realcustomer')
    expect(JSON.stringify(out)).not.toContain('5f1e2d3c4b5a6978')
    expect(out['emailAddress']).toMatch(/^person\d+@example\.com$/)
    expect(out['accountId']).toMatch(/^account-\d{4}$/)
  })

  it('replaces a name under a person, and keeps one under a status or a check', () => {
    // `name` is the worst key in either API and the decision has to be made on
    // the parent. GitHub puts a colleague's real name at `commit.author.name`;
    // Jira puts `In Progress` at `statusCategory.name`, which the drift rules
    // match with a regex; a check run's `name` goes into a natural key.
    const out = scrub({
      commit: { author: { name: 'Priya Raghunathan', date: '2026-08-14T11:57:00Z' } },
      statusCategory: { key: 'indeterminate', name: 'In Progress' },
      checkRuns: [{ name: 'build (18.x)', conclusion: 'failure' }],
    }) as {
      commit: { author: { name: string } }
      statusCategory: { name: string }
      checkRuns: { name: string }[]
    }

    expect(out.commit.author.name).not.toContain('Priya')
    expect(out.statusCategory.name).toBe('In Progress')
    expect(out.checkRuns[0]?.name).toBe('build (18.x)')
  })

  it('takes the host and the query string off a URL but keeps the path', () => {
    const out = scrub({
      self: 'https://realcustomer.atlassian.net/rest/api/3/issue/10042?expand=changelog',
    }) as Record<string, string>

    // The path is what the parsers read; the host names the customer and the
    // query string carries a JQL naming real projects and real people.
    expect(out['self']).toBe('https://example.atlassian.net/rest/api/3/issue/10042')
  })

  it('refuses to write a payload a credential survived', () => {
    // Not masked — raised. A token in a response body means it was echoed back
    // or captured from a request, and quietly replacing it would hide that.
    expect(() =>
      scrub({ description: 'use ghp_realtokenvalue for now' }, { secrets: ['ghp_realtokenvalue'] }),
    ).not.toThrow()

    expect(() =>
      scrub({ token: 'ghp_realtokenvalue' }, { secrets: ['ghp_realtokenvalue'] }),
    ).toThrow(/credential/i)
  })
})

describe('what must survive, or the fixture proves nothing', () => {
  it('gives one ticket key the same alias everywhere it appears', () => {
    // The assertion the whole recorder exists for. This key appears in four
    // places across two providers, and the correlation engine's entire job is
    // noticing they are the same string.
    const out = scrub({
      issues: [{ key: 'BLUEBED-1184', fields: { summary: 'BLUEBED-1184 exporter migration' } }],
      pullRequest: {
        title: 'BLUEBED-1184: migrate the exporter',
        headRefName: 'feature/BLUEBED-1184-exporter',
        commits: [{ message: 'BLUEBED-1184 first cut' }],
      },
    }) as {
      issues: { key: string; fields: { summary: string } }[]
      pullRequest: { title: string; headRefName: string; commits: { message: string }[] }
    }

    const alias = out.issues[0]?.key
    expect(alias).toMatch(/^MERC-\d+$/)
    expect(out.issues[0]?.fields.summary).toContain(alias)
    expect(out.pullRequest.title).toContain(alias)
    expect(out.pullRequest.headRefName).toContain(alias)
    expect(out.pullRequest.commits[0]?.message).toContain(alias)
    expect(JSON.stringify(out)).not.toContain('BLUEBED')
  })

  it('aliases a key mentioned before the issue that owns it', () => {
    // The reason the scrub is two passes. In a real recording the pull request
    // is fetched first, so the *mention* is seen before the issue — and a
    // single pass would alias them independently, silently breaking the only
    // link the fixture was recorded to exercise.
    const mentionFirst = scrub({
      title: 'BLUEBED-9 and BLUEBED-10',
      issues: [{ key: 'BLUEBED-10' }, { key: 'BLUEBED-9' }],
    }) as { title: string; issues: { key: string }[] }

    const ten = mentionFirst.issues[0]?.key ?? ''
    const nine = mentionFirst.issues[1]?.key ?? ''

    expect(ten).not.toBe(nine)
    // The connecting word is prose and is correctly destroyed; what has to
    // survive is which alias sits where.
    expect(mentionFirst.title.startsWith(nine)).toBe(true)
    expect(mentionFirst.title.endsWith(ten)).toBe(true)
  })

  it('does not let one alias eat another', () => {
    // `BLUEBED-1` is a prefix of `BLUEBED-11`. Substituting shortest-first
    // would turn `BLUEBED-11` into `MERC-10011`.
    const out = scrub({ a: 'BLUEBED-1', b: 'BLUEBED-11', text: 'BLUEBED-11 blocks BLUEBED-1' }) as
      Record<string, string>

    expect(out['text']).toBe(`${out['b']} ${out['text']?.split(' ')[1]} ${out['a']}`)
    expect(out['b']).not.toContain(out['a'] ?? '')
  })

  it('leaves timestamps, enums, numbers and booleans exactly as sent', () => {
    // These are the fixture. Staleness, drift severity, ball-in-court and every
    // lane threshold reason over them, and a scrub that touched them would
    // produce a fixture that cannot reproduce a bug.
    const out = scrub({
      updated: '2026-08-14T11:57:00.000+0100',
      statusCategory: { key: 'indeterminate', name: 'In Progress' },
      state: 'MERGED',
      conclusion: 'failure',
      reviewDecision: 'CHANGES_REQUESTED',
      number: 451,
      commits: 12,
      draft: false,
      mergedAt: null,
    }) as Record<string, unknown>

    expect(out['updated']).toBe('2026-08-14T11:57:00.000+0100')
    expect(out['statusCategory']).toEqual({ key: 'indeterminate', name: 'In Progress' })
    expect(out['state']).toBe('MERGED')
    expect(out['conclusion']).toBe('failure')
    expect(out['reviewDecision']).toBe('CHANGES_REQUESTED')
    expect(out['number']).toBe(451)
    expect(out['commits']).toBe(12)
    expect(out['draft']).toBe(false)
    expect(out['mergedAt']).toBeNull()
  })

  it('keeps every key name and the shape of the payload', () => {
    const original = {
      issues: [{ key: 'X-1', fields: { summary: 's', assignee: { accountId: 'a' } } }],
      nextPageToken: 'abc',
      isLast: false,
    }
    const out = scrub(original)

    // Recorded fixtures exist to disagree with the parser about *shape*. If the
    // scrub reshaped anything, they would only ever agree.
    const shapeOf = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(shapeOf)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]))
          : typeof v

    expect(shapeOf(out)).toEqual(shapeOf(original))
  })

  it('is deterministic, so re-recording produces a readable diff', () => {
    const payload = { key: 'BLUEBED-7', fields: { summary: 'Fix the flaky upload retry' } }

    // A recorder whose output moved on every run would make `git diff` useless
    // on the one file where a real change most needs to be visible.
    expect(JSON.stringify(scrub(payload))).toBe(JSON.stringify(scrub(payload)))
  })

  it('shares one alias table across payloads in a session', () => {
    const aliases = new Aliases()
    const jira = scrub({ key: 'BLUEBED-3' }, { aliases }) as { key: string }
    const github = scrub({ headRefName: 'feature/BLUEBED-3' }, { aliases }) as {
      headRefName: string
    }

    // Two providers, two requests, one ticket. Without a shared table the
    // recorded pair could never correlate.
    expect(github.headRefName).toContain(jira.key)
  })
})

describe('recording and replaying', () => {
  const live = (body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

  it('writes what came back, scrubbed, and hands the response on untouched', async () => {
    const fetcher = recordingFetcher({
      dir,
      fetcher: live({ key: 'BLUEBED-1184', fields: { summary: 'Secret client work' } }),
      secrets: ['tok'],
    })

    const response = await fetcher('https://real.atlassian.net/rest/api/3/issue/10042', {
      method: 'GET',
    })

    // The caller gets the real payload: recording must not change what the code
    // under it sees, or the recording run itself would be testing something
    // else.
    expect(((await response.json()) as { key: string }).key).toBe('BLUEBED-1184')

    const [file] = readdirSync(dir)
    const written = readFileSync(join(dir, file ?? ''), 'utf8')
    expect(written).not.toContain('BLUEBED')
    expect(written).not.toContain('Secret')
    expect(written).toContain('/rest/api/3/issue/10042')
  })

  it('replays a recorded call and refuses one it has not seen', async () => {
    const record = recordingFetcher({ dir, fetcher: live({ isLast: true, issues: [] }) })
    await record('https://real.atlassian.net/rest/api/3/search/jql', { method: 'POST' })

    const replay = replayFetcher(dir)
    const played = await replay('https://example.atlassian.net/rest/api/3/search/jql', {
      method: 'POST',
    })
    expect((await played.json()) as unknown).toEqual({ isLast: true, issues: [] })

    // A replay that answered `{}` for an unrecorded call is how a test ends up
    // passing against a payload nobody has ever seen.
    await expect(replay('https://example.atlassian.net/rest/api/3/myself', { method: 'GET' })).rejects.toThrow(
      /No recorded fixture/,
    )
  })

  it('names a fixture after its request, stably', () => {
    expect(fixtureName('POST', 'https://x.atlassian.net/rest/api/3/search/jql?a=1')).toBe(
      'post-rest-api-3-search-jql',
    )
    expect(fixtureName('GET', 'https://api.github.com/')).toBe('get-root')
  })
})
