/**
 * Atlassian Document Format, converted to something this application can render
 * as React elements (007/R1, FR-129, FR-130).
 *
 * Jira Cloud's REST v3 returns `description` as ADF — a JSON tree of nodes — not
 * as a string and not as markdown. There were three ways to get renderable
 * content out of it and two of them were refused:
 *
 * - **`expand=renderedFields`**, which returns Jira's own HTML. The renderer's
 *   CSP is `default-src 'none'`, nothing in this codebase uses
 *   `dangerouslySetInnerHTML`, and note bodies render as text in a `<p>`.
 *   Accepting provider HTML would open the first raw-markup path in the
 *   application, from the least trusted source it has.
 * - **An ADF renderer package**, which brings a large React tree and its own
 *   styling into an application with four production dependencies.
 *
 * So: a whitelist, converted here, rendered by `Document.tsx`.
 *
 * ## The whitelist has a fallback, and the fallback has a name
 *
 * **A silently dropped node is the failure this file exists to prevent.** A
 * description whose "Acceptance criteria" section was a `panel` node, omitted
 * because nothing handled it, is a ticket that reads complete and is not — and
 * nothing about the result looks wrong. So anything outside the whitelist
 * becomes an `unsupported` node carrying the original ADF node name, which the
 * renderer draws as a labelled placeholder. It is ugly on purpose.
 *
 * **Marks are the deliberate exception.** An unrecognised *mark* is dropped and
 * its text kept, because a mark carries emphasis and a node carries words:
 * losing `strike` costs a line through some text, losing `panel` costs the
 * acceptance criteria. Those are not the same mistake and do not deserve the
 * same treatment.
 *
 * ## What this module does not do
 *
 * It does not build URLs and it does not decide what may be opened. A link mark
 * carries the provider's own string through to the renderer, which hands it to
 * `links.resolve` like every other URL in the product (FR-077). There is
 * nowhere here that could produce an `<a href>`.
 */

export interface Marks {
  strong: boolean
  em: boolean
  code: boolean
  /** The provider's own string, unvalidated. `links.resolve` is what may open it. */
  href: string | null
}

export type InlineNode =
  | { kind: 'text'; text: string; marks: Marks }
  | { kind: 'break' }
  | { kind: 'unsupported'; nodeType: string }

export interface TableCell {
  header: boolean
  content: DocNode[]
}

export type DocNode =
  | { kind: 'paragraph'; content: InlineNode[] }
  | { kind: 'heading'; level: number; content: InlineNode[] }
  | { kind: 'list'; ordered: boolean; items: DocNode[][] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'quote'; content: DocNode[] }
  | { kind: 'rule' }
  | { kind: 'table'; rows: TableCell[][] }
  | { kind: 'unsupported'; nodeType: string }

/**
 * How deep a document may nest before it is refused.
 *
 * A guard against the stack, not against the author. ADF nests legitimately —
 * a table cell holding a list holding a paragraph is four levels before any of
 * it is unusual — so this sits far above anything a person writes and far below
 * what a recursive descent can survive. Beyond it the node becomes the same
 * labelled placeholder as anything else unrenderable, because "too deep to
 * draw" is a fact about the document and the reader is entitled to it.
 */
const MAX_DEPTH = 24

const NO_MARKS: Marks = { strong: false, em: false, code: false, href: null }

/**
 * Convert a Jira `description` field.
 *
 * `null` means the ticket has no description; `[]` means it has an empty one.
 * They render identically and they are not the same fact, so the distinction
 * survives to the panel rather than being flattened here.
 */
export function fromAdf(value: unknown): DocNode[] | null {
  if (value === null || value === undefined) return null

  /*
   * A plain string is not ADF and is not impossible.
   *
   * Jira Server and Data Center return `description` as wiki markup text, and
   * so does REST v2 on Cloud. This application talks to Cloud v3 and should
   * never see one — but the cost of being wrong about that is a permanently
   * blank panel with nothing in any log to explain it, and the cost of handling
   * it is this paragraph.
   */
  if (typeof value === 'string') {
    return value === '' ? [] : [{ kind: 'paragraph', content: [text(value)] }]
  }

  if (!isNode(value)) return null

  const root = value as AdfNode
  // The root is a `doc`. Anything else is still converted, so a caller handed a
  // fragment gets a document rather than nothing.
  const content = root.type === 'doc' ? childrenOf(root) : [root]
  return blocks(content, 0)
}

/**
 * Every URL a converted description carries, in document order.
 *
 * This is what makes a description link openable without giving the renderer the
 * ability to name a destination. The renderer says "the link on this ticket,
 * this URL"; main asks core for the ticket, builds this set, and opens the URL
 * only if it is in it. So the renderer can still only reach somewhere a provider
 * already put in a ticket the operator can see — which is the property
 * `main/links.ts` is protecting, kept rather than traded away.
 *
 * Duplicates are not removed. The caller wants membership, and a set built from
 * this answers that; stripping them here would cost a pass for nothing.
 */
export function linksIn(nodes: readonly DocNode[]): string[] {
  const found: string[] = []
  collect(nodes, found)
  return found
}

