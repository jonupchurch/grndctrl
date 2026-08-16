import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from '../src/version.js'

/**
 * The version, which is written down twice.
 *
 * `package.json` carries it because npm requires it there, and `version.ts`
 * carries it because `app.status` reports it and core is bundled into the main
 * process — reading `package.json` at runtime from inside an esbuild bundle
 * means resolving a path that does not exist once the file has been inlined.
 *
 * So two places hold one fact, which is the shape behind most of this
 * project's defects. It is allowed here because both sides are checked against
 * each other; without this test the published version and the reported version
 * would drift at the first release and nothing would notice — `app.status`
 * would confidently name a version nobody shipped, in the report someone opens
 * precisely when they need to know what they are running.
 */

const manifest = (path: string): { version: string } =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', path), 'utf8')) as { version: string }

describe('the version constant', () => {
  it('matches the package it is published as', () => {
    expect(CORE_VERSION).toBe(manifest('package.json').version)
  })

  it('is a real version rather than the placeholder', () => {
    // `0.0.0` is npm's "unpublished" convention, and it is what every package
    // here carried while nothing shipped. Publishing with it still in place
    // would be a release nobody could refer to.
    expect(CORE_VERSION).not.toBe('0.0.0')
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
