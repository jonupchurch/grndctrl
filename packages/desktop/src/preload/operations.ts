/**
 * The entire set of operations the renderer can reach. Written out by hand.
 *
 * The tempting version of the preload is four lines: expose `invoke(name, input)`
 * and let the renderer name whichever operation it wants. That single function is
 * the difference between a bridge and a hole. It would hand a cross-site-scripted
 * renderer — one that rendered a ticket summary containing markup, say — the
 * whole registry, including the `ui-only` operations that exist precisely because
 * no automated caller should reach them: minting a confirmation token, enqueueing
 * an action, removing a connection.
 *
 * So there is no `invoke`. There is this list, and one method per entry, each
 * closing over its own channel.
 *
 * The list is a literal because it has to be. The preload runs in a sandboxed
 * renderer process: it cannot import core, cannot open a database, and cannot
 * ask the registry what exists. What keeps a hand-written list honest is
 * `test/preload-surface.test.ts`, which compares it against
 * `registry.namesFor('ipc')` — so an operation added to core and forgotten here
 * fails the build, the same guarantee the XII conformance gate gives the other
 * two adapters.
 *
 * This module imports nothing, so the test can read the list without executing
 * the preload — which would need an Electron renderer to run in.
 */
export const OPERATIONS = [
  'app.status',
  'board.summary',
  'connections.list',
  'connections.remove',
  'connections.test',
  'focus.clear',
  'focus.get',
  'focus.set',
  'links.resolve',
  'notes.counts',
  'notes.create',
  'notes.delete',
  'notes.list',
  'notes.questions',
  'notes.update',
  'outbox.cancel',
  'outbox.claim',
  'outbox.complete',
  'outbox.enqueue',
  'outbox.fail',
  'outbox.list',
  'outbox.mintConfirmation',
  'outbox.pending',
  'projects.list',
  'projects.remove',
  'projects.upsert',
  'sessions.activity',
  'sessions.end',
  'sessions.heartbeat',
  'sessions.list',
  'sessions.start',
  'settings.get',
  'settings.update',
  'sync.now',
  'sync.status',
  'work.get',
  'work.list',
] as const

export type OperationName = (typeof OPERATIONS)[number]
