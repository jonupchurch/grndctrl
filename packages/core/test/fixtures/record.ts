import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fetcher } from '../../src/providers/http.js'

/**
 * Recording real provider payloads, safely (T037, research R9).
 *
 * Every fixture in this repository is currently **hand-written**, which is the
 * problem this file exists for: a payload invented by the same person who wrote
 * the parser agrees with whatever that person believed. Three of the eight bugs
 * that live data produced on 2026-08-15 were exactly that — `searchIssues`
 * returned a `nextPageToken` nothing could send back, `fetchChangelogs` named
 * every issue in one request, `viewerIdentity` was never resolved — and all
 * three passed against fixtures shaped by the same misunderstanding.
 *
 * A recorded payload does not have that property. It disagrees with you.
 *
 * ## What makes this safe to commit
 *
 * A real payload carries the operator's colleagues' names, their email
 * addresses, ticket summaries describing a client's unreleased work, and
 * account identifiers. None of that may enter the repository (XI). So nothing
 * is written until it has been through `scrub`, and `record` refuses outright
 * if a credential appears anywhere in the result.
 *
 * ## What makes it still worth having afterwards
 *
 * A scrub that replaced everything with `"x"` would be safe and useless. Three
 * properties have to survive, and they are what most of the code below is for:
 *
 * 1. **Referential integrity.** `BLUEBED-1184` appears in an issue key, in a
 *    branch name, in a pull request title and in a commit message, and the
 *    correlation engine's entire job is noticing they are the same string. If
 *    the scrub renames them independently the fixture proves nothing. Every
 *    identifier is therefore aliased *once* and the alias reused everywhere it
 *    occurs — including inside free text.
 * 2. **Shape.** A ticket summary becomes nonsense of the same length with its
 *    punctuation and its ticket keys in the same places. Lengths matter because
 *    the board truncates; key positions matter because that is what is parsed.
 * 3. **Everything that is not prose.** Status categories, review decisions,
 *    check conclusions, timestamps, counts and booleans are the fixture. They
 *    are left exactly as the provider sent them.
 */

export interface ScrubOptions {
  /**
   * Strings that must never survive — API tokens, cookies, anything from the
   * keychain. Their presence in the output is an error rather than something to
   * replace, because a credential reaching this point means it was somewhere it
   * should not have been and quietly masking it would hide that.
   */
  secrets?: readonly string[]
  /** Reuse an alias table across payloads so a whole session stays consistent. */
  aliases?: Aliases
}

/**
 * The alias table. One per recording session, shared across every payload, so
 * the ticket named in a Jira search matches the one named in a GitHub branch.
 */
export class Aliases {
  private readonly assigned = new Map<string, string>()
  private readonly counts = new Map<string, number>()

  /** A stable replacement for `original`, minted once per distinct value. */
  for(kind: string, original: string, mint: (n: number) => string): string {
    const slot = `${kind}:${original}`
    const existing = this.assigned.get(slot)
    if (existing !== undefined) return existing

    const n = (this.counts.get(kind) ?? 0) + 1
    this.counts.set(kind, n)
    const alias = mint(n)
    this.assigned.set(slot, alias)
    return alias
  }

  /** Every real → alias pair, longest real value first. */
  entries(): [string, string][] {
    return [...this.assigned.entries()]
      .map(([slot, alias]): [string, string] => [slot.slice(slot.indexOf(':') + 1), alias])
      .sort((a, b) => b[0].length - a[0].length)
  }
}

/** `PROJ-1184`, `ABC-7`. Anchored nowhere: these turn up inside prose. */
const TICKET_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g

/**
 * Keys whose values are prose written by a person.
 *
 * Matched case-insensitively on the *leaf* key name, because Jira and GitHub
 * disagree about casing and about nesting depth for the same idea.
 */
const PROSE_KEYS = new Set([
  'summary',
  'description',
  'title',
  'body',
  'bodytext',
  'message',
  'headline',
  'comment',
  'displayname',
  'label',
])

/**
 * `name` is prose only under one of these, and load-bearing everywhere else.
 *
 * It is the worst key in either API. Under `author` or `assignee` it is
 * somebody's actual name; under `statusCategory` it is `In Progress`, which the
 * drift rules match on with a regex; on a check run it is `build (18.x)`, which
 * `checkKey` puts in a natural key. Scrubbing all of them makes the fixture
 * unable to reproduce a status bug; scrubbing none of them puts a colleague's
 * name in the repository. So the decision is made on the *parent*.
 *
 * The first version of this decided on the leaf key and turned `In Progress`
 * into `Ub Hkotviwf` — while carrying a comment saying it checked the parent.
 */
