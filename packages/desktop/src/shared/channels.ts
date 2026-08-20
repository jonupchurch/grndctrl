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

/**
 * Opening a link that a ticket description contains.
 *
 * A **third** non-operation channel, and the bar for one is high, so here is the
 * argument. `OPEN_CHANNEL` takes a subject key and no URL, deliberately: the
 * renderer cannot name a destination, so a page with a script in it has nowhere
 * to put one. A link inside a ticket description is an arbitrary provider URL
 * and is not a subject of anything, so the subject-key path cannot carry it.
 *
 * This channel takes a URL — and gives away much less than that sounds, because
 * it also takes the subject whose description is supposed to contain it, and
 * main **refuses any URL that is not actually in that description**. The
 * renderer still cannot name a destination of its own; it can only point at one
 * a provider already put in a ticket the operator can see, and the check happens
 * on main's side of the boundary against core's own copy.
 *
 * Kept separate from `OPEN_CHANNEL` rather than folded into it as an optional
 * field, so that the property "the launcher path has no URL argument" stays
 * exactly true and this narrower capability is a named thing that can be audited
 * on its own.
 */
export const OPEN_URL_CHANNEL = 'grndctrl:open-url'

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
export const SHELL_CHANNELS = [OPEN_CHANNEL, CREDENTIAL_CHANNEL, OPEN_URL_CHANNEL] as const
