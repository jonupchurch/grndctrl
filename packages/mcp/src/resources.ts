import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AppClient } from './client.js'

/**
 * `grndctrl://outbox/pending` — the queue as a subscribable resource.
 *
 * MCP transport is client-initiated, which is the whole reason the outbox is a
 * durable table rather than a message. An agent that is not connected when the
 * operator confirms an action must still find it later, so **the queue is the
 * contract and this notification is an accelerator** (FR-065). Nothing here may
 * become load-bearing: an agent that only ever acted on a notification would
 * miss every action confirmed while it was offline.
 *
 * The poll interval is deliberately unhurried. It exists to turn "up to a minute
 * late" into "a few seconds late" for a connected agent, not to be the mechanism.
 */

export const PENDING_URI = 'grndctrl://outbox/pending'

/** Long enough not to matter, short enough that a connected agent feels prompt. */
const POLL_MS = 5000

export interface ResourceWiring {
  /** Stop polling. Called when the transport closes. */
  stop(): void
}

export function registerOutboxResource(
  server: McpServer,
  client: AppClient,
  options: { pollMs?: number } = {},
): ResourceWiring {
  server.registerResource(
    'pending-actions',
    PENDING_URI,
    {
      title: 'Pending actions',
      description:
        'Actions the operator has confirmed and nobody has claimed. Subscribe to be told when it changes; poll grndctrl_pending_actions if you were offline.',
      mimeType: 'application/json',
    },
    async () => {
      const pending = await client.call('outbox.pending', {})
      return {
        contents: [
          { uri: PENDING_URI, mimeType: 'application/json', text: JSON.stringify(pending, null, 2) },
        ],
      }
    },
  )

  // Compared as a fingerprint rather than deep-equal: the point is "has the set
  // of things you could claim changed", and ids plus states answer that without
  // re-notifying because a history entry was appended.
  let lastFingerprint: string | null = null

  const timer = setInterval(() => {
    void (async () => {
      try {
        const pending = (await client.call('outbox.pending', {})) as { id: string; state: string }[]
        const fingerprint = pending.map((a) => `${a.id}:${a.state}`).join(',')

        if (lastFingerprint !== null && fingerprint !== lastFingerprint) {
          await server.server.sendResourceUpdated({ uri: PENDING_URI })
        }
        lastFingerprint = fingerprint
      } catch {
        // The app being down is not an error to report here. The agent finds
        // out when it calls a tool, with a message that says so; a notification
        // channel is the wrong place to learn it.
      }
    })()
  }, options.pollMs ?? POLL_MS)

  // Otherwise this timer alone keeps the process alive after the client
  // disconnects, and `npx grndctrl-mcp` never exits.
  timer.unref()

  return { stop: () => clearInterval(timer) }
}