const PERSON_CONTEXT = new Set([
  'author',
  'assignee',
  'reporter',
  'creator',
  'actor',
  'user',
  'committer',
  'requestedreviewer',
])

/** Keys naming a person. Replaced with synthetic people, consistently. */
const PERSON_KEYS = new Set([
  'accountid',
  'emailaddress',
  'email',
  'login',
  'author',
  'assignee',
  'reporter',
  'creator',
  'actor',
])

/** Keys that are opaque provider identifiers — safe to alias, never parsed. */
const OPAQUE_KEYS = new Set(['id', 'nodeid', 'node_id', 'gid', 'self', 'avatarurl', 'avatarurls'])

export function scrub(value: unknown, options: ScrubOptions = {}): unknown {
  const aliases = options.aliases ?? new Aliases()

  // Two passes. The first mints an alias for every identifier anywhere in the
  // payload; the second rewrites. They cannot be one pass: a ticket key
  // mentioned in a pull request title is usually encountered *before* the issue
  // whose key it is, and a single pass would alias the mention and the issue
  // independently — which is precisely the link the fixture exists to test.
  collect(value, aliases, null)
  const scrubbed = rewrite(value, aliases, null, null)

  const leaked = (options.secrets ?? []).filter(
    (secret) => secret !== '' && JSON.stringify(scrubbed).includes(secret),
  )
  if (leaked.length > 0) {
    throw new Error(
      `Refusing to write a fixture: ${leaked.length} credential(s) survived the scrub. ` +
        'A token in a response body means it was echoed by the provider or captured from a ' +
        'request; either way it must not reach the repository (XI).',
    )
  }

  return scrubbed
}

function collect(value: unknown, aliases: Aliases, key: string | null): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, aliases, key)
    return
  }

  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, aliases, k.toLowerCase())
    return
  }

  if (typeof value !== 'string') return

  // Ticket keys, wherever they appear — a field of their own, or in prose.
  for (const match of value.matchAll(TICKET_KEY)) {
    aliases.for('ticket', match[0], (n) => `MERC-${1000 + n}`)
  }

  if (key === null) return

  if (PERSON_KEYS.has(key)) {
    if (key === 'email' || key === 'emailaddress') {
      aliases.for('email', value, (n) => `person${n}@example.com`)
    } else if (key === 'accountid') {
      aliases.for('accountid', value, (n) => `account-${String(n).padStart(4, '0')}`)
    } else if (key === 'login') {
      aliases.for('login', value, (n) => `person${n}`)
    }
    return
  }

  // A URL is never aliased wholesale, even under a key like `self`. Aliasing it
  // replaces the whole string with `id-0001`, and the path — `/rest/api/3/…` —
  // is the one part of a URL a parser reads. `rewrite` scrubs it as a URL
  // instead, which loses the host and the query and keeps the shape.
  if (OPAQUE_KEYS.has(key) && !isUrl(value)) {
    aliases.for('opaque', value, (n) => `id-${String(n).padStart(4, '0')}`)
  }
}

function rewrite(
  value: unknown,
  aliases: Aliases,
  key: string | null,
  parent: string | null,
): unknown {
  // An array element inherits its array's key as its own — `issues: [...]`
  // makes every element's parent `issues`, not the index.
  if (Array.isArray(value)) return value.map((item) => rewrite(item, aliases, key, parent))

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = rewrite(v, aliases, k.toLowerCase(), key)
    }
    return out
  }

  // Numbers, booleans, null and timestamps-as-numbers pass straight through:
  // they are the part of the payload the parsers actually reason about.
  if (typeof value !== 'string') return value

  const replaced = applyAliases(value, aliases)

  if (key === null) return replaced

  // An avatar URL's *path* is the account hash — there is nothing in it worth
  // keeping and something in it worth losing.
  if (key === 'avatarurl' || key === 'avatarurls') return 'https://example.com/avatar.png'

  if (isUrl(replaced)) return scrubUrl(replaced)

  // There is deliberately no timestamp guard here. One was written and then
  // removed: `updated`, `created` and `mergedAt` survive because they are not
  // in `PROSE_KEYS`, not because anything checks their format, and the guard
  // could not be made to fail by any input. What it would have protected — a
  // date inside a commit message — is prose, and prose is meant to be destroyed.

  if (key === 'name') {
    return parent !== null && PERSON_CONTEXT.has(parent) ? nonsense(replaced) : replaced
  }

  if (PROSE_KEYS.has(key)) return nonsense(replaced)

  return replaced
}

