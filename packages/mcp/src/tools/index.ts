import { focusTools } from './focus.js'
import { notesTools } from './notes.js'
import { outboxTools } from './outbox.js'
import { promptsTools } from './prompts.js'
import { readTools } from './read.js'
import { sessionsTools } from './sessions.js'
import { updatesTools } from './updates.js'
import type { ToolBinding } from './shared.js'

export type { ToolBinding } from './shared.js'

/**
 * Every MCP tool, as data.
 *
 * This list is the source of truth for what the MCP surface exposes. The server
 * registers exactly these, and the conformance descriptor reports exactly
 * these — so "what does MCP offer?" has one answer rather than a wiring
 * function and a hand-maintained list that agree until they do not (XII).
 */
export const TOOLS: readonly ToolBinding[] = [
  ...readTools,
  ...notesTools,
  ...focusTools,
  ...sessionsTools,
  ...updatesTools,
  ...promptsTools,
  ...outboxTools,
]

/** The registry operations this surface dispatches. What conformance checks. */
export function exposedOperations(): string[] {
  return TOOLS.map((t) => t.operation)
}
