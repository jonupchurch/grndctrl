import { openSubject } from './bridge.js'

/**
 * Everything is a launcher (T146 — FR-075).
 *
 * Every row on this board opens its provider page in the operator's browser, and
 * **the application never navigates**. There is one page; clicking a ticket does
 * not take you to a ticket screen, because a second copy of Jira rendered worse
 * is not what this is for. What the board knows that Jira does not is how a
 * ticket relates to a branch, a pull request and an agent — and that is the
 * whole screen you are already looking at.
 *
 * The renderer never handles a URL. It names a subject and a target; main
 * resolves it through `links.resolve` and hands only the result to the OS
 * (`main/links.ts`). So this module is thin on purpose: the interesting part is
 * that there is nowhere here to put a URL.
 */

export type LinkTarget =
  | 'default'
  | 'ticket'
  | 'pull-request'
  | 'repository'
  | 'branch'
  | 'documentation'
  | 'check'

/**
 * A launch failure is reported, not swallowed.
 *
 * The realistic cause is a branch the code host has never seen, where
 * `links.resolve` falls back to the repository — that succeeds, and the UI says
 * so. A genuine failure means the subject resolved to nothing, and an operator
 * who clicked a row and saw *nothing at all* happen would reasonably conclude
 * the application is broken.
 */
export async function launch(
  subjectKey: string,
  target: LinkTarget = 'default',
  onFailure?: (message: string) => void,
): Promise<void> {
  try {
    await openSubject(subjectKey, target)
  } catch (e) {
    onFailure?.(e instanceof Error ? e.message : 'That link could not be opened.')
  }
}
