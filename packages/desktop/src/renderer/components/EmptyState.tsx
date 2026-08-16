import type { ReactElement } from 'react'

/**
 * The first thing anyone sees, and it is not an error (T147).
 *
 * A board with no projects on it is the correct state for a freshly installed
 * application, and the two ways to get this wrong are a blank page — which reads
 * as broken — and an error — which reads as *your fault*. Neither tells the one
 * thing the operator needs, which is what a project even is in this application:
 * **one Jira project plus one git repository, bound together**. That binding is
 * not obvious, it is not the same as either system's idea of a project, and
 * everything else on the board follows from it.
 *
 * The same component covers an empty *lane*, where the sentence is different but
 * the principle is identical: say what would appear here, not "no data".
 */

export interface EmptyStateProps {
  title: string
  children: React.ReactNode
  action?: { label: string; onSelect(): void } | undefined
}

export function EmptyState({ title, children, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      <p className="empty__body">{children}</p>
      {action !== undefined && (
        <button type="button" className="empty__action" onClick={action.onSelect}>
          {action.label}
        </button>
      )}
    </div>
  )
}

export function NoProjects({ onConfigure }: { onConfigure?: (() => void) | undefined }): ReactElement {
  return (
    <EmptyState
      title="No projects yet"
      {...(onConfigure === undefined
        ? {}
        : { action: { label: 'Add a project', onSelect: onConfigure } })}
    >
      A project is one Jira project and one git repository, bound together. Tickets, branches, pull
      requests and CI all follow from that pair — so the board can tell you when they disagree.
    </EmptyState>
  )
}
