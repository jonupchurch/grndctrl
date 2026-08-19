import type { ReactElement } from 'react'

/**
 * Severity as a triple: shape, colour, label (T133 — FR-074, SC-015).
 *
 * Each level gets its own silhouette, and that is the load-bearing part rather
 * than a flourish. Colour alone fails three ways at once here: in greyscale, at
 * the 11px this renders at, and for the ~8% of male developers with a
 * red–green deficiency — for whom `--good` and `--critical` are the *same
 * colour*. On a board whose entire job is "what needs me, at a glance", that is
 * not a nice-to-have.
 *
 * The label is always in the accessibility tree even when it is not on screen,
 * so a screen reader gets "critical" rather than a coloured div, and so
 * `test/e2e/greyscale.spec.ts` can assert every severity is distinguishable by
 * shape and label with colour removed entirely.
 */

export type Severity = 'good' | 'warning' | 'serious' | 'critical'

/** Shape per severity, from the design system's status language. */
const SHAPES: Record<Severity, { clip: string; label: string; use: string }> = {
  good: {
    clip: 'circle(50% at 50% 50%)',
    label: 'Good',
    use: 'Moving, nothing owed',
  },
  warning: {
    clip: 'polygon(50% 0%, 100% 100%, 0% 100%)',
    label: 'Warning',
    use: "Aging past its lane's threshold",
  },
  serious: {
    clip: 'inset(0)',
    label: 'Serious',
    use: 'Stalled, or an agent has gone silent',
  },
  critical: {
    clip: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
    label: 'Critical',
    use: 'Blocked, abandoned, or the provider is down',
  },
}

export interface StatusMarkProps {
  severity: Severity
  /** Render the word beside the shape. Off inside a dense row, on in Attention. */
  showLabel?: boolean
  size?: number
}

export function StatusMark({
  severity,
  showLabel = false,
  size = 10,
}: StatusMarkProps): ReactElement {
  const shape = SHAPES[severity]

  return (
    <span className="status-mark" data-severity={severity} title={shape.use}>
      <span
        className="status-mark__shape"
        style={{ width: size, height: size, clipPath: shape.clip }}
        aria-hidden="true"
      />
      <span className={showLabel ? 'status-mark__label' : 'visually-hidden'}>{shape.label}</span>
    </span>
  )
}

/**
 * Correlation badges: outlined, where status marks are filled.
 *
 * "Fill means state; outline means fact" — an agent either has a session on this
 * ticket or it does not, and that is not a severity. It shares the shape
 * vocabulary with `StatusMark` so the eye learns one alphabet, and it keeps the
 * diamond it has always had.
 *
 * An absent badge is information. "Assigned to me, nothing started" is a row
 * with an empty slot, drawn as a hairline placeholder rather than omitted —
 * omitting it would let the court column slide left and break the alignment the
 * lane is read down.
 *
 * **There were four kinds**: branch, pull request, CI check, agent. Three of them
 * described a code host and a local checkout, and 006 removed both providers. The
 * type is a one-member union rather than a boolean because the *slot* is the
 * abstraction — presence marks in a fixed grid — and that survives its contents
 * being one thing.
 */
export type CorrelationKind = 'agent'

const BADGES: Record<CorrelationKind, { clip: string; label: string }> = {
  agent: { clip: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)', label: 'agent' },
}

export interface CorrelationBadgeProps {
  kind: CorrelationKind
  /** False draws the hairline placeholder — the absence, not nothing. */
  present: boolean
}

export function CorrelationBadge({ kind, present }: CorrelationBadgeProps): ReactElement {
  const badge = BADGES[kind]

  return (
    <span
      className="badge"
      data-kind={kind}
      data-present={present}
      title={present ? badge.label : `no ${badge.label}`}
    >
      <span className="badge__shape" style={{ clipPath: badge.clip }} aria-hidden="true" />
      <span className="visually-hidden">{present ? badge.label : `no ${badge.label}`}</span>
    </span>
  )
}
