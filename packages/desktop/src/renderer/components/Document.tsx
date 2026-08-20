import type { ReactElement, ReactNode } from 'react'
import type { DocNode, InlineNode } from '../types.js'

/**
 * A converted ticket description, as React elements (T125 — FR-129, FR-130).
 *
 * **No `dangerouslySetInnerHTML`, no HTML string, no exceptions.** The renderer's
 * CSP is `default-src 'none'` and nothing in this application has ever put
 * provider markup on the page; a ticket description is the least trusted input
 * it handles and would be the worst place to start. What arrives here is the
 * whitelisted node tree from `domain/adf.ts`, already converted at ingest, and
 * every branch below produces an element rather than a string.
 *
 * **An `unsupported` node renders as a labelled placeholder** naming the node it
 * stands for. That is the point of it: a description whose acceptance criteria
 * were in a `panel` node reads as complete when the node is dropped, and there
 * is nothing on the screen to suggest otherwise. The placeholder is ugly and is
 * meant to be.
 *
 * ## Links are shown and are not clickable, and that is a decision
 *
 * `main/links.ts` is emphatic that the renderer never passes a URL: it passes a
 * subject key, main resolves it through `links.resolve`, and only what core
 * returned is handed to the OS. Its own words are that a renderer with a script
 * in it "cannot ask for a URL of its own; there is no argument to put one in."
 *
 * A link inside a description is an arbitrary provider URL and is not a subject,
 * so making it clickable means adding that argument. Guarded by an https check
 * it is not catastrophic — but it converts "the renderer cannot name a
 * destination" into "the renderer can name any https destination", which is the
 * capability the whole arrangement exists to withhold, spent on a convenience.
 *
 * So the link is rendered as text, marked as a link, carrying its URL where it
 * can be read and copied. The operator is one click from the real thing: the
 * panel's own header opens the ticket at the tracker, where the link works.
 *
 * **This is worth revisiting and is deliberately not decided here.** If clicking
 * them matters, the way in is an `openUrl` channel with the scheme check in
 * main, and it costs the property above — which is the operator's call, not a
 * renderer component's.
 */

export interface DocumentProps {
  nodes: readonly DocNode[]
}

export function Document({ nodes }: DocumentProps): ReactElement {
  return <div className="doc">{blocks(nodes)}</div>
}

function blocks(nodes: readonly DocNode[]): ReactNode {
  return nodes.map((node, i) => <Block key={i} node={node} />)
}

function Block({ node }: { node: DocNode }): ReactElement {
  switch (node.kind) {
    case 'paragraph':
      return <p className="doc__p">{inlines(node.content)}</p>

    case 'heading': {
      /*
       * Offset by two, and clamped.
       *
       * A description's own `h1` is not this page's `h1` — the panel is one
       * region among several and its `Section` already carries the label. An
       * un-offset heading would announce the description's first line as a
       * peer of the board itself.
       */
      const Tag = `h${Math.min(6, node.level + 2)}` as 'h3'
      return <Tag className="doc__h">{inlines(node.content)}</Tag>
    }

    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul'
      return (
        <Tag className="doc__list">
          {node.items.map((item, i) => (
            // An item holds blocks, not a string. Two paragraphs in one bullet
            // is ordinary in a ticket, and flattening them would run the two
            // together into a sentence neither of them is.
            <li key={i}>{blocks(item)}</li>
          ))}
        </Tag>
      )
    }

    case 'code':
      return (
        <pre className="doc__code" {...(node.language === null ? {} : { 'data-language': node.language })}>
          <code>{node.text}</code>
        </pre>
      )

    case 'quote':
      return <blockquote className="doc__quote">{blocks(node.content)}</blockquote>

    case 'rule':
      return <hr className="doc__rule" />

    case 'table':
      return (
        // The wrapper scrolls, not the panel. A wide table must not be able to
        // widen the column it sits in — the board's layout is fixed and a table
        // from somebody's ticket is not entitled to change it.
        <div className="doc__table-scroll">
          <table className="doc__table">
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) =>
                    cell.header ? (
                      <th key={c} scope="col">
                        {blocks(cell.content)}
                      </th>
                    ) : (
                      <td key={c}>{blocks(cell.content)}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )

    case 'unsupported':
      return (
        <p className="doc__unsupported">
          {/*
            Named, not merely marked. "Unsupported content" tells the operator
            that something is missing; "[panel]" tells them what to go and look
            at, which is the difference between a warning and a lead.
          */}
          <span aria-hidden="true">⌧</span> Ground Control cannot show a <code>{node.nodeType}</code>{' '}
          here. Open the ticket at the tracker to read it.
        </p>
      )
  }
}

function inlines(nodes: readonly InlineNode[]): ReactNode {
  return nodes.map((node, i) => <Inline key={i} node={node} />)
}

function Inline({ node }: { node: InlineNode }): ReactElement {
  if (node.kind === 'break') return <br />

  if (node.kind === 'unsupported') {
    return (
      <span className="doc__unsupported doc__unsupported--inline" title={`Unsupported: ${node.nodeType}`}>
        [{node.nodeType}]
      </span>
    )
  }

  // Marks nest rather than combine into a class, so bold-inside-a-link renders
  // as both. A single element carrying every mark would need one class per
  // combination and would still get the nesting wrong.
  let content: ReactNode = node.text
  if (node.marks.code) content = <code className="doc__mono">{content}</code>
  if (node.marks.em) content = <em>{content}</em>
  if (node.marks.strong) content = <strong>{content}</strong>

  if (node.marks.href !== null) {
    // Not an anchor. See the note at the top: the renderer does not name
    // destinations. `title` puts the URL where it can be read and copied, and
    // the text stays selectable.
    content = (
      <span className="doc__link" title={node.marks.href}>
        {content}
      </span>
    )
  }

  return <>{content}</>
}
