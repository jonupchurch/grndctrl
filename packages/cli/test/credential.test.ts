import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readEnvFile, resolveEnv } from '../src/env.js'

/**
 * The credential hand-off, which is the one path in this product a live secret
 * travels along.
 *
 * The keychain write itself is covered by core's round-trip against the real
 * Windows Credential Manager. What is checked here is everything around it: the
 * parsing that turns a pasted line into a token, and the promise that the token
 * does not end up anywhere else on the way past.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-env-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function envFile(contents: string): string {
  const path = join(dir, '.env.local')
  writeFileSync(path, contents)
  return path
}

describe('reading the hand-off file', () => {
  it('reads plain assignments and skips comments and blanks', () => {
    const path = envFile(
      ['# a comment', '', 'GRNDCTRL_GITHUB_TOKEN=github_pat_example', '  ', 'X=1'].join('\n'),
    )

    expect(readEnvFile(path)).toEqual({ GRNDCTRL_GITHUB_TOKEN: 'github_pat_example', X: '1' })
  })

  it('strips one matched pair of quotes', () => {
    // A token stored with its quotes authenticates as nobody, and GitHub's
    // error says "bad credentials" rather than "you have quotes in there".
    expect(readEnvFile(envFile('A="quoted"\nB=\'single\'\nC=un"even'))).toEqual({
      A: 'quoted',
      B: 'single',
      C: 'un"even',
    })
  })

  it('handles `export` prefixes and CRLF line endings', () => {
    expect(readEnvFile(envFile('export A=1\r\nB=2\r\n'))).toEqual({ A: '1', B: '2' })
  })

  it('treats a missing file as empty rather than an error', () => {
    // The normal case before anyone has filled anything in. It must produce a
    // helpful message from the command, not a stack trace.
    expect(readEnvFile(join(dir, 'nope'))).toEqual({})
  })

  it('keeps an empty value empty, so a blank line is not "set"', () => {
    expect(readEnvFile(envFile('GRNDCTRL_GITHUB_TOKEN='))).toEqual({ GRNDCTRL_GITHUB_TOKEN: '' })
  })
})

describe('a real environment variable', () => {
  it('wins over the file', () => {
    const path = envFile('A=from-file')
    // So that `$env:A = '...'; npm run credential:import` works for anyone who
    // would rather not put a secret in a file at all — the better habit should
    // not be the harder one.
    expect(resolveEnv(path, { A: 'from-env' })['A']).toBe('from-env')
  })

  it('does not let an empty variable mask a filled-in file', () => {
    const path = envFile('A=from-file')
    expect(resolveEnv(path, { A: '' })['A']).toBe('from-file')
  })
})

describe('where the secret does not go', () => {
  it('is never placed into process.env', () => {
    // A secret in the environment is inherited by every child process from then
    // on, and this process shells out to git.
    const path = envFile('GRNDCTRL_GITHUB_TOKEN=github_pat_secret_value')
    readEnvFile(path)
    resolveEnv(path, {})

    expect(process.env['GRNDCTRL_GITHUB_TOKEN']).toBeUndefined()
  })

  it('is not written anywhere by reading it', () => {
    const path = envFile('GRNDCTRL_GITHUB_TOKEN=github_pat_secret_value')
    resolveEnv(path, {})

    // Every file in the directory, byte for byte — a column scan would miss a
    // temp file, and the temp file is exactly what a careless implementation
    // leaves behind.
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (!statSync(full).isFile() || full === path) continue
      expect(readFileSync(full, 'utf8')).not.toContain('github_pat_secret_value')
    }
  })
})

describe('the committed template', () => {
  it('has no value on any line', () => {
    // `.env.example` is not gitignored. A value committed here would be a
    // credential in the repository, which is the thing all of this exists to
    // prevent.
    const example = readFileSync(join(import.meta.dirname, '..', '..', '..', '.env.example'), 'utf8')

    for (const [name, value] of Object.entries(readEnvFile2(example))) {
      expect(value, `${name} has a value in the committed template`).toBe('')
    }
  })
})

/** Same parse, against a string rather than a path. */
function readEnvFile2(contents: string): Record<string, string> {
  const path = join(tmpdir(), `grndctrl-example-${process.pid}.env`)
  writeFileSync(path, contents)
  try {
    return readEnvFile(path)
  } finally {
    rmSync(path, { force: true })
  }
}
