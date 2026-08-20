import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NaturalKey } from '../../src/domain/keys.js'
import type { Ctx } from '../../src/registry/types.js'
import { tempServices, type TempServices } from '../helpers/services.js'

/**
 * The half the unit test cannot prove: that the check is actually *called*.
 *
 * `sites.ts` having a correct `assertKnown` and nothing invoking it is the same
 * defect over again — a resolver that could tell, and a write path that never
 * asked. So this goes through the real composition root and the real registry,
 * exactly as `grndctrl_add_note` and `grndctrl_set_active_ticket` do.
 *
 * The site here is a placeholder. The report came from a real one, and real
 * client sites do not enter this repository.
 */

const SITE = 'example.atlassian.net'
const GOOD = `jira:${SITE}/ENG-1`
/** The key that was actually sent: the site's first label, not its host. */
const SHORT = 'jira:example/ENG-1'

const ctx: Ctx = {
  authorKind: 'agent',
  authorId: 'claude-code',
  surface: 'mcp',
  now: () => new Date('2026-08-20T12:00:00.000Z'),
}

let s: TempServices

beforeEach(() => {
  s = tempServices()
  s.services.mirror.upsertConnection({
    id: 'jira-1',
    kind: 'jira',
    siteOrHost: SITE,
    accountLabel: 'operator',
    viewerIdentity: null,
    credentialRef: 'grndctrl/jira-1',
  })
})

afterEach(() => {
  s.dispose()
})

describe('a note on a site nothing is configured for', () => {
  it('is refused rather than stored and flagged orphaned', async () => {
    /*
     * The reported behaviour was `200` and `orphaned: true`, which reads as
     * normal to an agent — nothing in that response says "this will never be
     * visible". The assertion is therefore on the *refusal*, not on a field in
     * a successful answer.
     */
    await expect(
      s.registry.dispatch(
        'notes.create',
        { subjectKey: SHORT, type: 'decision', body: 'Anything.' },
        ctx,
      ),
    ).rejects.toThrow(/No connection is configured/)
  })

  it('leaves nothing behind when it refuses', async () => {
    await expect(
      s.registry.dispatch(
        'notes.create',
        { subjectKey: SHORT, type: 'decision', body: 'Anything.' },
        ctx,
      ),
    ).rejects.toThrow()

    // A refusal that still wrote the row would be worse than the bug: the note
    // would exist, be invisible, and now also be unreportable.
    expect(s.services.notes.list(SHORT as never)).toHaveLength(0)
  })

  it('still accepts an issue the mirror has never held, under the real site', async () => {
    // FR-131, through the whole stack. This is the case the fix must not break,
    // and the one a blunter "reject unresolvable keys" would have broken.
    const note = (await s.registry.dispatch(
      'notes.create',
      { subjectKey: GOOD, type: 'decision', body: 'Written before the first sync.' },
      ctx,
    )) as { subjectKey: string }

    expect(note.subjectKey).toBe(GOOD)
  })
})

describe('the ticket history', () => {
  it('refuses a site nothing is configured for', async () => {
    // The third write path, and it arrived after the check did. An entry on an
    // unresolvable key is worse here than anywhere else: this is the record kept
    // to answer questions months later, so it would be missed at exactly the
    // moment nobody could reconstruct what was meant.
    await expect(
      s.registry.dispatch('history.record', { ticketKey: SHORT, line: 'Done.' }, ctx),
    ).rejects.toThrow(/No connection is configured/)

    expect(s.services.history.list()).toHaveLength(0)
  })

  it('still accepts a ticket the mirror has never held', async () => {
    const written = (await s.registry.dispatch(
      'history.record',
      { ticketKey: `jira:${SITE}/NOPE-9999`, line: 'Closed before it ever synced.' },
      ctx,
    )) as { ticketKey: string; ticketSummary: string | null }

    expect(written.ticketKey).toBe(`jira:${SITE}/NOPE-9999`)
    // No summary, because there is no mirrored row to take one from. Null here
    // is "could not answer", not "the ticket has no summary".
    expect(written.ticketSummary).toBeNull()
  })

  it('snapshots the ticket summary through the real composition root', async () => {
    // The cross-store read (XIII), which the service unit test can only fake.
    // A `ticketSummary` dependency declared and never wired is the same class of
    // defect this whole file exists for.
    s.services.mirror.replaceTickets('jira-1', [
      {
        key: `jira:${SITE}/ENG-7` as NaturalKey,
        connectionId: 'jira-1',
        issueKey: 'ENG-7',
        summary: 'Retry storms when one site throttles',
        assignee: null,
        reporter: null,
        statusName: 'Done',
        statusCategory: 'done',
        isBlocked: false,
        priority: null,
        storyPoints: null,
        sprint: null,
        description: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        lastRealActivityAt: '2026-08-01T00:00:00.000Z',
        lastStatusChangeAt: null,
        url: `https://${SITE}/browse/ENG-7`,
        fetchedAt: '2026-08-01T00:00:00.000Z',
      },
    ])

    const written = (await s.registry.dispatch(
      'history.record',
      { ticketKey: `jira:${SITE}/ENG-7`, line: 'Backed off per connection.' },
      ctx,
    )) as { ticketSummary: string | null }

    expect(written.ticketSummary).toBe('Retry storms when one site throttles')
  })
})

describe('the active ticket', () => {
  it('refuses a site nothing is configured for', async () => {
    // Same defect, same shape: an unresolvable pointer produces a panel that
    // says "not on your board" forever, which is indistinguishable from a
    // ticket that simply has not synced.
    await expect(s.registry.dispatch('focus.set', { ticketKey: SHORT }, ctx)).rejects.toThrow(
      /No connection is configured/,
    )
  })

  it('still accepts a ticket the mirror has never held', async () => {
    const set = (await s.registry.dispatch(
      'focus.set',
      { ticketKey: `jira:${SITE}/NOPE-9999` },
      ctx,
    )) as { ticketKey: string }

    expect(set.ticketKey).toBe(`jira:${SITE}/NOPE-9999`)
  })
})
