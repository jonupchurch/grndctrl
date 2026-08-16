import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Entry } from '@napi-rs/keyring'
import {
  appDataDir,
  buildRegistry,
  osKeychain,
  type AddConnectionInput,
  type Connection,
} from '@grndctrl/core'
import { startLoopbackAdapter, type LoopbackServer } from '@grndctrl/core/adapters/http'
import { writeHandshake, type HandshakeHandle } from '@grndctrl/core/handshake'
import type { Ctx } from '@grndctrl/core/registry'
import { createCoreServices } from '@grndctrl/core/runtime'
import type { OperationDescriptor } from './ipc.js'

/**
 * Where core is hosted, and the seam it is hosted behind.
 *
 * v1 runs the service layer in the Electron main process (decision 13). That is
 * the cheap answer and it is the right one until something measures a dropped
 * frame — but "cheap now, expensive to move later" is how a main process ends up
 * with a database in it permanently, so the move has to stay cheap on purpose.
 *
 * This file is the whole of what would change. Everything else in `main/` holds
 * an `AppService` and calls `dispatch`, which is already asynchronous and
 * already takes only structured-cloneable values. Moving core to
 * `utilityProcess.fork` replaces the body of `dispatch` with a message round
 * trip and touches nothing else — no handler, no channel, no preload method.
 *
 * The three things that would otherwise leak across that seam are deliberately
 * kept on this side of it:
 *
 * - **The database handles.** Nothing outside this file has one.
 * - **The keychain.** The real OS keychain is injected here, so core stays
 *   importable with no native binding (XVIII) and the CLI keeps working.
 * - **The loopback adapter and the handshake.** MCP reaches core over HTTP
 *   whether core is in this process or another one, so hosting them next to
 *   core means the MCP surface is unaffected by the move.
 */

export interface AppService {
  /**
   * Store a provider credential.
   *
   * Deliberately outside `dispatch`: it is not an operation, it carries a
   * secret, and the registry it would otherwise join is served on the loopback
   * API and MCP as well as IPC. Synchronous because the keychain is.
   */
  addConnection(input: AddConnectionInput): Connection

  /**
   * Run an operation. The only way anything in `main/` reaches core.
   *
   * Async and structured-clone-safe by construction, so this signature survives
   * core moving out of the process.
   */
  dispatch(name: string, input: unknown, ctx: Omit<Ctx, 'now'>): Promise<unknown>

  /**
   * Whether an operation changes anything, straight from the registry.
   *
   * Exposed so `main/push.ts` can decide what to announce without keeping a list
   * of its own. It kept one for about an hour: matching `sessions.` by prefix
   * announced `sessions.list`, the renderer answered an announcement by
   * refetching, the refetch *was* a `sessions.list`, and one agent call produced
   * hundreds of broadcasts. The registry already knows which operations write.
   */
  mutates(operation: string): boolean
  /**
   * What the IPC adapter must expose, read from the registry rather than a list.
   *
   * The schema travels with the name because the adapter validates before
   * dispatching (`ipc.ts`). Schemas are pure data — no database, no services —
   * so this half of an operation stays available on the main-process side of the
   * seam even if the handlers move out of it.
   */
  operations(): OperationDescriptor[]
  /** The loopback API `grndctrl-mcp` connects to. Present even with no UI open. */
  loopback: LoopbackServer
  handshake: HandshakeHandle
  close(): Promise<void>
}

export interface AppServiceOptions {
  /** Overridden in tests. Production uses the platform data directory. */
  dir?: string
  now?: () => Date
  /**
   * Called after every operation an **agent** dispatches over the loopback API,
   * whether it succeeded or threw.
   *
   * This exists because the push events had a hole in exactly the shape of the
   * agent surface. `main/index.ts` wraps the dispatch it hands the IPC adapter,
   * so the window updated itself whenever the window acted; the loopback adapter
   * below dispatches straight through the registry, so nothing the *agent* did
   * ever reached the renderer. `outbox:changed` documented itself as firing "by
   * this window or by an agent over MCP" and did not.
   *
   * Deliberately a notification and not a wrapper: this must never be able to
   * change what an agent gets back, or to fail its call. A window that missed a
   * refresh is a nuisance; an agent whose `outbox.claim` threw because a
   * renderer was not listening is a defect.
   */
  onAgentDispatch?: (operation: string) => void
}

