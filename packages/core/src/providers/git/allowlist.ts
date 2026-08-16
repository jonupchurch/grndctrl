/**
 * The only git commands this application may run.
 *
 * Constitution XVI and FR-017: the user's working tree, index, and branches are
 * never modified, and no git operation touches the network. Ground Control runs
 * no `fetch` at all — stricter than the constitution requires, because
 * ahead/behind comes from the code host instead (FR-018).
 *
 * Making that an allow-list in one file is what turns "we never fetch" from a
 * habit spread across the codebase into a property a single test can assert.
 * Adding a command here is a deliberate act with a test to answer to; forgetting
 * yourself in some module three directories away is not possible, because
 * nothing else may spawn git.
 */

interface AllowedCommand {
  /**
   * When set, the first argument must match this exactly.
   *
   * Checking arguments only as an unordered set is not enough, and the gap is
   * not theoretical: `remote` needs to accept a remote name, and a rule loose
   * enough to accept `origin` also accepts `update` — and `git remote update`
   * fetches from every remote. A test caught precisely that. Pinning the first
   * argument is what makes the difference between "these words may appear" and
   * "this is the command".
   */
  firstArg?: RegExp
  /** Forms allowed for the remaining arguments. */
  rest: readonly RegExp[]
}

const ALLOWED: Readonly<Record<string, AllowedCommand>> = {
  status: {
    rest: [/^--porcelain=v2$/, /^--branch$/, /^--untracked-files=(no|normal|all)$/],
  },
  'rev-list': {
    firstArg: /^--count$/,
    rest: [/^[^-].*$/],
  },
  'rev-parse': {
    rest: [/^--abbrev-ref$/, /^--git-dir$/, /^--is-inside-work-tree$/, /^--verify$/, /^[^-].*$/],
  },
  worktree: {
    firstArg: /^list$/,
    rest: [/^--porcelain$/],
  },
  'for-each-ref': {
    rest: [/^--format=.*$/, /^refs\/heads.*$/, /^--sort=.*$/],
  },
  remote: {
    firstArg: /^get-url$/,
    rest: [/^[\w.-]+$/],
  },
  config: {
    firstArg: /^--get$/,
    rest: [/^[\w.-]+$/],
  },
}

/**
 * Commands that must never run, listed explicitly.
 *
 * Redundant against the allow-list — anything absent is already refused — and
 * kept anyway, because the error message matters. "fetch is not permitted" tells
 * a future contributor what rule they hit; "unknown subcommand" invites them to
 * add it to the list.
 */
const FORBIDDEN = new Set([
  'fetch',
  'remote update',
  'pull',
  'push',
  'clone',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'reset',
  'commit',
  'add',
  'rm',
  'stash',
  'cherry-pick',
  'revert',
  'apply',
  'am',
  'gc',
  'prune',
  'submodule',
  'worktree add',
  'worktree remove',
])

export class GitCommandRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitCommandRefused'
  }
}

/**
 * Throw unless every part of this invocation is permitted.
 *
 * Called on the argument array, never on a command string — a string would have
 * to be parsed, and parsing is where the hole would be.
 */
export function assertAllowed(args: readonly string[]): void {
  const subcommand = args[0]

  if (subcommand === undefined) {
    throw new GitCommandRefused('No git subcommand given.')
  }

  const pair = args.length > 1 ? `${subcommand} ${args[1]}` : subcommand
  if (FORBIDDEN.has(subcommand) || FORBIDDEN.has(pair)) {
    throw new GitCommandRefused(
      `git ${pair} is not permitted. Ground Control never modifies the working tree, the index, ` +
        `or refs, and never runs a git command that touches the network (constitution XVI).`,
    )
  }

  const allowed = ALLOWED[subcommand]
  if (allowed === undefined) {
    throw new GitCommandRefused(
      `git ${subcommand} is not on the read-only allow-list. If it is genuinely read-only and ` +
        `offline, add it to allowlist.ts deliberately -- that file is the whole guarantee.`,
    )
  }

  const rest = args.slice(1)

  if (allowed.firstArg !== undefined) {
    const first = rest[0]
    if (first === undefined || !allowed.firstArg.test(first)) {
      throw new GitCommandRefused(
        `git ${subcommand} ${first ?? ''} is not permitted. This subcommand is allowed only in one ` +
          `exact form, because a looser rule would also admit a variant that touches the network.`,
      )
    }
  }

  for (const arg of allowed.firstArg === undefined ? rest : rest.slice(1)) {
    if (!allowed.rest.some((p) => p.test(arg))) {
      throw new GitCommandRefused(
        `Argument '${arg}' is not permitted for git ${subcommand}. Arguments are allow-listed too, ` +
          `because a read-only subcommand can be given a flag that is not.`,
      )
    }
  }
}

/** The subcommands currently permitted. Used by the allow-list test. */
export function allowedSubcommands(): string[] {
  return Object.keys(ALLOWED).sort()
}

/** The commands explicitly refused. Used by the allow-list test. */
export function forbiddenSubcommands(): string[] {
  return [...FORBIDDEN].sort()
}
