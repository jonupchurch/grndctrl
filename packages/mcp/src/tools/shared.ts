import { z, type ZodRawShape } from 'zod'

/**
 * What a tool is here: a name, a description written for a model to read, an
 * input schema, and **the registry operation it dispatches**.
 *
 * Nothing else — no handler, no branching, no local logic. That is what makes
 * this package an adapter rather than a second implementation, and it is what
 * lets the conformance test compare the tool list against the registry without
 * starting anything (XII, T120).
 */
export interface ToolBinding {
  /** The MCP tool name, as an agent sees it. */
  tool: string
  /** The registry operation it dispatches. */
  operation: string
  /** Written for a model, not for a changelog. Says when to reach for it. */
  description: string
  inputSchema: ZodRawShape
  /** True for tools that change something, so a client can gate them. */
  mutates: boolean
}

/** Shared fragments, so the same concept is spelled the same way in every tool. */
export const subjectKey = z
  .string()
  .describe(
    'A natural key: jira:<site>/<ISSUE-KEY>, gh:<owner>/<repo>#<number>, repo:<remote>#<branch>, ws:<remote>#<branch>@<worktree>, or session:<agent>/<id>.',
  )

export const projectId = z
  .string()
  .nullable()
  .optional()
  .describe('Limit to one project. Omit for everything.')

export const agentRef = {
  agentId: z.string().describe('Your agent identifier, stable across sessions. e.g. "claude-code".'),
  sessionId: z.string().describe('Your identifier for this session. Reusing it resumes it.'),
  at: z
    .string()
    .optional()
    .describe(
      'When this happened, ISO-8601 with an offset. Omit to use receipt time. A timestamp in the future is clamped.',
    ),
}