/**
 * The Electron-ABI build of `better-sqlite3`, when running under Electron.
 *
 * A native addon is compiled against one ABI — Node 22 is
 * `NODE_MODULE_VERSION` 127, Electron 33 is 130 — and this checkout has to
 * serve both: the suite runs under Node, because XVIII requires the engine to
 * be testable with no Electron, and the app runs under Electron. So the copy in
 * `node_modules` stays exactly as npm built it, and a second copy lives beside
 * this package, fetched by `scripts/fetch-native.mjs`.
 *
 * The runtime check is the whole selection rule, and it is checked rather than
 * configured on purpose: an option would be a thing to pass correctly, and this
 * file is imported by tests that run under Node and by a main process that runs
 * under Electron, in the same repository, on the same day.
 *
 * `undefined` sends `better-sqlite3` back to its default lookup — correct under
 * Node, and under Electron it produces an error naming the ABI mismatch, which
 * is a better clue than anything invented here.
 */
/**
 * Where the Electron-ABI `better-sqlite3` binding is, on *this* machine.
 *
 * The launcher supplies it. A native addon is specific to an ABI, a platform and
 * an architecture; an npm tarball is specific to none of those, so the binary
 * cannot travel in the package — v0.1.0 tried, and every Windows and macOS user
 * received the Linux build that `release.yml`'s ubuntu runner had fetched.
 *
 * The package-relative path is still checked second, for a checkout that has run
 * `npm run native`. It is not a fallback for a published install: there, the file
 * is absent by design and its absence must not be papered over — returning
 * `undefined` would let `better-sqlite3` load its own Node-ABI copy and fail at
 * `dlopen` with a message about module versions, which is the confusing error
 * this whole path exists to prevent.
 */
function electronSqliteBinding(): string | undefined {
  if (process.versions['electron'] === undefined) return undefined

  const supplied = process.env['GRNDCTRL_NATIVE_BINDING']
  if (supplied !== undefined && supplied !== '' && existsSync(supplied)) return supplied

  const local = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'native',
    'better_sqlite3.node',
  )

  return existsSync(local) ? local : undefined
}

export async function startAppService(options: AppServiceOptions = {}): Promise<AppService> {
  const dir = options.dir ?? appDataDir()
  const now = options.now ?? (() => new Date())

  const services = createCoreServices({
    dir,
    // The real keychain, injected rather than imported by core. `@napi-rs/keyring`
    // is a native module; core must build and test without one (XVIII), so the
    // host is what supplies it — here, and in the CLI, and nowhere else. It is
    // N-API, so unlike SQLite below it is ABI-stable across the two runtimes.
    credentials: osKeychain((service, account) => new Entry(service, account)),
    nativeBinding: electronSqliteBinding(),
  })

  const registry = buildRegistry(services)

  const loopback = await startLoopbackAdapter({
    registry,
    now,
    // The agent's half of the push stream. The first attempt at this wrapped the
    // registry here instead — which TypeScript refused, correctly: `Registry` is
    // a class with a private field, so spreading it would have produced an
    // object missing every prototype method. The hook belongs in the adapter,
    // which is the thing that knows a dispatch happened.
    ...(options.onAgentDispatch === undefined ? {} : { onDispatched: options.onAgentDispatch }),
  })

  // Written last, once there is genuinely something on the other end of it. A
  // handshake file that exists before the port is listening is a race an agent
  // loses by connecting to nothing.
  const handshake = writeHandshake(dir, {
    port: loopback.port,
    token: loopback.token,
    pid: process.pid,
  })

  return {
    dispatch: (name, input, ctx) => registry.dispatch(name, input, { ...ctx, now }),

    // Unknown operations answer `false`. Dispatching one fails anyway, and
    // "announce a change for something that does not exist" is the wrong
    // direction to guess in.
    mutates: (operation) => registry.get(operation)?.mutates ?? false,

    operations: () =>
      registry.namesFor('ipc').map((name) => {
        const op = registry.get(name)
        // `namesFor` reads the same map `get` does, so this cannot happen. It is
        // asserted rather than assumed because the alternative is a non-null
        // assertion that would still be there if the two ever diverged.
        if (op === undefined) throw new Error(`Registry lost operation '${name}'.`)
        return { name, input: op.input }
      }),

    // Not routed through `dispatch`, because it is not an operation and must
    // never become one: the registry is served on three surfaces and this
    // carries a secret. See `shared/channels.ts`.
    addConnection: (input) => services.connections.add(input),

    loopback,
    handshake,

    async close() {
      // Order matters on the way down as much as on the way up: stop advertising
      // the port, then stop serving it, then close the files. Reversing the
      // first two leaves a window where an agent reads a live handshake for a
      // server that has stopped answering.
      handshake.remove()
      await loopback.close()
      services.close()
    },
  }
}
