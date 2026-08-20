/**
 * Natural keys — the load-bearing idea in the data model.
 *
 * An authored row (a note, a session, an outbox action) survives the mirror
 * being deleted and rebuilt because it never pointed at a mirrored row id in
 * the first place. It points at a string the provider will produce again.
 * Constitution XIII rests on that, and so does SC-007.
 *
 * Two consequences the rest of the codebase depends on:
 *
 *   1. Keys are opaque. Nothing parses a key to recover its parts — a consumer
 *      that needs the parts carries them separately. Parsing invites a key
 *      format change to become a silent data-loss bug.
 *   2. Key construction is pure and total. No I/O, no clock, no config. That
 *      is what makes it exhaustively testable, and these functions are on the
 *      path of every authored write.
 */

/** Every subject an authored record can attach to. */
export type SubjectKind =
  | 'ticket'
  | 'pull-request'
  | 'repository'
  | 'branch'
  | 'workspace'
  | 'session'
  | 'check'
  /**
   * A configured project. Not something an authored record attaches to — notes
   * hang off tickets and branches, never off a project — but it is a *subject
   * you can open*, which is what a link needs. The header renders a project's
   * Jira board, repository and documentation when the filter narrows to one
   * (FR-070), and those go through `links.resolve` like every other URL in the
   * product so the scheme check happens in exactly one place.
   */
  | 'project'

/** An opaque natural key. Compared as a string; never parsed. */
export type NaturalKey = string & { readonly __brand: 'NaturalKey' }

const asKey = (s: string): NaturalKey => s as NaturalKey

/**
 * Reduce any git remote URL to one canonical identity.
 *
 * `git@github.com:Acme/Mercury.git`, `https://github.com/Acme/Mercury`, and
 * `https://user:token@www.github.com/acme/mercury.git/` all name the same
 * repository, and a note attached from an SSH checkout must be visible from an
 * HTTPS one. Getting this wrong does not throw — it silently orphans authored
 * data, which is the failure mode XIII exists to prevent.
 *
 * **Deviation from data-model.md, deliberate.** The design said to preserve the
 * path's case. That is wrong for every host this product targets: GitHub,
 * GitLab, and Bitbucket all treat owner and repository names case-insensitively,
 * so `acme/mercury` from a local remote and `Acme/Mercury` from the API are the
 * same repository — and preserving case would give them different keys and
 * orphan every note on one side. The whole remote is lowercased instead. Branch
 * names keep their case, because git genuinely is case-sensitive there.
 */
export function canonicalRemote(remoteUrl: string): string {
  let s = remoteUrl.trim()

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s)

  if (hasScheme) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  } else {
    // scp-style SSH — `git@host:owner/repo.git`. The colon is a separator, not
    // a port, which is why this cannot go through the URL path above.
    //
    // The lookahead excludes a *backslash* as well as a slash, and that is the
    // Windows case (XVII): a remote of `D:\mirrors\repo.git` — someone who
    // cloned from a local mirror or a mapped drive — otherwise matches with `D`
    // as the host and `\mirrors\repo.git` as the path, and comes out as
    // `d/\mirrors\repo`. `D:/mirrors/repo.git` was already excluded by the
    // slash; a drive letter is spelled both ways on Windows and only one of
    // them was covered.
    const scp = /^(?:[^@/]+@)?(?<host>[^:/]+):(?![\\/])(?<path>.+)$/.exec(s)
    const host = scp?.groups?.['host']
    const path = scp?.groups?.['path']
    if (host !== undefined && path !== undefined) s = `${host}/${path}`
  }

  s = s.replace(/^[^@/]*@/, '') // credentials, or a bare `user@`
  s = s.replace(/^([^/]+):\d+(?=\/|$)/, '$1') // explicit port on the host only
  s = s.replace(/^www\./i, '')
  s = s.replace(/\/+$/, '')
  s = s.replace(/\.git$/i, '')
  s = s.replace(/\/+$/, '') // a trailing slash that was hiding behind `.git`

  return s.toLowerCase()
}

/**
 * Identify a worktree within a repository.
 *
 * Keyed on the path, so two worktrees on the same branch stay distinct. The
 * hash is for shape rather than for stability: it keeps the key short and free
 * of separators, which matters because these are concatenated into
 * `workspaceKey`.
 *
 * **A secondary worktree that moves gets a new id, and its notes orphan.** That
 * is the cost of identifying it by where it is, and it is the right trade for
 * the thing itself — two worktrees of one branch are only distinguishable by
 * path. The primary worktree is exempt: it is always `main`, so moving the
 * checkout everybody actually moves changes nothing.
 *
 * Path comparison is case- and separator-insensitive per XVII, so
 * `D:\work\repo`, `d:/work/repo` and `d:/work/REPO/` are one worktree. The
 * drive letter is part of the identity: `C:\work\repo` and `D:\work\repo` are
 * two.
 */
export function worktreeId(worktreePath: string | null, isPrimary: boolean): string {
  if (isPrimary || worktreePath === null) return 'main'
  return `wt-${fnv1a(normalizePath(worktreePath))}`
}

