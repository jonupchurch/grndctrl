import type { Registry } from './index.js'
import type { Surface } from './types.js'

/**
 * The gate for constitution XII.
 *
 * XII says a capability reachable through one adapter but not the other is a
 * defect, and that the two returning materially different answers for the same
 * question is also a defect. Both are easy to state and impossible to hold by
 * discipline alone: adapters are edited by different people at different times,
 * and the omission is silent — the API gets a fix the MCP server does not, and
 * an agent acts on a stale understanding of the world.
 *
 * So each adapter reports what it exposes, and this compares that against the
 * registry. A new operation wired into IPC but not MCP fails the build.
 */

export interface AdapterDescriptor {
  surface: Surface
  /** Exactly what this adapter exposes today, read from its own wiring. */
  exposedNames(): string[]
}

export interface ConformanceViolation {
  surface: Surface
  kind: 'missing' | 'unexpected'
  operation: string
  detail: string
}

export function checkConformance(
  registry: Registry,
  adapters: readonly AdapterDescriptor[],
): ConformanceViolation[] {
  const violations: ConformanceViolation[] = []
  const known = new Set(registry.names())

  for (const adapter of adapters) {
    const required = new Set(registry.namesFor(adapter.surface))
    const exposed = new Set(adapter.exposedNames())

    for (const name of required) {
      if (!exposed.has(name)) {
        violations.push({
          surface: adapter.surface,
          kind: 'missing',
          operation: name,
          detail:
            `'${name}' is in the registry and its exposure allows the ${adapter.surface} surface, ` +
            `but that adapter does not expose it. Add it, or change the operation's exposure ` +
            `deliberately (constitution XII).`,
        })
      }
    }

    for (const name of exposed) {
      if (!known.has(name)) {
        violations.push({
          surface: adapter.surface,
          kind: 'unexpected',
          operation: name,
          detail:
            `The ${adapter.surface} adapter exposes '${name}', which is not in the registry. ` +
            `Adapters translate transport; they do not add capability (constitution XII).`,
        })
        continue
      }
      if (!required.has(name)) {
        violations.push({
          surface: adapter.surface,
          kind: 'unexpected',
          operation: name,
          detail:
            `The ${adapter.surface} adapter exposes '${name}', whose exposure does not permit ` +
            `that surface. This is how a UI-only confirmation becomes reachable by an agent.`,
        })
      }
    }
  }

  return violations
}

export function formatViolations(violations: readonly ConformanceViolation[]): string {
  return violations.map((v) => `[${v.surface}] ${v.operation}: ${v.detail}`).join('\n')
}
