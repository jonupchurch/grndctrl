import { useCallback, useState, type ReactElement } from 'react'
import { copyPrompt } from '../bridge.js'
import { EmptyState } from '../components/EmptyState.js'
import { Section } from '../components/Section.js'
import { formatAge } from '../components/StaleBar.js'
import type { Prompt } from '../types.js'

/**
 * Recent prompts, one click from the clipboard (FR-136 to FR-141).
 *
 * ## The row shows a preview and the clipboard gets the whole thing
 *
 * The preview is cut **here, in JavaScript**, rather than with a CSS ellipsis —
 * and the difference is worth the two lines. With CSS the full text sits in the
 * DOM and merely looks short, so a copy path that read the rendered element
 * would appear to work; cutting it here means the rendered row genuinely does
 * not contain the rest of the prompt, and the only place the whole text can come
 * from is the store. That is FR-139 made visible rather than promised, and it is
 * what `prompts.spec.ts` asserts: the row is short and the clipboard is long.
 *
 * ## Copying confirms, and failing says so
 *
 * Both halves of FR-138. The confirmation names a **character count**, because
 * that number came back off the clipboard in main (`main/clipboard.ts`) — "1,240
 * characters" is a claim about the clipboard, where "Copied!" is a claim about
 * the click, and the two differ exactly when it matters. A failure replaces the
 * confirmation with the reason, in the row, rather than disappearing: a copy
 * that quietly did nothing is discovered at the paste, in another application,
 * long after there is anything to connect it to.
 *
 * ## Delete is here and there is no edit
 *
 * FR-140, and the reason is what a prompt contains: an agent records what it was
 * given, which may include a token somebody pasted. So the operator can remove
 * one. There is no edit anywhere, on any surface — a corrected prompt would make
 * this panel's copy button reproduce something that was never sent.
 */

/**
 * How much of a prompt a row shows.
 *
 * Enough to recognise which prompt it is, which is the requirement, and no more
 * — the panel is a side column and a prompt is often a paragraph. Recognition
 * needs the opening words; nothing needs the middle.
 */
const PREVIEW = 160

export interface PromptsProps {
  prompts: readonly Prompt[]
  /** Removes it. The panel refetches from the `prompts:changed` push, not from here. */
  onDelete(id: string): void
  now?: Date
}

interface Acknowledgement {
  id: string
  /** Characters read back off the clipboard, or null when the copy failed. */
  length: number | null
  message?: string
}

export function Prompts({ prompts, onDelete, now }: PromptsProps): ReactElement {
  const [said, setSaid] = useState<Acknowledgement | null>(null)

  const copy = useCallback((id: string) => {
    // Cleared first, so a second click on a row that just failed does not read
    // as the old answer while the new one is in flight.
    setSaid(null)
    copyPrompt(id)
      .then(({ length }) => setSaid({ id, length }))
      .catch((e: unknown) =>
        setSaid({
          id,
          length: null,
          message: e instanceof Error ? e.message : 'Could not copy that prompt.',
        }),
      )
  }, [])

  return (
    <Section id="prompts" title="Recent prompts" className="lane" count={prompts.length}>
      {prompts.length === 0 ? (
        <EmptyState title="No prompts recorded">
          {/*
            FR-141. Nothing records a prompt until an agent is configured to, so
            an empty panel here is the *expected* state on a fresh install and
            has to read as "not wired up yet" rather than "broken". It names the
            tool, because the operator's next action is to put that name in front
            of an agent.
          */}
          Agents record these through <code>grndctrl-mcp</code>, with{' '}
          <code>grndctrl_record_prompt</code>. Once one does, a prompt worth keeping appears here and
          one click copies it whole.
        </EmptyState>
      ) : (
        prompts.map((prompt) => {
          const acknowledged = said?.id === prompt.id ? said : null
          const preview =
            prompt.text.length > PREVIEW ? `${prompt.text.slice(0, PREVIEW)}…` : prompt.text

          return (
            <div key={prompt.id} className="prompt" data-prompt={prompt.id}>
              <button
                type="button"
                className="prompt__copy"
                onClick={() => copy(prompt.id)}
                // The whole prompt is not on screen; this is what tells a screen
                // reader, and anyone hovering, that the button takes all of it.
                title="Copy the whole prompt"
              >
                <span className="prompt__text">{preview}</span>
              </button>

              <span className="prompt__agent">{prompt.agentId}</span>
              <span className="prompt__age">{formatAge(prompt.recordedAt, now)}</span>

              {/*
                A separate control rather than a swipe, a menu or a long press.
                Deleting is the operator's answer to "that one has a secret in
                it", and an answer that takes discovering is not one.
              */}
              <button
                type="button"
                className="prompt__delete"
                aria-label="Delete this prompt"
                onClick={() => onDelete(prompt.id)}
              >
                ×
              </button>

              {acknowledged === null ? null : (
                /*
                 * `role="status"` so it is announced rather than only drawn. The
                 * confirmation is the requirement, not the decoration, and a
                 * confirmation only sighted users receive is half of one.
                 */
                <span
                  className={acknowledged.length === null ? 'prompt__failed' : 'prompt__copied'}
                  role="status"
                >
                  {acknowledged.length === null
                    ? acknowledged.message
                    : `Copied ${acknowledged.length.toLocaleString()} characters`}
                </span>
              )}
            </div>
          )
        })
      )}
    </Section>
  )
}
