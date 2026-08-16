import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LAUNCHER_VERSION } from '../src/index.js'

/**
 * The launcher's version, and the dependency edge that has already broken once.
 *
 * See `packages/core/test/version.test.ts` for why the number is written twice.
 * The second test here is the one specific to this package.
 */

const manifest = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', path), 'utf8')) as Record<string, unknown>

describe('the launcher package', () => {
  it('reports the version it is published as', () => {
    expect(LAUNCHER_VERSION).toBe(manifest('package.json')['version'])
  })

  it('pins @grndctrl/desktop to its own version', () => {
    // These two are released together and the launcher does nothing except find
    // and start the app, so a floating range would let `npx grndctrl` pair a
    // launcher with a desktop build it has never been run against — and the
    // pairing that matters is the ABI, which is exactly what a mismatch breaks.
    //
    // This edge has a history: `bin` was declared with no file behind it, and
    // the launcher resolved `@grndctrl/desktop` without depending on it at all.
    // Both survived every test until something was installed from a tarball.
    const pkg = manifest('package.json')
    const deps = pkg['dependencies'] as Record<string, string>

    expect(deps['@grndctrl/desktop']).toBe(pkg['version'])
  })

  it('ships the bin it declares', () => {
    const bin = manifest('package.json')['bin'] as Record<string, string>
    const entry = bin['grndctrl']

    expect(entry).toBeDefined()
    // The file, not just the field. A `bin` pointing at nothing installs
    // cleanly and fails at the moment somebody runs it.
    expect(() => readFileSync(join(import.meta.dirname, '..', entry ?? ''), 'utf8')).not.toThrow()
  })
})
