import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react'

/**
 * One failing lane must not blank the others (T141 — XV).
 *
 * The rule this enforces is React's, not the product's: an error thrown during
 * render unmounts the *whole tree* unless something catches it. So without a
 * boundary here, one malformed pull request — a null where a string was
 * expected, a status nobody has seen before — takes down the tickets, the agent
 * sessions and the drift findings along with it. The operator's entire board
 * goes white because GitHub returned something odd.
 *
 * That is the same failure XV cares about at the provider level, arriving from a
 * different direction, and it needs the same answer: the lane that broke says
 * so, and everything else keeps working.
 *
 * It is a class component because that is the only thing React gives an error
 * boundary. There is no hook for this.
 */

interface Props {
  /** Named in the message, so "which lane broke" is answerable from a screenshot. */
  lane: string
  children: ReactNode
}

interface State {
  error: Error | null
}

export class LaneBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // To the console, not to anywhere else. There is no telemetry in this
    // application and this is exactly the kind of place one arrives — a crash
    // reporter is the most reasonable-sounding way to start sending an
    // operator's ticket titles off their machine (XI).
    console.error(`The ${this.props.lane} lane failed to render.`, error, info.componentStack)
  }

  override render(): ReactElement | ReactNode {
    if (this.state.error === null) return this.props.children

    return (
      <div className="lane-failed" role="alert">
        <p>
          The {this.props.lane} lane could not be displayed. The rest of the board is unaffected.
        </p>
        <p className="lane-failed__detail">{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
