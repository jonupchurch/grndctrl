import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startLoopbackAdapter, type LoopbackServer } from '../../src/adapters/http.js'
import { checkConformance } from '../../src/registry/conformance.js'
import { tempServices, type TempServices } from '../helpers/services.js'

/**
 * The loopback API, exercised as a real HTTP server on a real port.
 *
 * Not a stubbed request object: the properties under test are properties of the
 * transport — which interface it bound to, what it does with a `Host` header,
 * what it does with a body that never ends — and a double would pass whatever
 * this file asserted.
 */

const TOKEN = 'test-token-not-a-real-secret'

let t: TempServices
let server: LoopbackServer

beforeAll(async () => {
  t = tempServices()
  server = await startLoopbackAdapter({ registry: t.registry, token: TOKEN })
})

afterAll(async () => {
  await server.close()
  t.dispose()
})

interface CallOptions {
  token?: string | null
  method?: string
  headers?: Record<string, string>
  body?: string
}

async function call(path: string, body: unknown = {}, options: CallOptions = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.headers ?? {}),
  }
  if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? TOKEN}`

  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.method === 'GET' ? {} : { body: options.body ?? JSON.stringify(body) }),
  })
}

describe('dispatching', () => {
  it('runs an operation and returns its result', async () => {
    const response = await call('/op/sync.status')
    expect(response.status).toBe(200)

    const payload = (await response.json()) as { ok: boolean; data: { connections: unknown[] } }
    expect(payload.ok).toBe(true)
    expect(payload.data.connections).toEqual([])
  })

  it('carries the error taxonomy rather than a stack trace', async () => {
    const response = await call('/op/notes.update', { id: 'note:nope', revision: 1, body: 'x' })
    expect(response.status).toBe(404)

    const payload = (await response.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(payload.error.code).toBe('not_found')
    // Adapters serve third-party software. A raw provider error here would leak
    // internals and be unusable by the caller.
    expect(payload.error.message).not.toMatch(/at \w+ \(/)
  })

  it('maps each error code to a status a client can act on', async () => {
    // 400 for a schema failure...
    expect((await call('/op/notes.create', { subjectKey: 'not-a-key' })).status).toBe(400)
    // ...and 400 for an operation that does not exist, because the registry
    // treats an unknown name as invalid input. Deliberately not translated to
    // 404 here: all three adapters must answer the same way, and matching HTTP
    // convention on one surface would make it the odd one out.
    expect((await call('/op/nope.nope')).status).toBe(400)
  })

  it('refuses a ui-only operation, so the surface itself is the boundary', async () => {
    const response = await call('/op/outbox.mintConfirmation', {
      subjectKey: 'jira:acme.atlassian.net/MERC-1184',
      kind: 'transition-ticket',
      payload: {},
    })

    // XVI: an agent reaching the loopback API cannot authorise its own writes,
    // and the refusal happens in the registry rather than in this adapter.
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toMatch(/not available on the http surface/)
  })

  it('stamps the author from the transport, not from the payload', async () => {
    const response = await call(
      '/op/notes.create',
      {
        subjectKey: 'jira:acme.atlassian.net/MERC-1184',
        type: 'gotcha',
        body: 'Written over the loopback API.',
        // No author field exists on the input schema. If one is ever added,
        // this assertion is what catches it being honoured.
        authorKind: 'user',
      },
      { headers: { 'x-grndctrl-agent': 'claude-code' } },
    )

    const payload = (await response.json()) as { data: { authorKind: string; authorId: string } }
    expect(payload.data.authorKind).toBe('agent')
    expect(payload.data.authorId).toBe('claude-code')
  })
})

describe('the token', () => {
  it('is required', async () => {
    expect((await call('/op/sync.status', {}, { token: null })).status).toBe(401)
  })

  it('rejects a wrong one of the same length', async () => {
    const wrong = 'X'.repeat(TOKEN.length)
    expect((await call('/op/sync.status', {}, { token: wrong })).status).toBe(401)
  })

  it('rejects one of a different length without throwing', async () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning false,
    // so the length has to be checked first. Getting that wrong turns every
    // short token into a 500.
    for (const wrong of ['', 'short', `${TOKEN}extra`]) {
      expect((await call('/op/sync.status', {}, { token: wrong })).status).toBe(401)
    }
  })
})

describe('what a browser can do', () => {
  it('refuses anything carrying an Origin', async () => {
    // A page in the operator's browser can POST to localhost. It cannot remove
    // this header, and without CORS headers it could not read the reply anyway
    // — but refusing outright costs nothing.
    const response = await call('/op/sync.status', {}, { headers: { origin: 'https://evil.invalid' } })
    expect(response.status).toBe(403)
  })

  it('refuses a Host header that is not loopback', async () => {
    // DNS rebinding: an attacker's domain resolving to 127.0.0.1 arrives with
    // their hostname here. Sent through node:http rather than fetch, because
    // `Host` is a forbidden header for fetch and cannot be set from it — which
    // is also why a browser cannot mount this attack directly, and why the
    // check is defence against a non-browser client.
    const status = await rawRequest('evil.invalid')
    expect(status).toBe(403)
  })

  it('sends no CORS headers at all', async () => {
    const response = await call('/op/sync.status')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-credentials')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('refuses anything but POST', async () => {
    expect((await call('/op/sync.status', {}, { method: 'GET' })).status).toBe(405)
  })
})

/** A request with a chosen `Host`, which fetch refuses to send. */
function rawRequest(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: '/op/sync.status',
        headers: {
          host,
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': 2,
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
}

describe('the body', () => {
  it('treats an empty body as an empty object', async () => {
    const response = await call('/op/sync.status', {}, { body: '' })
    expect(response.status).toBe(200)
  })

  it('refuses malformed JSON with a message rather than a crash', async () => {
    const response = await call('/op/sync.status', {}, { body: '{ not json' })
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { error: { message: string } }
    expect(payload.error.message).toMatch(/not valid JSON/)
  })

  it('refuses one that is too large, without buffering all of it', async () => {
    const huge = JSON.stringify({ body: 'x'.repeat(2 * 1024 * 1024) })
    const response = await call('/op/notes.create', {}, { body: huge })
    expect(response.status).toBe(400)
  })
})

describe('the XII conformance gate, against a live server', () => {
  it('exposes exactly what the registry says the http surface should', () => {
    // Read from the registry rather than declared alongside it, so a
    // hand-maintained list cannot drift from what is really served.
    expect(checkConformance(t.registry, [server])).toEqual([])
    expect(server.exposedNames().length).toBeGreaterThan(0)
  })

  it('does not expose the three ui-only operations', () => {
    for (const name of ['outbox.mintConfirmation', 'outbox.enqueue', 'outbox.cancel']) {
      expect(server.exposedNames()).not.toContain(name)
    }
  })
})
