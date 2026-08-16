/**
 * Record every host this process contacts (T170, SC-010).
 *
 * Loaded ahead of the application, so it sees connections made by code that has
 * no idea it is being watched:
 *
 *   NODE_OPTIONS="--require ./scripts/egress-recorder.cjs" \
 *   GRNDCTRL_EGRESS_LOG=/tmp/egress.txt \
 *   npx grndctrl
 *
 * CommonJS and dependency-free because `--require` predates the module loader
 * and has to work in whatever process it lands in — Node, Electron main, or a
 * utility process.
 *
 * ## What it hooks and why all three
 *
 * `fetch` is what the provider layer uses, `https.request` is what most npm
 * packages use, and `http.request` is what something phoning home over plain
 * HTTP would use. Hooking only `fetch` would miss precisely the dependency this
 * audit exists to catch: the one that does not use the project's own HTTP
 * client.
 *
 * `net.Socket.connect` is deliberately *not* hooked. It would catch a raw
 * socket, and it would also catch every TCP connection the loopback API's own
 * server accepts, drowning the log in `127.0.0.1`. The two higher-level hooks
 * cover every route anything in this dependency tree plausibly takes.
 */

const fs = require('node:fs')
const http = require('node:http')
const https = require('node:https')

const LOG = process.env['GRNDCTRL_EGRESS_LOG']

if (LOG !== undefined && LOG !== '') {
  const seen = new Set()

  const record = (host) => {
    if (typeof host !== 'string' || host === '' || seen.has(host)) return
    seen.add(host)
    try {
      // Appended one host per line, synchronously. A process that exits — or is
      // killed at the end of a timed session — must not lose the last entry,
      // and the last entry is the interesting one often enough to matter.
      fs.appendFileSync(LOG, host + '\n')
    } catch {
      // Never break the application to record something about it.
    }
  }

  const hostOf = (value) => {
    if (typeof value === 'string') {
      try {
        return new URL(value).hostname
      } catch {
        return null
      }
    }
    if (value !== null && typeof value === 'object') {
      const o = value
      if (typeof o.hostname === 'string') return o.hostname
      if (typeof o.host === 'string') return String(o.host).replace(/:\d+$/, '')
      if (typeof o.url === 'string') return hostOf(o.url)
    }
    return null
  }

  for (const mod of [http, https]) {
    for (const name of ['request', 'get']) {
      const original = mod[name]
      mod[name] = function (...args) {
        for (const arg of args) {
          const host = hostOf(arg)
          if (host !== null) {
            record(host)
            break
          }
        }
        return original.apply(this, args)
      }
    }
  }

  const originalFetch = globalThis.fetch
  if (typeof originalFetch === 'function') {
    globalThis.fetch = function (input, init) {
      const host = hostOf(input)
      if (host !== null) record(host)
      return originalFetch.call(this, input, init)
    }
  }

  // A marker, so an empty log and a log from a session where the recorder never
  // loaded are distinguishable. `audit-egress.ts` treats an empty capture as a
  // warning rather than a pass, and this is how it can tell the two apart.
  try {
    fs.appendFileSync(LOG, `# recorder loaded in pid ${process.pid}\n`)
  } catch {
    /* nothing to do */
  }
}
