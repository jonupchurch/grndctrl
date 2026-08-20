/**
 * The one place a URL becomes an action the operating system takes.
 *
 * "Everything is a launcher" (FR-075) means every row on the board opens a page,
 * and every one of those URLs came from a provider — a ticket's `self` link, a
 * check run's `details_url`. That is hostile input arriving over the network and
 * ending at `shell.openExternal`, which will happily hand a `file:` URL to
 * Explorer or a custom scheme to whatever registered it.
 *
 * So the renderer never passes a URL. It passes a subject key and a target, main
 * resolves them through `links.resolve` — core's scheme check, tested with no UI
 * around it (FR-077) — and opens only what core handed back. A renderer with a
 * cross-site script in it cannot ask for a URL of its own; there is no argument
 * to put one in.
 *
 * The second check below duplicates core's on purpose. Two independent checks
 * either side of a process boundary is the correct amount for the line where a
 * string becomes an OS-level action, and this one is three lines.
 */

import { linksIn, type DocNode } from '@grndctrl/core'

export interface OpenRequest {
  subjectKey: string
  target?: string | undefined
}

export interface OpenResult {
  url: string
  /** True when the exact page did not exist and something broader was opened. */
  fellBack: boolean
}

export interface LinkOpenerOptions {
  dispatch(operation: string, payload: unknown): Promise<unknown>
  /** `shell.openExternal`, injected so this is testable without a display. */
  openExternal(url: string): Promise<void>
}

export function linkOpener(options: LinkOpenerOptions) {
  return async function open(request: OpenRequest): Promise<OpenResult> {
    const resolved = (await options.dispatch('links.resolve', {
      subjectKey: request.subjectKey,
      ...(request.target === undefined ? {} : { target: request.target }),
    })) as OpenResult

    if (!isHttps(resolved.url)) {
      // Reachable only if core's own check regressed. Saying so plainly beats a
      // silent no-op, because the failure mode being guarded against here is
      // precisely the one nobody would think to look for.
      throw new Error(`Refusing to open a non-https URL for ${request.subjectKey}.`)
    }

    await options.openExternal(resolved.url)
    return resolved
  }
}

export interface OpenDescriptionLinkRequest {
  /** The ticket whose description is supposed to contain the URL. */
  subjectKey: string
  url: string
}

/**
 * The narrow second capability: open a link a ticket description contains.
 *
 * Everything above rests on the renderer having nowhere to put a URL. A ticket
 * description breaks that cleanly — its links are arbitrary provider URLs and
 * are not subjects of anything — so rather than adding a URL argument to the
 * launcher and hoping the scheme check holds, this asks core what that ticket's
 * description actually says and **refuses anything not in it**.
 *
 * What the renderer gains is the ability to point at a link the operator can
 * already see on their own board. What it does not gain is the ability to name a
 * destination: an injected script can send any string it likes and every string
 * that is not in that description is refused, on main's side, against core's
 * copy rather than the page's.
 *
 * The scheme check still runs afterwards. A provider that put a `javascript:`
 * URL in a description would otherwise have written the membership test's answer
 * for it, and two checks either side of the boundary is the right number for the
 * line where a string becomes an OS-level action.
 */
export function descriptionLinkOpener(options: LinkOpenerOptions) {
  return async function openDescriptionLink(
    request: OpenDescriptionLinkRequest,
  ): Promise<OpenResult> {
    const envelope = (await options.dispatch('work.get', { key: request.subjectKey })) as {
      data?: { ticket?: { description?: DocNode[] | null } }
    }

    const description = envelope.data?.ticket?.description ?? []
    if (!linksIn(description).includes(request.url)) {
      // Deliberately says the rule rather than the URL. This message can reach a
      // log, and the string being refused is the one thing here that came from
      // outside.
      throw new Error(`That link is not in ${request.subjectKey}'s description.`)
    }

    if (!isHttps(request.url)) {
      throw new Error('Refusing to open a non-https link.')
    }

    await options.openExternal(request.url)
    return { url: request.url, fellBack: false }
  }
}

function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}
