import { describe, expect, it } from 'vitest'
import { siteOfTicketKey } from '../../src/domain/keys.js'
import { siteCheck } from '../../src/services/sites.js'

/**
 * The reported defect, as the test that would have caught it.
 *
 * **Repro, from the field**: with a Jira connection configured for
 * `example.atlassian.net`, `grndctrl_add_note` on `jira:example/ANY-1` — the
 * site's first label rather than its host — returned `200` with
 * `orphaned: true`. The note was stored and was invisible on the board forever.
 * `grndctrl_get_work_item` on the same key correctly answered `not_found`, so
 * the resolver could already tell; the write path never asked.
 *
 * The short form was not a wild guess, which is what makes it worth defending
 * against: a project's configuration records Jira as `https://example.atlassian.net`,
 * and `example` reads perfectly naturally as the site name.
 *
 * ## The distinction the fix turns on
 *
 * An unknown **issue** under a known site is legal and stays legal — FR-131 has
 * an agent setting focus before the sync that would fetch the ticket, and a note
 * may be attached to something not yet mirrored. An unknown **site** can never
 * resolve, because nothing is configured to talk to it. Every case below is
 * about keeping those two apart.
 */

const CONFIGURED = ['example.atlassian.net']
const check = (sites: readonly string[] = CONFIGURED): { assertKnown: (k: string) => void } =>
  siteCheck({ configuredSites: () => sites })

describe('the site segment of a ticket key', () => {
  it('is read back out of the key', () => {
    expect(siteOfTicketKey('jira:example.atlassian.net/ENG-1')).toBe('example.atlassian.net')
    // Lowercased the same way `ticketKey` writes it, so a caller shouting the
    // host does not get a spurious refusal.
    expect(siteOfTicketKey('jira:EXAMPLE.ATLASSIAN.NET/ENG-1')).toBe('example.atlassian.net')
  })

  it('is null for anything that is not a ticket key', () => {
    expect(siteOfTicketKey('session:claude-code/run-1')).toBeNull()
    expect(siteOfTicketKey('gh:acme/mercury#4')).toBeNull()
    // No slash means no issue part, so there is no site worth reporting either.
    expect(siteOfTicketKey('jira:example.atlassian.net')).toBeNull()
    expect(siteOfTicketKey('jira:/ENG-1')).toBeNull()
  })
})

describe('writing against a site nothing is configured for', () => {
  it('refuses the short form that was actually sent', () => {
    // The repro, exactly.
    expect(() => check().assertKnown('jira:example/ANY-1')).toThrow(/No connection is configured/)
  })

  it('names the configured sites in the message', () => {
    /*
     * The caller is usually a model, and "unknown site" alone leaves it choosing
     * between a typo, a missing connection, and a key format it has
     * misremembered. The list collapses all three.
     *
     * Nothing is disclosed by saying them: they are the operator's own
     * configured sites, which the caller is already talking to.
     */
    expect(() => check().assertKnown('jira:example/ANY-1')).toThrow(/example\.atlassian\.net/)
  })
})

describe('what must keep working', () => {
  it('permits an issue the mirror has never held, under a configured site', () => {
    // FR-131. This is the case the whole check is shaped around not breaking:
    // an agent may set focus, or attach a note, before the sync that would
    // fetch the ticket.
    expect(() => check().assertKnown('jira:example.atlassian.net/NOPE-9999')).not.toThrow()
  })

  it('ignores every key that is not a ticket key', () => {
    for (const key of ['session:claude-code/run-1', 'gh:acme/mercury#4', 'repo:origin#main']) {
      expect(() => check().assertKnown(key), key).not.toThrow()
    }
  })

  it('says nothing at all when no connection is configured yet', () => {
    /*
     * The same three-state reasoning `subjectPresence` uses: an empty list is
     * "this machine cannot answer yet", not "every site is wrong".
     *
     * A fresh install whose agent writes a note before the operator has added a
     * connection must not have that note refused — and there would be no sites
     * to name in the error, which is most of what makes it useful.
     */
    expect(() => check([]).assertKnown('jira:anything/ENG-1')).not.toThrow()
  })

  it('is case-insensitive about the configured side too', () => {
    // A connection stored with a shouted host must not refuse a correctly
    // written key.
    expect(() => check(['EXAMPLE.ATLASSIAN.NET']).assertKnown('jira:example.atlassian.net/ENG-1'))
      .not.toThrow()
  })

  it('reads the list per call, so adding a connection takes effect at once', () => {
    // Captured rather than read, this would refuse every key written before the
    // first connection was added until the app restarted.
    const sites: string[] = []
    const live = siteCheck({ configuredSites: () => sites })

    // `acme`, not an invented name: the shape scan in `audit-client-refs.ts`
    // flags any `*.atlassian.net` host that is not a known placeholder, and it
    // cannot tell an invented one from a real one. That is the correct
    // behaviour — the fix is to use a placeholder, never to widen the list.
    sites.push('acme.atlassian.net')
    expect(() => live.assertKnown('jira:example.atlassian.net/ENG-1')).toThrow()

    sites.push('example.atlassian.net')
    expect(() => live.assertKnown('jira:example.atlassian.net/ENG-1')).not.toThrow()
  })
})
