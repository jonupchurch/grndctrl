import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'

/**
 * The dialog primitive the design system does not have (T148).
 *
 * Everything else in `styles/` was ported from
 * `resources/design/Ground Control Design System.dc.html`, which stops at the
 * board: rows, lanes, strips, tiles, chips. There is no overlay in it, so this
 * is the one component built rather than transcribed — and it is built from the
 * existing roles (`--raised`, `--line`, `--ink`) rather than from new values, so
 * it inherits both themes without knowing either exists.
 *
 * **It is a native `<dialog>`.** The hand-rolled version of this is a
 * fixed-position `<div>` plus a backdrop, a focus trap, an Esc listener, a
 * scroll lock, and an `aria-modal` attribute — five things to maintain and four
 * of them commonly wrong. `showModal()` supplies all five from the platform: the
 * top layer, the inert background, focus containment, Esc, and the `::backdrop`
 * pseudo-element. The parts worth writing are the ones below.
 *
 * **Esc closes; the backdrop does not.** Both dialogs in this application hold
 * something the operator typed — a note body, a confirmation they are part way
 * through reading — and a stray click on the dimmed board is not a decision to
 * discard it. Esc is a deliberate keystroke and stays. This is a deviation from
 * the light-dismiss convention, and it is on purpose.
 */

export interface ModalProps {
  /** Names the dialog for assistive technology and titles it visually. */
  title: string
  /** A sentence under the title. Optional; most dialogs do not need one. */
  description?: string | undefined
  onClose(): void
  children: ReactNode
  /** Buttons for the footer, in reading order. Primary action last. */
  footer?: ReactNode
  /** Widens the panel for content that needs it — a list of notes, say. */
  size?: 'default' | 'wide'
}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  size = 'default',
}: ModalProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    // `showModal()` rather than the `open` attribute. The attribute renders a
    // dialog that is *not* modal: no top layer, no inert background, no Esc,
    // and the board behind it still takes focus and clicks. They look identical
    // until someone tabs.
    if (!dialog.open) dialog.showModal()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className="modal"
      data-size={size}
      aria-labelledby="modal-title"
      // Esc fires `cancel`, and the default behaviour would close the element
      // while React still believes it is mounted — leaving a dialog that cannot
      // be reopened because its state says it already is. Prevented, and routed
      // through the same `onClose` as the button so there is one path out.
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <div className="modal__panel">
        <header className="modal__head">
          <h2 id="modal-title">{title}</h2>
          {/* Named for the dialog it closes rather than plain "Close". Several
              of these dialogs also carry a "Close" button in the footer, and
              two controls with the same accessible name in one dialog is a
              genuine ambiguity — a screen reader reading the button list would
              announce the same word twice for two different targets. */}
          <button
            type="button"
            className="modal__close"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {description !== undefined && <p className="modal__description">{description}</p>}

        <div className="modal__body">{children}</div>

        {footer !== undefined && <footer className="modal__foot">{footer}</footer>}
      </div>
    </dialog>
  )
}
