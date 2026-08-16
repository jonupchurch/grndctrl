import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry } from '../../src/registry/build.js'
import type { Registry } from '../../src/registry/index.js'
import { createCoreServices, type CoreServices } from '../../src/runtime/services.js'

/**
 * The real composition root over a throwaway data directory.
 *
 * Tests that care about the registry's *shape* still need real services to
 * build it from, because the registry is assembled from them. A stub bundle
 * would let an operation be registered here that could never be registered for
 * real, which is the opposite of what a conformance test is for.
 */
export interface TempServices {
  dir: string
  services: CoreServices
  registry: Registry
  dispose(): void
}

export function tempServices(): TempServices {
  const dir = mkdtempSync(join(tmpdir(), 'grndctrl-services-'))
  const services = createCoreServices({ dir })

  return {
    dir,
    services,
    registry: buildRegistry(services),
    dispose() {
      services.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
