import type { ReactElement } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { Section } from '../components/Section.js'
import { formatAge } from '../components/StaleBar.js'
import type { AgentUpdate, Note } from '../types.js'

/**
 * What the agents have said (FR-132, FR-134, FR-135).
 *
 * **Text, agent, age. Nothing else.** No card, no border, no icon, no title, no
 * menu, no timestamp tooltip, no expand. The operator asked for terse, and terse
 * is a constraint here rather than a starting point — every one of those
 * additions is individually defensible and collectively the reason nobody reads
 * a feed. The text is bounded at the operation's schema, which is what makes
 * this renderable as one line rather than hoped to be.
 *
 * **Open questions sit at the top, and they are not updates.** This is 006's
 * FR-121 coming due: a `question-for-human` note already moved its work item's
 * ball-in-court to the operator and already put its session into `needs-you`,
 * but the *list* of them lived in the Attention region and went with it. It
 * lands here because this is the panel about agents talking, and a question is
 * the one thing an agent says that is owed an answer.
 *
 * They are visually distinct and above the stream on purpose: an update is
 * something to read, a question is something to do. Sorting them into one
 * chronological list by `postedAt` would bury the only actionable item under
 * whatever the agent said afterwards, which is exactly what happens in practice
 * — an agent that asks a question then keeps working produces the updates that
 * hide it.
 */

export interface AgentUpdatesProps {
  updates: readonly AgentUpdate[]
  /** Unresolved `question-for-human` notes. Already filtered by the caller. */
  questions: readonly Note[]
  /** Opens the note, so the operator can answer where the question was asked. */
  onOpenQuestion(subjectKey: string, label: string): void
  now?: Date
}

export function AgentUpdates({
  updates,
  questions,
  onOpenQuestion,
  now,
}: AgentUpdatesProps): ReactElement {
  const empty = updates.length === 0 && questions.length === 0

  return (
    <Section
      id="updates"
      title="Agent updates"
      className="lane"
      // The count is the stream. Questions are counted where they are drawn,
      // because a single number covering both would make "3" mean two different
      // things depending on which the operator was looking for.
      count={updates.length}
      {...(questions.length === 0
        ? {}
        : { meta: `${questions.length} awaiting you` })}
    >
      {empty ? (
        <EmptyState title="Nothing said yet">
          Agents post here through <code>grndctrl-mcp</code>, with{' '}
          <code>grndctrl_post_update</code>. A question an agent asks you appears here too.
        </EmptyState>
      ) : (
        <>
          {questions.map((question) => (
            <button
              key={question.id}
              type="button"
              className="update update--question"
              onClick={() => onOpenQuestion(question.subjectKey, question.subjectKey)}
            >
              <span className="update__text">{question.body}</span>
              {/* The author of a question is a person or an agent, and the
                  difference matters here more than it does above: an agent's
                  question is one you answer, and your own is one you left. */}
              <span className="update__agent">{question.authorId ?? question.authorKind}</span>
              <span className="update__age">{formatAge(question.updatedAt, now)}</span>
            </button>
          ))}

          {updates.map((update) => (
            <div key={update.id} className="update">
              <span className="update__text">{update.text}</span>
              <span className="update__agent">{update.agentId}</span>
              <span className="update__age">{formatAge(update.postedAt, now)}</span>
            </div>
          ))}
        </>
      )}
    </Section>
  )
}
