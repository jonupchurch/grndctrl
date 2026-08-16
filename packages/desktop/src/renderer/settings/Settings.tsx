import type { ReactElement } from 'react'
import { Connections } from './Connections.js'
import { Projects } from './Projects.js'

/**
 * Settings, as a view rather than a dialog (T153).
 *
 * FR-069 makes the *board* a single page and FR-070 makes project selection a
 * filter rather than navigation — neither says the application may have only one
 * view, and this is not the board. Two reasons it is not a modal: the design
 * system has no dialog primitive and building one here would pre-empt T148,
 * whose entire point is that the dialog is a considered new component; and
 * connections plus project bindings plus checkout paths is more than a dialog
 * should hold anyway.
 *
 * Until this existed there was no way to configure the application from inside
 * it. `packages/desktop/scripts/bind-project.mjs` and `grndctrl-cli credential`
 * were the only routes, which is fine for the people building it and useless to
 * anyone else.
 */

export function Settings({ onClose }: { onClose(): void }): ReactElement {
  return (
    <main className="settings">
      <header className="settings__head">
        <h1>Settings</h1>
        <button type="button" className="ghost" onClick={onClose}>
          Back to the board
        </button>
      </header>

      <Connections />
      <Projects />
    </main>
  )
}
