/**
 * @grndctrl/core — the service layer.
 *
 * Everything the product can do lands here first. The Electron shell, the
 * loopback HTTP API, and the MCP server are thin adapters over the operation
 * registry (constitution XII); none of them may contain behaviour that is not
 * reachable through it.
 *
 * This package imports nothing from Electron, no UI framework, and nothing that
 * needs a display — constitution XVIII depends on that, and both the lint rule
 * in eslint.config.js and the omitted DOM lib in tsconfig.json enforce it.
 */

export { CORE_VERSION } from './version.js'

export * from './domain/index.js'
export * from './store/index.js'
export * from './registry/index.js'
export { buildRegistry } from './registry/build.js'
export * from './services/settings.js'
export * from './services/app.js'
export * from './auth/keychain.js'
export * from './correlation/index.js'
export * from './providers/index.js'
export * from './services/sync.js'
export * from './services/board.js'
export * from './services/links.js'
// The read shape only. `NoteView` sets the precedent for a service-derived view;
// this one is exported because the interface renders `issueKey`, which the entry
// carries and the domain type does not.
export type { TicketHistoryView } from './services/history.js'
export * from './services/connections.js'
