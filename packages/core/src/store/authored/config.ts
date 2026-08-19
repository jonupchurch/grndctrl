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
            documentation_url, status_overrides)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code, name = excluded.name, color_index = excluded.color_index,
           jira_connection_id = excluded.jira_connection_id,
           jira_project_key = excluded.jira_project_key,
           documentation_url = excluded.documentation_url,
           status_overrides = excluded.status_overrides`,
      ).run(
        project.id,
        project.code,
        project.name,
        project.colorIndex,
        project.jiraConnectionId,
        project.jiraProjectKey,
        project.documentationUrl,
        JSON.stringify(project.statusOverrides),
      )
      return read(project.id) as Project
    },

    remove: (id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0,
  }
}

/*
 * ── `finding_dismissals`, and why the D1–D9 identifiers are spent ─────────
 *
 * The repository that read and wrote this table was here, and 006 removed it
 * with drift. **The table and every row in it stay** (FR-122): a dismissal is
 * the operator saying "not now" about a specific situation, it is authored data,
 * and there is no server-side copy to restore it from (XI). The authored
 * migration does not open this table.
 *
 * **The consequence is that `D1` through `D9` can never be used again**, and
 * this is the only place in the codebase where those identifiers still appear.
 *
 * A finding's id is `drift:<rule>:<subjectKey>` and is deliberately a pure
 * function of the rule and its subject — that is what makes a dismissal survive
 * a resync rather than evaporating. So a future rule numbered `D3` would mint
 * exactly the ids a retired `D3` minted, and every finding it raised against a
 * subject the operator once dismissed would arrive **pre-dismissed**: raised,
 * filtered out, never seen. The operator would report that a rule they enabled
 * does nothing, and the cause is a row written months earlier by a different
 * rule that happened to share a number.
 *
 * There is no code left that could enforce this, which is precisely why it is
 * written down. **Any future finding scheme must start at `D10`**, or use a
 * prefix that is not `drift:`.
 */

function toProject(row: Record<string, unknown>): Project {
  const nullable = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

  return {
    id: String(row['id']),
    code: String(row['code']),
    name: String(row['name']),
    colorIndex: row['color_index'] === null || row['color_index'] === undefined ? null : Number(row['color_index']),
    jiraConnectionId: nullable(row['jira_connection_id']),
    jiraProjectKey: nullable(row['jira_project_key']),
    documentationUrl: nullable(row['documentation_url']),
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
