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

function isHttps(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'https:'
  } catch {
    return false
  }
}
