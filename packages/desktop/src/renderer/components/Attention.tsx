import type { ReactElement } from 'react'
import { formatAge } from './StaleBar.js'
import { StatusMark } from './StatusMark.js'
import { launch } from '../launch.js'
import type { DriftFinding, Note } from '../types.js'

/**
 * Attention: the two things that will not surface themselves (T144).
 *
 * **Drift findings** — a merged pull request against an open ticket, a branch
 * with no ticket, an agent session with no transition. Nobody's tool reports
 * these, because each system is individually correct: Jira is right that the
 * ticket is open, GitHub is right that the PR merged. Only something looking at
 * both sees the disagreement, which is what this application is for.
 *
 * **Question nudges** — `question-for-human` notes an agent wrote and is now
 * waiting on. An agent blocked on a question is the most expensive kind of idle
 * there is, and without this it stays blocked until someone happens to look at
 * that session.
 *
 * Both carry **age** and **both sides of the evidence**. A drift strip that said
 * only "MERC-1184 is drifting" would send the operator to check the same two
 * systems the application already checked; naming the two facts and when each
 * was true is what makes it actionable without leaving the board.
 */

export interface AttentionProps {
  findings: readonly DriftFinding[]
  questions: readonly Note[]
  now?: Date
  /** Opens the confirmation flow. Absent until T151, and the button says so. */
  onDispatch?: ((finding: DriftFinding) => void) | undefined
}

export function Attention({
  findings,
  questions,
  now,
  onDispatch,
}: AttentionProps): ReactElement | null {
  const total = findings.length + questions.length
  if (total === 0) return null

  return (
    <section className="attention" aria-label="Attention">
      <header className="attention__head">
        <h2>Attention</h2>
        <span className="attention__count">
          {findings.length} drift · {questions.length} nudge{questions.length === 1 ? '' : 's'}
        </span>
        <span className="attention__hint">two sources disagree · resolve here</span>
      </header>

      {findings.map((finding) => (
        <div key={finding.id} className="strip" data-kind="drift">
          <StatusMark severity="critical" />

          <div className="strip__body">
            <span className="strip__label">Drift · {finding.rule}</span>
            <button
              type="button"
              className="strip__text"
              onClick={() => void launch(finding.subjectKey)}
            >
              {finding.summary}
            </button>

            {/* Both sides, each with when it was true. This is the part that
                stops the operator having to go and check Jira and GitHub
                themselves to find out which one is wrong. */}
            <ul className="strip__evidence">
              {finding.evidence.map((e, i) => (
                <li key={`${finding.id}-${i}`}>
                  <span className="strip__side">{e.side}</span>
                  {e.fact}
                  {e.at !== null && <span className="strip__when"> · {formatAge(e.at, now)}</span>}
                </li>
              ))}
            </ul>
          </div>

          <span className="strip__age">{formatSeconds(finding.ageSec)}</span>

          {finding.suggestedAction !== null && (
            <button
              type="button"
              className="strip__action"
              disabled={!finding.dispatchable || onDispatch === undefined}
              title={
                finding.dispatchable
                  ? 'Dispatch this to an agent — you will be asked to confirm'
                  : 'No agent is connected that can perform this'
              }
              onClick={() => onDispatch?.(finding)}
            >
              {finding.suggestedAction.label}
            </button>
          )}
        </div>
      ))}

      {questions.map((note) => (
        <div key={note.id} className="strip" data-kind="nudge">
          <StatusMark severity="warning" />

          <div className="strip__body">
            <span className="strip__label">
              Question{note.authorId === null ? '' : ` · ${note.authorId}`}
            </span>
            <button
              type="button"
              className="strip__text"
              onClick={() => void launch(note.subjectKey)}
            >
              {note.body}
            </button>
          </div>

          <span className="strip__age">{formatAge(note.createdAt, now)}</span>
        </div>
      ))}
    </section>
  )
}

function formatSeconds(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`

  const hours = Math.floor(seconds / 3600)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  return days < 7 ? `${days}d ${String(hours % 24).padStart(2, '0')}h` : `${days}d`
}
