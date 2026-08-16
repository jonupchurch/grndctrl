#!/usr/bin/env node
import { dataDir } from '@grndctrl/core/handshake'
import { serve } from '../dist/server.js'

/**
 * Started by an agent's MCP client, not by Ground Control.
 *
 * Nothing is written to stdout: stdio is the MCP transport, and a stray
 * `console.log` here corrupts the protocol stream. Diagnostics go to stderr.
 */
const dir = process.env.GRNDCTRL_DIR ?? dataDir()
const agentId = process.env.GRNDCTRL_AGENT_ID

await serve({ dir, agentId })
