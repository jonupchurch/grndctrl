import type { ReactElement } from 'react'
import { Section } from './Section.js'
import { useOperation } from '../query.js'

/**
 * The board cannot refresh itself, and says so (T157 — FR-006, FR-013, XV).
 *
 * This is a different sentence from a stale lane, and it needs to be. A lane
 * reading "last refreshed 4 hours ago" is a fact about the data; this is a fact
 * about the application — it has a connection it cannot use, so that lane is
 * never going to get any newer no matter how long the operator waits or how
 * many times they press Refresh.
 *
 * **`sync.status` already reported this and nothing displayed it.** The
 * operation has carried `unavailable` since M2, it is on the preload's list,
 * and no screen ever called it. So a revoked token produced a board that aged
 * quietly and a Refresh button that completed without complaint.
 *
 * The two reasons are worded differently because the remedies are opposite:
 * signing in again is the answer to one and cannot possibly help with the
 * other. FR-006 also requires saying that nothing is stored anywhere else, so
 * nobody goes looking for a fallback that must not exist.
 */

interface Gap {
  connectionId: string
  reason: 'no-credential' | 'keychain-unavailable'
}

interface Connection {
  id: string
  /**
   * One member, and the label below stopped branching on it.
   *
   * `main/credential.ts` has refused anything but `jira` since M2 and the
   * mirror's CHECK refuses the row since migration 4, so the `: 'GitHub'` arm
   * that was here could not be reached from any state the application can be in.
   * A branch that cannot be taken is not defensive; it is a claim on screen that
   * nothing can produce.
   */
  kind: 'jira'
  siteOrHost: string
  accountLabel: string
}

export function ConnectionNotice({ onOpenSettings }: { onOpenSettings(): void }): ReactElement | null {
  const status = useOperation<{ unavailable: Gap[] }>('sync.status')
  const connections = useOperation<Connection[]>('connections.list')

  const gaps = status.data?.unavailable ?? []
  if (gaps.length === 0) return null

  const keychainDown = gaps.some((g) => g.reason === 'keychain-unavailable')
  const describe = (id: string): string => {
    const connection = (connections.data ?? []).find((c) => c.id === id)
    if (connection === undefined) return id
    return `Jira · ${connection.siteOrHost} (${connection.accountLabel})`
  }

  // The count stays in the header when this region is folded, and it is the case
  // FR-145 is really about: folding a warning must not fold away the fact that
  // there is one. A notice whose gap count vanished when tidied out of the way
  // would turn a fold into a way of not being told the board cannot refresh.
  return (
    <Section
      id="connections"
      title="Connections that cannot refresh"
      className="notice"
      role="status"
      count={gaps.length}
    >
      <p className="notice__lead">
        {keychainDown ? (
          <>
            <strong>The credential store cannot be reached.</strong> Ground Control will not fall
            back to keeping your tokens anywhere else, so the board below is the last data that
            arrived and will not refresh until the keychain is available again.
          </>
        ) : (
          <>
            <strong>
              {gaps.length === 1 ? 'A connection has' : `${gaps.length} connections have`} no stored
              credential.
            </strong>{' '}
            The lanes it feeds are showing the last data that arrived, and will not refresh —
            pressing Refresh cannot help until the credential is added again.
          </>
        )}
      </p>

      <ul className="notice__list">
        {gaps.map((gap) => (
          <li key={gap.connectionId}>{describe(gap.connectionId)}</li>
        ))}
      </ul>

      {/* Named for where it goes rather than "Open settings", which differs from
          the titlebar's "Settings" only by a word nobody reads — two controls
          doing the same thing under almost the same name. */}
      <button type="button" className="ghost" onClick={onOpenSettings}>
        Manage connections
      </button>
    </Section>
  )
}
