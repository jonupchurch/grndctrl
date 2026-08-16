import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { appClient, AppNotRunning, OperationFailed, type AppClient } from './client.js'
import { registerOutboxResource } from './resources.js'
import { exposedOperations, TOOLS } from './tools/index.js'

/**
 * `grndctrl-mcp` — the third adapter over the operation registry.
 *
 * It holds no database handle, no credentials, and no product logic. Each tool
 * dispatches one named operation over the loopback API and returns what comes
 * back. Everything an agent can do is an entry in the registry, which is what
 * makes the conformance test meaningful rather than decorative (XII).
 *
 * Two behaviours matter more than they look:
 *
 * - **It never launches the app.** A missing handshake is reported as
 *   `app_not_running` and the server keeps serving. An MCP server that started
 *   a desktop application because an agent listed its tools would be a genuinely
 *   surprising thing to have installed.
 * - **It answers cleanly when the app is down.** Every failure mode — no
 *   handshake, stale handshake, refused connection — becomes one clear message
 *   rather than a crash in the agent's client.
 */

export const SERVER_NAME = 'grndctrl'

export interface ServerOptions {
  /** The data directory holding the handshake file. */
  dir: string
  agentId?: string | undefined
  client?: AppClient | undefined
  version?: string | undefined
}

export function createServer(options: ServerOptions): {
  server: McpServer
  client: AppClient
  stop(): void
} {
  const client =
    options.client ??
    appClient({ dir: options.dir, ...(options.agentId === undefined ? {} : { agentId: options.agentId }) })

  const server = new McpServer({
    name: SERVER_NAME,
    version: options.version ?? '0.0.0',
  })

  for (const binding of TOOLS) {
    server.registerTool(
      binding.tool,
      {
        description: binding.description,
        inputSchema: binding.inputSchema,
        annotations: {
          readOnlyHint: !binding.mutates,
          // Nothing here destroys anything at a provider — Ground Control holds
          // no write authority. The most destructive thing on this surface is
          // deleting a note, and it needs the revision.
          destructiveHint: false,
        },
      },
      async (args: unknown) => call(client, binding.operation, args),
    )
  }

  const resources = registerOutboxResource(server, client)

  return { server, client, stop: () => resources.stop() }
}

/**
 * One place where an operation result becomes an MCP tool result.
 *
 * Failures come back as `isError` content rather than as a thrown exception, so
 * the model sees the message and can act on it — "the app is not running" is
 * something an agent should be able to read and report, not something that
 * should look like the tool itself is broken.
 */
async function call(
  client: AppClient,
  operation: string,
  args: unknown,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const data = await client.call(operation, args ?? {})
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  } catch (e) {
    if (e instanceof AppNotRunning) {
      return {
        content: [
          {
            type: 'text',
            text: `${e.message} Start Ground Control and try again — this server does not launch it.`,
          },
        ],
        isError: true,
      }
    }

    if (e instanceof OperationFailed) {
      return {
        content: [{ type: 'text', text: `${e.code}: ${e.message}` }],
        isError: true,
      }
    }

    // Deliberately opaque. An unexpected throw is the thing most likely to be
    // carrying a URL with a token in it, and this text goes to a third party.
    return { content: [{ type: 'text', text: 'An unexpected error occurred.' }], isError: true }
  }
}

/** What the conformance test compares against the registry. Read from the tool list itself. */
export function mcpAdapterDescriptor(): { surface: 'mcp'; exposedNames: () => string[] } {
  return { surface: 'mcp', exposedNames: exposedOperations }
}

export async function serve(options: ServerOptions): Promise<void> {
  const { server, stop } = createServer(options)
  const transport = new StdioServerTransport()

  transport.onclose = () => {
    stop()
  }

  await server.connect(transport)
}