/** Case- and separator-insensitive path normalization (constitution XVII). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** FNV-1a, 32-bit. Not cryptographic — this is an identity hash, not a digest. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Key constructors
// ---------------------------------------------------------------------------

/** `jira:<site>/<ISSUEKEY>` — e.g. `jira:acme.atlassian.net/MERC-1184` */
export function ticketKey(site: string, issueKey: string): NaturalKey {
  return asKey(`jira:${site.toLowerCase()}/${issueKey.toUpperCase()}`)
}

/** `gh:<owner>/<repo>` — e.g. `gh:acme/mercury` */
export function repositoryKey(owner: string, repo: string): NaturalKey {
  return asKey(`gh:${owner.toLowerCase()}/${repo.toLowerCase()}`)
}

/**
 * Accept whatever form of a repository reference someone actually has to hand.
 *
 * `owner/name`, a browser URL, a clone URL, an SSH remote — they are all the
 * same repository, and a configuration field that takes only one of them is a
 * field people get wrong. The paste from the address bar is the most likely
 * input, so it is the one that must work.
 *
 * Case is **preserved**, unlike `canonicalRemote`. This feeds the connection and
 * project rows, which are shown to the operator and sent to the API as typed;
 * key construction lowercases separately, where identity rather than display is
 * the concern.
 */
export function parseRepositoryRef(input: string): { owner: string; name: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (trimmed === '') return null

  // Strip a scheme and host, an `git@host:` prefix, or neither. What remains is
  // a path, and the repository is its first two segments — anything after that
  // is `/pull/451` or `/tree/main`, which is a link to somewhere *in* the repo.
  const path = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^[^/:]+[:/]/, (match) => (match.includes('.') ? '' : match))

  const segments = path.split('/').filter((s) => s !== '')
  if (segments.length < 2) return null

  const [owner, name] = segments
  if (owner === undefined || name === undefined) return null
  // A path segment that is not a plausible identifier means this was not a
  // repository reference at all, and guessing would bind a project to nothing.
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null

  return { owner, name }
}

/** `gh:<owner>/<repo>#<number>` — e.g. `gh:acme/mercury#451` */
export function pullRequestKey(owner: string, repo: string, number: number): NaturalKey {
  return asKey(`gh:${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`)
}

/**
 * `repo:<canonicalRemote>#<branch>`
 *
 * Branch case is preserved and slashes are left alone — `feature/MERC-1184` is
 * a name, not a path.
 */
export function branchKey(remoteUrl: string, branch: string): NaturalKey {
  return asKey(`repo:${canonicalRemote(remoteUrl)}#${branch}`)
}

/** `ws:<canonicalRemote>#<branch>@<worktreeId>` */
export function workspaceKey(remoteUrl: string, branch: string, worktree: string): NaturalKey {
  return asKey(`ws:${canonicalRemote(remoteUrl)}#${branch}@${worktree}`)
}

/** `session:<agentId>/<sessionId>` */
export function sessionKey(agentId: string, sessionId: string): NaturalKey {
  return asKey(`session:${agentId.toLowerCase()}/${sessionId}`)
}

/** `check:<owner>/<repo>@<sha>/<checkName>` */
export function checkKey(owner: string, repo: string, sha: string, name: string): NaturalKey {
  return asKey(`check:${owner.toLowerCase()}/${repo.toLowerCase()}@${sha.toLowerCase()}/${name}`)
}

/**
 * The kind of subject a key names, without parsing its contents.
 *
 * Reads the prefix only. Used for routing and for validating that an authored
 * write is attaching to a subject type that makes sense — never to recover the
 * key's parts.
 */
export function subjectKindOf(key: NaturalKey | string): SubjectKind | null {
  if (key.startsWith('jira:')) return 'ticket'
  if (key.startsWith('session:')) return 'session'
  if (key.startsWith('check:')) return 'check'
  if (key.startsWith('ws:')) return 'workspace'
  if (key.startsWith('repo:')) return 'branch'
  if (key.startsWith('gh:')) return key.includes('#') ? 'pull-request' : 'repository'
  if (key.startsWith('project:')) return 'project'
  return null
}

/**
 * The site back out of a `jira:` key, or `null` if it is not one.
 *
 * The one place a key's contents are read rather than its prefix, and it earns
 * that: a ticket key names a **site**, and a site that no configured connection
 * knows can never resolve to anything, ever. That is a different fact from "the
 * mirror has not fetched this ticket yet", which is legitimate and common
 * (FR-131) — and until 2026-08-20 the write paths could not tell them apart, so
 * a note attached to a misspelled site was accepted, stored, flagged
 * `orphaned: true`, and never seen again.
 *
 * Returns the segment between `jira:` and the first `/`, lowercased the same way
 * `ticketKey` writes it. A key with no `/` has no issue part and so no site
 * worth reporting.
 */
export function siteOfTicketKey(key: NaturalKey | string): string | null {
  if (!key.startsWith('jira:')) return null

  const rest = key.slice('jira:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null

  return rest.slice(0, slash).toLowerCase()
}

/** `project:<id>` — the subject key for a configured project. */
export function projectKey(projectId: string): NaturalKey {
  return asKey(`project:${projectId}`)
}

/** The id back out of a `project:` key, or `null` if it is not one. */
export function projectIdOf(key: NaturalKey | string): string | null {
  return key.startsWith('project:') ? key.slice('project:'.length) : null
}
