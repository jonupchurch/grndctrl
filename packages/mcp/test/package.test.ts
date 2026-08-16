import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What `grndctrl-mcp` declares, against what it actually imports.
 *
 * `test/imports.test.ts` already scans every import specifier to keep
 * `better-sqlite3` out of a process delivered by npx. This asks the other half
 * of the same question, and it is the half that npm workspaces hide: **would
 * this still resolve if it were installed rather than hoisted?**
 *
 * It would not have. `src/client.ts` imports `readHandshake` — a value, not a
 * type — from `@grndctrl/core/handshake`, and `@grndctrl/core` was in no
 * dependency list. In the workspace it resolved from the root `node_modules`
 * and every test passed. Published, the first `grndctrl-mcp` launch would have
 * thrown `ERR_MODULE_NOT_FOUND` naming a package the manifest never mentioned.
 *
 * The launcher had the identical defect against `@grndctrl/desktop`. Two
 * instances is a pattern, so it gets a test rather than a fix.
 */

const HERE = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
  files?: string[]
}

/** Every non-relative specifier imported anywhere in `src`. */
function externalImports(): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue

      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? ''
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
        // `@scope/name/subpath` resolves against `@scope/name`.
        const parts = specifier.split('/')
        found.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? ''))
      }
    }
  }
  walk(join(HERE, 'src'))
  return found
}

describe('the published manifest', () => {
  it('declares every package it imports', () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}))
    const missing = [...externalImports()].filter((name) => !declared.has(name))

    expect(missing).toEqual([])
  })

  it('pins @grndctrl/core to its own version', () => {
    // Released together; the handshake format is shared between them and a
    // floating range would let a published mcp read a handshake written by a
    // core it has never been run against.
    expect(pkg.dependencies?.['@grndctrl/core']).toBe(pkg.version)
  })

  it('does not ship its own source or tests', () => {
    // Without a `files` list npm ships the whole directory. Not a leak here,
    // but it puts `src/` and `test/` in every install of a package whose entire
    // job is to be small and start fast.
    expect(pkg.files).toBeDefined()
    expect(pkg.files).not.toContain('src')
    expect(pkg.files).not.toContain('test')
  })
})