function collect(nodes: readonly DocNode[], into: string[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case 'paragraph':
      case 'heading':
        for (const child of node.content) {
          if (child.kind === 'text' && child.marks.href !== null) into.push(child.marks.href)
        }
        break
      case 'list':
        for (const item of node.items) collect(item, into)
        break
      case 'quote':
        collect(node.content, into)
        break
      case 'table':
        // A link inside a table cell is a link. Missing these would make
        // exactly the links in the most structured part of a description the
        // ones that do not work, which reads as a bug in the table.
        for (const row of node.rows) for (const cell of row) collect(cell.content, into)
        break
      default:
        break
    }
  }
}

interface AdfNode {
  type?: unknown
  content?: unknown
  text?: unknown
  marks?: unknown
  attrs?: unknown
}

function isNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function childrenOf(node: AdfNode): AdfNode[] {
  return Array.isArray(node.content) ? node.content.filter(isNode) : []
}

function attr(node: AdfNode, name: string): unknown {
  return isNode(node.attrs) ? (node.attrs as Record<string, unknown>)[name] : undefined
}

function nameOf(node: AdfNode): string {
  return typeof node.type === 'string' && node.type !== '' ? node.type : 'unknown'
}

function text(value: string, marks: Marks = NO_MARKS): InlineNode {
  return { kind: 'text', text: value, marks }
}

function blocks(nodes: readonly AdfNode[], depth: number): DocNode[] {
  return nodes.map((node) => block(node, depth))
}

function block(node: AdfNode, depth: number): DocNode {
  const type = nameOf(node)
  if (depth > MAX_DEPTH) return { kind: 'unsupported', nodeType: type }

  switch (type) {
    case 'paragraph':
      return { kind: 'paragraph', content: inlines(childrenOf(node), depth + 1) }

    case 'heading': {
      const level = attr(node, 'level')
      return {
        kind: 'heading',
        // Clamped rather than trusted. The renderer picks a tag from this, and
        // an out-of-range level would otherwise become an element that does not
        // exist.
        level: typeof level === 'number' && level >= 1 && level <= 6 ? Math.trunc(level) : 1,
        content: inlines(childrenOf(node), depth + 1),
      }
    }

    case 'bulletList':
    case 'orderedList':
      return {
        kind: 'list',
        ordered: type === 'orderedList',
        // A `listItem` is a container, and its own children are blocks — which
        // is why an item is `DocNode[]` and not a string. A list item holding
        // two paragraphs is ordinary in a ticket.
        items: childrenOf(node).map((item) => blocks(childrenOf(item), depth + 1)),
      }

    case 'codeBlock': {
      const language = attr(node, 'language')
      return {
        kind: 'code',
        language: typeof language === 'string' && language !== '' ? language : null,
        // Marks inside a code block are meaningless and Jira does not emit
        // them; the text is joined flat so the block is one string to render in
        // one `<pre>`.
        text: childrenOf(node)
          .map((child) => (typeof child.text === 'string' ? child.text : ''))
          .join(''),
      }
    }

    case 'blockquote':
      return { kind: 'quote', content: blocks(childrenOf(node), depth + 1) }

    case 'rule':
      return { kind: 'rule' }

    case 'table':
      return {
        kind: 'table',
        rows: childrenOf(node)
          .filter((row) => nameOf(row) === 'tableRow')
          .map((row) =>
            childrenOf(row).map((cell) => ({
              header: nameOf(cell) === 'tableHeader',
              content: blocks(childrenOf(cell), depth + 1),
            })),
          ),
      }

    default:
      return { kind: 'unsupported', nodeType: type }
  }
}

function inlines(nodes: readonly AdfNode[], depth: number): InlineNode[] {
  return nodes.map((node) => inline(node, depth))
}

function inline(node: AdfNode, depth: number): InlineNode {
  const type = nameOf(node)
  if (depth > MAX_DEPTH) return { kind: 'unsupported', nodeType: type }

  switch (type) {
    case 'text':
      return text(typeof node.text === 'string' ? node.text : '', marksOf(node))

    case 'hardBreak':
      return { kind: 'break' }

    case 'mention': {
      // `attrs.text` already carries the `@`. A mention is rendered as the text
      // it stands for rather than as a link: the href would be a Jira profile
      // URL, and "who this is" is the part the reader needs.
      const label = attr(node, 'text')
      return text(typeof label === 'string' && label !== '' ? label : '@unknown')
    }

    case 'inlineCard': {
      // A pasted URL that Jira has decided to render as a card. There is no
      // title in the payload — the card's label is fetched by Jira's own
      // renderer — so the URL is both the text and the target.
      const url = attr(node, 'url')
      return typeof url === 'string' && url !== ''
        ? text(url, { ...NO_MARKS, href: url })
        : { kind: 'unsupported', nodeType: type }
    }

    default:
      return { kind: 'unsupported', nodeType: type }
  }
}

function marksOf(node: AdfNode): Marks {
  if (!Array.isArray(node.marks)) return NO_MARKS

  const marks: Marks = { ...NO_MARKS }
  for (const mark of node.marks) {
    if (!isNode(mark)) continue
    switch (nameOf(mark)) {
      case 'strong':
        marks.strong = true
        break
      case 'em':
        marks.em = true
        break
      case 'code':
        marks.code = true
        break
      case 'link': {
        const href = attr(mark, 'href')
        if (typeof href === 'string' && href !== '') marks.href = href
        break
      }
      // Anything else — `strike`, `underline`, `textColor`, `subsup` — is
      // dropped and its text kept. See the note at the top on why a mark and a
      // node are not treated alike.
      default:
        break
    }
  }

  return marks
}
