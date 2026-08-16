import type { Database } from 'better-sqlite3'
import type { FindingDismissal, Project, Timestamp } from '../../domain/types.js'

/**
 * Projects and finding dismissals — small authored tables that the board reads
 * on every assembly.
 *
 * Both live in `authored.db` and neither has a foreign key into the mirror. A
 * project names a Jira connection and a repository by id and by string, not by
 * reference: a connection row is disposable and re-creatable, a project is the
 * operator's own definition of what they work on (XIII).
 */

export interface ProjectsRepository {
  list(): Project[]
  get(id: string): Project | null
  upsert(project: Project): Project
  remove(id: string): boolean
}

export interface DismissalsRepository {
  list(): FindingDismissal[]
  dismiss(findingId: string, at: Timestamp, evidenceHash: string): FindingDismissal
  undismiss(findingId: string): boolean
}

export function projectsRepository(db: Database): ProjectsRepository {
  const read = (id: string): Project | null => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? null : toProject(row)
  }

  return {
    list() {
      // Ordered by code so the project chips have a fixed order across runs —
      // a filter row that reshuffles between launches is unusable.
      const rows = db.prepare('SELECT * FROM projects ORDER BY code, id').all() as Record<
        string,
        unknown
      >[]
      return rows.map(toProject)
    },

    get: read,

    upsert(project) {
      db.prepare(
        `INSERT INTO projects
           (id, code, name, color_index, jira_connection_id, jira_project_key,
            github_connection_id, repo_owner, repo_name, documentation_url,
            ticket_key_pattern, checkout_paths, status_overrides)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code, name = excluded.name, color_index = excluded.color_index,
           jira_connection_id = excluded.jira_connection_id,
           jira_project_key = excluded.jira_project_key,
           github_connection_id = excluded.github_connection_id,
           repo_owner = excluded.repo_owner, repo_name = excluded.repo_name,
           documentation_url = excluded.documentation_url,
           ticket_key_pattern = excluded.ticket_key_pattern,
           checkout_paths = excluded.checkout_paths,
           status_overrides = excluded.status_overrides`,
      ).run(
        project.id,
        project.code,
        project.name,
        project.colorIndex,
        project.jiraConnectionId,
        project.jiraProjectKey,
        project.githubConnectionId,
        project.repoOwner,
        project.repoName,
        project.documentationUrl,
        project.ticketKeyPattern,
        JSON.stringify(project.checkoutPaths),
        JSON.stringify(project.statusOverrides),
      )
      return read(project.id) as Project
    },

    remove: (id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0,
  }
}

export function dismissalsRepository(db: Database): DismissalsRepository {
  return {
    list() {
      const rows = db
        .prepare('SELECT * FROM finding_dismissals ORDER BY finding_id')
        .all() as Record<string, unknown>[]

      return rows.map((r) => ({
        findingId: String(r['finding_id']),
        dismissedAt: String(r['dismissed_at']),
        evidenceHash: String(r['evidence_hash']),
      }))
    },

    dismiss(findingId, at, evidenceHash) {
      // Re-dismissing replaces the hash. The evidence has moved on, and the
      // operator is saying "not now" about the new situation, not the old one.
      db.prepare(
        `INSERT INTO finding_dismissals (finding_id, dismissed_at, evidence_hash)
         VALUES (?, ?, ?)
         ON CONFLICT(finding_id) DO UPDATE SET
           dismissed_at = excluded.dismissed_at, evidence_hash = excluded.evidence_hash`,
      ).run(findingId, at, evidenceHash)

      return { findingId, dismissedAt: at, evidenceHash }
    },

    undismiss: (findingId) =>
      db.prepare('DELETE FROM finding_dismissals WHERE finding_id = ?').run(findingId).changes > 0,
  }
}

function toProject(row: Record<string, unknown>): Project {
  const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

  return {
    id: String(row['id']),
    code: String(row['code']),
    name: String(row['name']),
    colorIndex: row['color_index'] === null || row['color_index'] === undefined ? null : Number(row['color_index']),
    jiraConnectionId: nullable(row['jira_connection_id']),
    jiraProjectKey: nullable(row['jira_project_key']),
    githubConnectionId: nullable(row['github_connection_id']),
    repoOwner: nullable(row['repo_owner']),
    repoName: nullable(row['repo_name']),
    documentationUrl: nullable(row['documentation_url']),
    ticketKeyPattern: String(row['ticket_key_pattern']),
    checkoutPaths: safeJson<string[]>(row['checkout_paths'], []),
    statusOverrides: safeJson<Project['statusOverrides']>(row['status_overrides'], {}),
  }
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