/** Substitute every aliased identifier, longest first so no alias eats another. */
function applyAliases(text: string, aliases: Aliases): string {
  let out = text
  for (const [original, alias] of aliases.entries()) {
    if (original === '') continue
    out = out.split(original).join(alias)
  }
  return out
}

/**
 * Destroy the words, keep the shape.
 *
 * Each run of letters becomes a deterministic pseudo-word of the same length;
 * digits, punctuation, whitespace and anything already aliased are untouched.
 * So `MERC-1001: fix the flaky upload retry` becomes
 * `MERC-1001: xuq bda qytnb sfrqmp veqlj` — the ticket key is still parseable,
 * the string is still 38 characters, and nobody's unreleased work is in the
 * repository.
 */
function nonsense(text: string): string {
  return text.replace(/[A-Za-z]+/g, (word, offset: number) => {
    // An aliased identifier's letters must survive: `MERC` in `MERC-1001` is
    // load-bearing, and so is `person1` in an email.
    if (/^(MERC|person|account|id)$/i.test(word)) return word

    let h = 0x811c9dc5 ^ offset
    for (let i = 0; i < word.length; i++) {
      h ^= word.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }

    const letters = 'abcdefghijklmnopqrstuvwxyz'
    let out = ''
    for (let i = 0; i < word.length; i++) {
      out += letters[h % 26] ?? 'x'
      h = Math.imul(h ^ (i + 1), 0x01000193) >>> 0
    }

    // Preserve capitalisation of the first letter only — enough for a title to
    // still look like a title in a screenshot.
    return /^[A-Z]/.test(word) ? (out[0] ?? '').toUpperCase() + out.slice(1) : out
  })
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s)

/**
 * Keep a URL's shape and lose its host.
 *
 * The path is what the parsers read — `/rest/api/3/search/jql`, `/pulls/451` —
 * and the host is what identifies the customer. Query strings go entirely:
 * a JQL string in a recorded URL names real projects and real people.
 */
function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.host.endsWith('atlassian.net') ? 'example.atlassian.net' : parsed.host
    return `${parsed.protocol}//${host}${parsed.pathname}`
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Recording and replaying
// ---------------------------------------------------------------------------

export interface RecordOptions {
  /** The live fetcher to record through. */
  fetcher?: Fetcher
  /** Where the scrubbed payloads land — `fixtures/jira`, `fixtures/github`. */
  dir: string
  secrets?: readonly string[]
}

/**
 * A `Fetcher` that passes calls through and writes what came back.
 *
 * The recorded name is derived from the request rather than supplied, so a
 * recording run needs no bookkeeping: point the CLI probe at a live connection
 * with this in place and the directory fills itself.
 */
export function recordingFetcher(options: RecordOptions): Fetcher {
  const live = options.fetcher ?? ((url, init) => fetch(url, init))
  const aliases = new Aliases()
  mkdirSync(options.dir, { recursive: true })

  return async (url, init) => {
    const response = await live(url, init)
    const text = await response.clone().text()

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      // Not JSON. Recording it would mean scrubbing a format this cannot
      // reason about, so it is skipped rather than half-cleaned.
      return response
    }

    const record = {
      request: { method: init.method ?? 'GET', path: pathOf(url) },
      status: response.status,
      body: scrub(payload, { secrets: options.secrets ?? [], aliases }),
    }

    writeFileSync(
      join(options.dir, `${fixtureName(init.method ?? 'GET', url)}.json`),
      JSON.stringify(record, null, 2) + '\n',
      'utf8',
    )

    return response
  }
}

/** A `Fetcher` that answers from a recorded directory instead of the network. */
export function replayFetcher(dir: string): Fetcher {
  const recorded = new Map<string, { status: number; body: unknown }>()

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      request: { method: string; path: string }
      status: number
      body: unknown
    }
    recorded.set(`${parsed.request.method} ${parsed.request.path}`, {
      status: parsed.status,
      body: parsed.body,
    })
  }

  return async (url, init) => {
    const key = `${init.method ?? 'GET'} ${pathOf(url)}`
    const hit = recorded.get(key)

    if (hit === undefined) {
      // Loudly. A replay that answers `{}` for an unrecorded call is how a test
      // ends up passing against a payload nobody ever saw.
      throw new Error(
        `No recorded fixture for '${key}' in ${dir}. Recorded: ${[...recorded.keys()].join(', ')}`,
      )
    }

    return new Response(JSON.stringify(hit.body), {
      status: hit.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** A filesystem-safe, stable name for a request. */
export function fixtureName(method: string, url: string): string {
  const path = pathOf(url).replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-')
  return `${method.toLowerCase()}-${path === '' ? 'root' : path}`.slice(0, 120)
}
