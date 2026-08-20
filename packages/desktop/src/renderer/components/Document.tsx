import type { ReactElement, ReactNode } from 'react'
import { openDescriptionLink } from '../bridge.js'
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
 * ## Links open, and the renderer still cannot choose a destination
 *
 * `main/links.ts` is emphatic that the renderer never passes a URL: it passes a
 * subject key, main resolves it, and only what core returned reaches the OS —
 * so a page with a script in it "cannot ask for a URL of its own; there is no
 * argument to put one in."
 *
 * A description link is an arbitrary provider URL and is not a subject, so it
 * cannot go down that path. The obvious fix — a channel that opens any https
 * URL — would trade that property for a convenience. What is done instead is
 * narrower: the click sends **the URL and the ticket it is on**, and main
 * refuses any URL that ticket's own description does not contain, checked
 * against core's copy rather than the page's. An injected script may send any
 * string it likes and every string that is not already on the operator's board
 * is refused.
 *
 * So this is a `<button>` and not an `<a href>`. There is no URL in the markup
 * at all, which also means nothing here can be middle-clicked, dragged, or
 * copied into a page that had no business having it.
 */

export interface DocumentProps {
  nodes: readonly DocNode[]
  /**
   * The ticket this description belongs to.
   *
   * Required, and it is not decoration: it is half of what a link click sends,
   * and main uses it to decide whether the URL is one this description actually
   * contains. A `Document` with no subject could not have working links, so the
   * prop is not optional — the alternative is a component that silently
   * renders inert links in whichever place forgot to pass it.
   */
  subjectKey: string
}

export function Document({ nodes, subjectKey }: DocumentProps): ReactElement {
  return <div className="doc">{blocks(nodes, subjectKey)}</div>
}

function blocks(nodes: readonly DocNode[], subject: string): ReactNode {
  return nodes.map((node, i) => <Block key={i} node={node} subject={subject} />)
}

function Block({ node, subject }: { node: DocNode; subject: string }): ReactElement {
  switch (node.kind) {
    case 'paragraph':
      return <p className="doc__p">{inlines(node.content, subject)}</p>

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
      return <Tag className="doc__h">{inlines(node.content, subject)}</Tag>
    }

    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul'
      return (
        <Tag className="doc__list">
          {node.items.map((item, i) => (
            // An item holds blocks, not a string. Two paragraphs in one bullet
            // is ordinary in a ticket, and flattening them would run the two
            // together into a sentence neither of them is.
            <li key={i}>{blocks(item, subject)}</li>
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
      return <blockquote className="doc__quote">{blocks(node.content, subject)}</blockquote>

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
                        {blocks(cell.content, subject)}
                      </th>
                    ) : (
                      <td key={c}>{blocks(cell.content, subject)}</td>
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

function inlines(nodes: readonly InlineNode[], subject: string): ReactNode {
  return nodes.map((node, i) => <Inline key={i} node={node} subject={subject} />)
}

function Inline({ node, subject }: { node: InlineNode; subject: string }): ReactElement {
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
    /*
     * A button, not an anchor, and the difference is the point.
     *
     * There is no `href` anywhere in the markup: the URL lives in the closure
     * and in the `title`, and the only thing that can act on it is this click,
     * which main will refuse unless the URL is in this ticket's description.
     * An `<a href>` would put a live destination in the DOM for anything on the
     * page to read, drag or middle-click, and would need its default prevented
     * anyway — since the renderer must not navigate (FR-075).
     */
    const href = node.marks.href
    content = (
      <button
        type="button"
        className="doc__link"
        title={href}
        onClick={() => void openDescriptionLink(subject, href).catch(() => undefined)}
      >
        {content}
      </button>
    )
  }

  return <>{content}</>
}
