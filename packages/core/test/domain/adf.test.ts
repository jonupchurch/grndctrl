import { describe, expect, it } from 'vitest'
import { fromAdf, type DocNode } from '../../src/domain/adf.js'

/**
 * The ADF converter, one case per node kind (T126 — FR-129, FR-130).
 *
 * The assertion that carries the most weight is the last group: **an
 * unrecognised node becomes a placeholder that names it, and is never dropped.**
 * A description whose "Acceptance criteria" section was a `panel` node, silently
 * omitted, is a ticket that reads complete and is not — and there is nothing on
 * the screen to suggest anything is missing. Every other test here would pass
 * against a converter that did that.
 *
 * Probed as T126 asks: with the `default` arm changed to drop the node instead
 * of labelling it, exactly the placeholder tests fail and the rest stay green.
 */

const doc = (...content: unknown[]): unknown => ({ type: 'doc', version: 1, content })
const para = (...content: unknown[]): unknown => ({ type: 'paragraph', content })
const t = (text: string, marks?: unknown[]): unknown => ({ type: 'text', text, ...(marks ? { marks } : {}) })

/** The text of a converted document, flattened — for asserting nothing was lost. */
function words(nodes: readonly DocNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'paragraph':
        case 'heading':
          return node.content.map((i) => (i.kind === 'text' ? i.text : '')).join('')
        case 'code':
          return node.text
        case 'quote':
          return words(node.content)
        case 'list':
          return node.items.map(words).join(' ')
        case 'table':
          return node.rows.map((row) => row.map((cell) => words(cell.content)).join(' ')).join(' ')
        default:
          return ''
      }
    })
    .join(' ')
}

describe('nothing at all', () => {
  it('tells a missing description from an empty one', () => {
    // They render identically and they are different facts. Flattening them here
    // would mean the panel could never say "this ticket has no description"
    // rather than "this description is blank".
    expect(fromAdf(null)).toBeNull()
    expect(fromAdf(undefined)).toBeNull()
    expect(fromAdf(doc())).toEqual([])
  })

  it('takes a plain string, which Cloud v3 should never send', () => {
    // Server, Data Center and REST v2 all return wiki markup text. This client
    // talks to Cloud v3 — but being wrong about that would give a permanently
    // blank panel with nothing to explain it.
    expect(fromAdf('Just some text')).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: 'Just some text', marks: expect.anything() }] },
    ])
    expect(fromAdf('')).toEqual([])
  })
})

describe('each supported node kind', () => {
  it('paragraph and text', () => {
    expect(fromAdf(doc(para(t('The limiter warms lazily.'))))).toEqual([
      {
        kind: 'paragraph',
        content: [
          { kind: 'text', text: 'The limiter warms lazily.', marks: { strong: false, em: false, code: false, href: null } },
        ],
      },
    ])
  })

  it('heading, with the level clamped rather than trusted', () => {
    const converted = fromAdf(
      doc(
        { type: 'heading', attrs: { level: 3 }, content: [t('Acceptance criteria')] },
        // The renderer picks a tag from this number. Out of range would become
        // an element that does not exist.
        { type: 'heading', attrs: { level: 99 }, content: [t('Nonsense')] },
        { type: 'heading', content: [t('No level at all')] },
      ),
    )

    expect(converted?.map((n) => (n.kind === 'heading' ? n.level : null))).toEqual([3, 1, 1])
  })

  it('the four marks it keeps', () => {
    const converted = fromAdf(
      doc(
        para(
          t('bold', [{ type: 'strong' }]),
          t('italic', [{ type: 'em' }]),
          t('mono', [{ type: 'code' }]),
          t('a link', [{ type: 'link', attrs: { href: 'https://example.com/x' } }]),
        ),
      ),
    )

    const first = converted?.[0]
    expect(first?.kind).toBe('paragraph')
    const marks = first?.kind === 'paragraph' ? first.content.map((i) => (i.kind === 'text' ? i.marks : null)) : []

    expect(marks[0]).toMatchObject({ strong: true })
    expect(marks[1]).toMatchObject({ em: true })
    expect(marks[2]).toMatchObject({ code: true })
    // The provider's own string, carried through untouched. Nothing here decides
    // whether it may be opened — that is `links.resolve`, in one place (FR-077).
    expect(marks[3]).toMatchObject({ href: 'https://example.com/x' })
  })

  it('drops a mark it does not know and keeps the text', () => {
    // Deliberately unlike the node rule. A mark carries emphasis; a node carries
    // words. Losing `strike` costs a line through some text and losing `panel`
    // costs the acceptance criteria, and those are not the same mistake.
    const converted = fromAdf(doc(para(t('struck', [{ type: 'strike' }, { type: 'strong' }]))))

    expect(words(converted ?? [])).toBe('struck')
    const first = converted?.[0]
    expect(first?.kind === 'paragraph' && first.content[0]?.kind === 'text' && first.content[0].marks).toMatchObject({
      strong: true,
    })
  })

  it('bullet and ordered lists, whose items hold blocks', () => {
    const list = (type: string): unknown => ({
      type,
      content: [
        { type: 'listItem', content: [para(t('one')), para(t('still one'))] },
        { type: 'listItem', content: [para(t('two'))] },
      ],
    })

    const converted = fromAdf(doc(list('bulletList'), list('orderedList')))

    expect(converted?.map((n) => (n.kind === 'list' ? n.ordered : null))).toEqual([false, true])
    const first = converted?.[0]
    // An item is a list of blocks, not a string: two paragraphs in one bullet is
    // ordinary in a ticket, and joining them would lose the break between them.
    expect(first?.kind === 'list' && first.items[0]).toHaveLength(2)
    expect(words(converted ?? [])).toContain('one still one')
  })

  it('code blocks, with the language when there is one', () => {
    const converted = fromAdf(
      doc(
        { type: 'codeBlock', attrs: { language: 'sql' }, content: [t('SELECT 1;')] },
        { type: 'codeBlock', content: [t('no language')] },
      ),
    )

    expect(converted?.[0]).toEqual({ kind: 'code', language: 'sql', text: 'SELECT 1;' })
    expect(converted?.[1]).toEqual({ kind: 'code', language: null, text: 'no language' })
  })

  it('blockquote and rule', () => {
    const converted = fromAdf(doc({ type: 'blockquote', content: [para(t('quoted'))] }, { type: 'rule' }))

    expect(converted?.[0]).toEqual({ kind: 'quote', content: [{ kind: 'paragraph', content: [expect.anything()] }] })
    expect(converted?.[1]).toEqual({ kind: 'rule' })
  })

  it('tables, keeping which cells are headers', () => {
    const converted = fromAdf(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para(t('Field'))] },
              { type: 'tableHeader', content: [para(t('Value'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [para(t('timeout'))] },
              { type: 'tableCell', content: [para(t('30s'))] },
            ],
          },
        ],
      }),
    )

    const table = converted?.[0]
    expect(table?.kind).toBe('table')
    if (table?.kind !== 'table') throw new Error('not a table')

    expect(table.rows).toHaveLength(2)
    expect(table.rows[0]?.every((c) => c.header)).toBe(true)
    expect(table.rows[1]?.every((c) => c.header)).toBe(false)
    expect(words(converted ?? [])).toContain('timeout 30s')
  })

  it('mentions, as the text they stand for', () => {
    // Not as a link. The href would be a Jira profile URL, and who this is is
    // the part the reader needs.
    const converted = fromAdf(
      doc(para({ type: 'mention', attrs: { id: 'abc-123', text: '@Jane Okafor' } }, { type: 'mention', attrs: { id: 'x' } })),
    )

    expect(words(converted ?? [])).toBe('@Jane Okafor@unknown')
  })

  it('inline cards, as a link to themselves', () => {
    const converted = fromAdf(doc(para({ type: 'inlineCard', attrs: { url: 'https://example.com/PR-1' } })))

    const first = converted?.[0]
    expect(first?.kind === 'paragraph' && first.content[0]).toEqual({
      kind: 'text',
      text: 'https://example.com/PR-1',
      marks: { strong: false, em: false, code: false, href: 'https://example.com/PR-1' },
    })
  })
})

