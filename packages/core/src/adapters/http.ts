import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AdapterDescriptor } from '../registry/conformance.js'
import { isOperationError, OperationError, type ErrorCode } from '../registry/errors.js'
import type { Registry } from '../registry/index.js'
import type { Ctx } from '../registry/types.js'

/**
 * The loopback API — one of three thin adapters over the operation registry.
 *
 * It contains no product logic and cannot: it looks an operation up by name and
 * dispatches it. Everything an agent can do over HTTP is an entry in the
 * registry, which is what makes "does MCP offer the same capabilities as the
 * UI?" a question the conformance test answers rather than one a reviewer has
 * to (XII). The ESLint boundary rule stops this file importing anything below
 * the registry.
 *
 * It is a *credentialled* local service, and four things keep it that way:
 *
 * - **Bound to `127.0.0.1`**, explicitly. The default binds every interface,
 *   which on a laptop on a café network means the board is on the café network.
 * - **Ephemeral port**, published only through the handshake file, which only
 *   the current user can read.
 * - **Bearer token**, compared in constant time, minted per run.
 * - **Refuses anything that looks browser-driven.** A page in the operator's
 *   browser can POST to localhost; it cannot set `Origin`, and it cannot read
 *   the response without CORS headers — which are deliberately absent. A
 *   request carrying `Origin`, or addressed to a host that is not loopback, is
 *   refused before it reaches an operation.
 */

export interface LoopbackOptions {
  registry: Registry
  /** Fixed in tests. Otherwise a fresh 32-byte secret per run. */
  token?: string
  /** 0 means "let the OS choose", which is what production wants. */
  port?: number
  now?: () => Date
}

export interface LoopbackServer extends AdapterDescriptor {
  readonly surface: 'http'
  readonly port: number
  readonly token: string
  close(): Promise<void>
}

/** One megabyte. Nothing legitimate here is larger; a note body is capped at 8 KB. */
const MAX_BODY_BYTES = 1024 * 1024

const STATUS: Record<ErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  rate_limited: 429,
  provider_unavailable: 502,
  keychain_unavailable: 503,
}

export async function startLoopbackAdapter(options: LoopbackOptions): Promise<LoopbackServer> {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const now = options.now ?? (() => new Date())

  const server = createServer((req, res) => {
    handle(req, res, options.registry, token, now).catch(() => {
      // The handler already converts every operation failure into a response.
      // Reaching here means the response machinery itself failed, so there is
      // nothing useful to say and nothing to leak.
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // The bind address is the security boundary, not a default worth inheriting.
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })

  const address = server.address() as AddressInfo

  return {
    surface: 'http',
    port: address.port,
    token,
    // Read from the registry rather than from a hand-maintained list: a list
    // would drift from what is really served, and the drift is the thing the
    // conformance test exists to catch.
    exposedNames: () => options.registry.namesFor('http'),
    close: () => closeServer(server),
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  token: string,
  now: () => Date,
): Promise<void> {
  if (req.method !== 'POST') {
    return send(res, 405, { ok: false, error: { code: 'invalid', message: 'POST only.' } })
  }

  // A browser sets `Origin` on any cross-origin request it makes and a script
  // cannot remove it. No legitimate client here sets one.
  if (req.headers.origin !== undefined) {
    return send(res, 403, {
      ok: false,
      error: { code: 'invalid', message: 'Browser-originated requests are refused.' },
    })
  }

  // DNS rebinding: an attacker's domain resolving to 127.0.0.1 arrives with
  // their hostname in `Host`. Loopback names only.
  const host = (req.headers.host ?? '').split(':')[0] ?? ''
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    return send(res, 403, {
      ok: false,
      error: { code: 'invalid', message: 'Unexpected Host header.' },
    })
  }

  if (!authorised(req.headers.authorization, token)) {
    return send(res, 401, {
      ok: false,
      error: { code: 'unauthorized', message: 'Missing or invalid bearer token.' },
    })
  }

  const path = (req.url ?? '').split('?')[0] ?? ''
  const name = path.startsWith('/op/') ? decodeURIComponent(path.slice('/op/'.length)) : null
  if (name === null || name === '') {
    return send(res, 404, {
      ok: false,
      error: { code: 'not_found', message: 'Post to /op/<operation>.' },
    })
  }

  let body: unknown
  try {
    body = await readJson(req)
  } catch (e) {
    return send(res, 400, {
      ok: false,
      error: { code: 'invalid', message: e instanceof Error ? e.message : 'Unreadable body.' },
    })
  }

  const ctx: Ctx = {
    // Stamped from the transport. Anything reaching this adapter is an agent by
    // definition — the UI talks over IPC — so a note written here can never be
    // attributed to the operator, whatever the payload says.
    authorKind: 'agent',
    authorId: headerString(req.headers['x-grndctrl-agent']),
    surface: 'http',
    now,
  }

  try {
    const data = await registry.dispatch(name, body, ctx)
    send(res, 200, { ok: true, data })
  } catch (e) {
    const error = isOperationError(e)
      ? e
      : // An unexpected throw is the thing most likely to be carrying a URL with
        // a token in it, so it becomes opaque rather than being forwarded.
        new OperationError('provider_unavailable', 'An unexpected internal error occurred.')

    send(res, STATUS[error.code], { ok: false, error: error.toJSON() })
  }
}

function authorised(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false

  const presented = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)

  // Length is checked separately because `timingSafeEqual` throws on a mismatch
  // rather than returning false. The length of a token is not a secret.
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Checked as it arrives rather than after: buffering an unbounded body to
    // measure it is the denial of service.
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}

  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new Error('Request body is not valid JSON.')
  }
}

function headerString(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  const single = Array.isArray(value) ? value[0] : value
  return single === undefined || single === '' ? null : single.slice(0, 200)
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // No CORS headers anywhere in this file, deliberately. Without them a
    // browser cannot read a response even if it manages to send a request.
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
