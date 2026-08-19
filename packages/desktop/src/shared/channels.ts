/**
 * Every channel name, in one file that imports nothing.
 *
 * Main and preload have to agree on these strings exactly, and they are built by
 * different toolchains into different module formats for different processes —
 * so the usual way they stay in step is a comment saying "keep in sync with",
 * which works until the day it does not. A shared module removes the question.
 *
 * It imports nothing on purpose. The preload is bundled for a sandboxed renderer
 * where `@grndctrl/core` must not appear, and anything this file pulled in would
 * be pulled in there too.
 */

export const OPERATION_CHANNEL_PREFIX = 'grndctrl:op:'

/** One channel per operation. See `main/ipc.ts` for why there is no generic `invoke`. */
export function channelFor(operation: string): string {
  return `${OPERATION_CHANNEL_PREFIX}${operation}`
}

/**
 * Opening a row's provider page.
 *
 * Not an operation — opening the operator's browser is a host affordance of the
 * shell, like the window itself. The URL it opens is not the renderer's: it
 * comes from `links.resolve`, which *is* an operation and is on every surface.
 */
export const OPEN_CHANNEL = 'grndctrl:open'

/**
 * Storing a provider credential.
 *
 * Deliberately **not** an operation. The registry is served on three surfaces —
 * IPC, loopback HTTP and MCP — and `ui-only` is the only thing that would keep a
 * secret off the latter two. That is a property an adapter bug or a careless
 * later edit could get wrong, and the cost of getting it wrong is the operator's
 * token reaching third-party software.
 *
 * A secret that never enters the registry cannot be exposed by getting an
 * exposure wrong. So this channel exists in the shell alone, where the only
 * possible caller is the window the shell created, and it carries the secret
 * exactly one hop: renderer → main → OS keychain (XI, FR-005).
 */
export const CREDENTIAL_CHANNEL = 'grndctrl:credential'

/** Main to renderer, unprompted. See `main/push.ts`. */
export const PUSH_CHANNELS = {
  syncProgress: 'grndctrl:push:sync-progress',
  freshnessTick: 'grndctrl:push:freshness-tick',
  outboxChanged: 'grndctrl:push:outbox-changed',
  sessionsChanged: 'grndctrl:push:sessions-changed',
  focusChanged: 'grndctrl:push:focus-changed',
} as const

/**
 * The channels that are not operations.
 *
 * Pinned as a set so `test/shell-channels.test.ts` can assert the whole
 * non-operation surface, and a fourth entry has to be added here deliberately
 * rather than appearing next to a new `ipcMain.handle` call somewhere.
 */
export const SHELL_CHANNELS = [OPEN_CHANNEL, CREDENTIAL_CHANNEL] as const