describe('anything else', () => {
  /*
   * The group T126 is about, and the one the others cannot substitute for.
   *
   * Every unsupported-node assertion below would also pass if the node had been
   * kept and rendered wrongly. What none of them tolerate is the node being
   * *dropped* — which is the outcome that looks like success on screen.
   */
  it('becomes a placeholder that names the node', () => {
    const converted = fromAdf(
      doc(
        para(t('Before.')),
        { type: 'panel', attrs: { panelType: 'info' }, content: [para(t('Acceptance criteria'))] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
        { type: 'expand', attrs: { title: 'Details' }, content: [para(t('hidden'))] },
        para(t('After.')),
      ),
    )

    expect(converted).toHaveLength(5)
    expect(converted?.map((n) => (n.kind === 'unsupported' ? n.nodeType : n.kind))).toEqual([
      'paragraph',
      'panel',
      'mediaSingle',
      'expand',
      'paragraph',
    ])
  })

  it('keeps its position, so the document is not silently reordered', () => {
    // The placeholder sits where the node was. A converter that collected the
    // unsupported ones and appended them would pass the test above and put the
    // acceptance criteria after the closing paragraph.
    const converted = fromAdf(doc(para(t('a')), { type: 'panel' }, para(t('b'))))
    expect(converted?.[1]?.kind).toBe('unsupported')
  })

  it('names an inline node too', () => {
    const converted = fromAdf(doc(para(t('see '), { type: 'status', attrs: { text: 'DONE' } })))

    const first = converted?.[0]
    expect(first?.kind === 'paragraph' && first.content[1]).toEqual({
      kind: 'unsupported',
      nodeType: 'status',
    })
  })

  it('has a name even when the node does not', () => {
    // A node with no `type` is malformed rather than unknown, and the reader
    // still has to be told something was there.
    expect(fromAdf(doc({ content: [] }))?.[0]).toEqual({ kind: 'unsupported', nodeType: 'unknown' })
  })
})

describe('a document that is trying to be a problem', () => {
  it('refuses to recurse forever, and says so where it stopped', () => {
    // Not a guard against the author — a table cell holding a list holding a
    // paragraph is four levels before anything is unusual. This is a guard
    // against the stack, and "too deep to draw" is a fact the reader is
    // entitled to rather than a blank.
    let node: unknown = para(t('bottom'))
    for (let i = 0; i < 60; i++) node = { type: 'blockquote', content: [node] }

    const converted = fromAdf(doc(node))
    expect(converted).not.toBeNull()

    let depth = 0
    let cursor = converted?.[0]
    while (cursor?.kind === 'quote') {
      depth++
      cursor = cursor.content[0]
    }
    expect(depth).toBeLessThan(60)
    expect(cursor?.kind).toBe('unsupported')
  })

  it('survives content that is not what ADF says it is', () => {
    // Everything on the wire is `unknown`. A converter that trusted the shape
    // would throw inside a sync and take the whole ticket lane down over one
    // malformed description.
    expect(() => fromAdf({ type: 'doc', content: 'not an array' })).not.toThrow()
    expect(() => fromAdf({ type: 'doc', content: [null, 42, 'x'] })).not.toThrow()
    expect(() => fromAdf({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text' }] }] })).not.toThrow()
    expect(fromAdf(42)).toBeNull()
  })
})
