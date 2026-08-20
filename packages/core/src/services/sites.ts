import { siteOfTicketKey, type NaturalKey } from '../domain/keys.js'
import { invalid } from '../registry/errors.js'

/**
 * "Could this ticket key ever resolve?" — asked before an authored write.
 *
 * ## The defect this closes
 *
 * A ticket key is `jira:<site>/<ISSUE-KEY>`, and until 2026-08-20 every authored
 * write took one on trust. An agent constructing `jira:acme/ENG-1` from a
 * project's configured URL — a reasonable guess, since the config records
 * `https://acme.atlassian.net` and `acme` reads like a site name — got a `200`,
 * a stored note, `orphaned: true`, and a note nobody would ever see. The
 * resolver could already tell: `work.get` on the same key answered `not_found`.
 * The write path simply never asked.
 *
 * ## Why the check is on the site and not on the ticket
 *
 * **An unknown *issue* under a known site stays permitted, and that is the whole
 * design.** FR-131 has an agent setting focus on a ticket before the sync that
 * would fetch it, and a note may legitimately be attached to something the
 * mirror has not seen yet. Refusing those would make the order of two unrelated
 * operations matter.
 *
 * An unknown *site* is categorically different: no sync will ever produce it,
 * because nothing is configured to talk to it. It is a typo or a guess, and the
 * only useful moment to say so is the moment it is written.
 *
 * ## Silence when there is nothing to compare against
 *
 * With no connections configured the check does nothing. This is the same
 * three-state reasoning `subjectPresence` uses: an empty list is "this machine
 * cannot answer yet", not "every site is wrong". A fresh install whose agent
 * writes a note before the operator has added a connection must not have that
 * note refused — and there would be no known sites to name in the error anyway,
 * which is most of what makes the error useful.
 */

export interface SiteCheck {
  /**
   * Throws `invalid` when the key names a Jira site no connection knows.
   *
   * A no-op for every other kind of key, and for ticket keys whose site *is*
   * configured — including ones whose issue the mirror has never held.
   */
  assertKnown(key: NaturalKey | string): void
}

export interface SiteCheckDeps {
  /**
   * The sites this machine is configured to talk to.
   *
   * Read per call rather than captured, so a connection added while the app is
   * running takes effect without a restart — the same rule the sync targets and
   * the heartbeat multiplier follow.
   */
  configuredSites(): readonly string[]
}

export function siteCheck(deps: SiteCheckDeps): SiteCheck {
  return {
    assertKnown(key): void {
      const site = siteOfTicketKey(key)
      if (site === null) return

      const known = deps.configuredSites().map((s) => s.toLowerCase())
      if (known.length === 0 || known.includes(site)) return

      /*
       * The error names the sites that *are* configured.
       *
       * The caller is usually a model, and "unknown site" alone leaves it
       * guessing between a typo, a missing connection and a key format it has
       * misremembered. The list turns all three into one glance — and it is the
       * operator's own configured sites, which they have by definition, so
       * nothing is disclosed by saying them back.
       */
      throw invalid(
        `No connection is configured for Jira site '${site}'. ` +
          `Configured sites: ${known.join(', ')}. ` +
          `A ticket key is jira:<site>/<ISSUE-KEY>, where <site> is the full host — ` +
          `'${known[0]}', not its first label.`,
      )
    },
  }
}
