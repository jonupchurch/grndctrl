import {
  providerUnavailable,
  rateLimited,
  unauthorized,
  type OperationError,
} from '../registry/errors.js'

/**
 * The one HTTP path to a provider.
 *
 * Injectable so tests run against recorded fixtures rather than live APIs — a
 * suite that needs somebody's Jira token is a suite that stops being run
 * (research R9).
 *
 * It also exists so provider errors are mapped to the registry taxonomy in one
 * place. A 401 and a 429 need completely different things from the user (fix
 * your token / wait four minutes), and a lane that renders both as "failed"
 * makes the difference invisible (XIV, XV).
 */

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export interface HttpClientOptions {
  baseUrl: string
  /** `Authorization` and any provider-specific headers. Never logged. */
  headers: Record<string, string>
  fetcher?: Fetcher
  connectionId?: string
}

export interface HttpClient {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
  /** Rate-limit state from the most recent response, when the provider reports it. */
  lastRateLimit(): { remaining: number | null; limit: number | null; resetAt: string | null }
}

export function httpClient(options: HttpClientOptions): HttpClient {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init))
  let rate = { remaining: null as number | null, limit: null as number | null, resetAt: null as string | null }

  const request = async <T>(method: string, path: string, init: RequestInit = {}): Promise<T> => {
    const url = path.startsWith('http') ? path : `${options.baseUrl.replace(/\/$/, '')}${path}`

    let response: Response
    try {
      response = await fetcher(url, {
        ...init,
        method,
        headers: { Accept: 'application/json', ...options.headers, ...(init.headers ?? {}) },
      })
    } catch {
      // A DNS failure, a dropped connection, a proxy refusing. The message is
      // not forwarded: it routinely contains the full URL, and provider URLs
      // can carry query parameters worth protecting.
      throw providerUnavailable(
        `Could not reach ${safeHost(url)}. Check the connection and try again.`,
        options.connectionId,
      )
    }

    rate = readRateLimit(response)

    if (!response.ok) throw mapStatus(response, url, options.connectionId, rate.resetAt)

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  return {
    get: (path, query) => request('GET', withQuery(path, query)),
    post: (path, body) =>
      request('POST', path, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
    lastRateLimit: () => rate,
  }
}

function withQuery(path: string, query?: Record<string, string | number | undefined>): string {
  if (query === undefined) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v))
  }
  const qs = params.toString()
  return qs === '' ? path : `${path}?${qs}`
}

function mapStatus(
  response: Response,
  url: string,
  connectionId: string | undefined,
  resetAt: string | null,
): OperationError {
  const host = safeHost(url)

  if (response.status === 401 || response.status === 403) {
    // 403 is ambiguous at GitHub -- it is also how a spent rate limit is
    // reported. The remaining-count header is what tells them apart, and
    // getting this wrong sends the user to regenerate a perfectly good token.
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      return rateLimited(`${host} rate limit reached.`, secondsUntil(resetAt), connectionId)
    }
    return unauthorized(
      `${host} rejected the stored credential. Re-authorize this connection.`,
      connectionId,
    )
  }

  if (response.status === 429) {
    return rateLimited(
      `${host} is rate limiting requests.`,
      Number.parseInt(response.headers.get('retry-after') ?? '', 10) || secondsUntil(resetAt),
      connectionId,
    )
  }

  return providerUnavailable(`${host} returned ${response.status}.`, connectionId)
}

function readRateLimit(response: Response): {
  remaining: number | null
  limit: number | null
  resetAt: string | null
} {
  const num = (name: string): number | null => {
    const raw = response.headers.get(name)
    if (raw === null) return null
    const n = Number.parseInt(raw, 10)
    return Number.isNaN(n) ? null : n
  }

  const resetEpoch = num('x-ratelimit-reset')

  return {
    remaining: num('x-ratelimit-remaining'),
    limit: num('x-ratelimit-limit'),
    resetAt: resetEpoch === null ? null : new Date(resetEpoch * 1000).toISOString(),
  }
}

function secondsUntil(resetAt: string | null): number {
  if (resetAt === null) return 60
  const delta = Math.ceil((Date.parse(resetAt) - Date.now()) / 1000)
  return Number.isNaN(delta) ? 60 : Math.max(1, delta)
}

/** Host only. A full provider URL can carry parameters worth not repeating. */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'the provider'
  }
}
