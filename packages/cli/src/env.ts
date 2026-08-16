import { readFileSync } from 'node:fs'

/**
 * A minimal `.env` reader, for the one-step credential hand-off.
 *
 * Hand-written rather than a dependency, for a reason worth stating: this is
 * the only code in the product that ever touches a file containing a live
 * secret, and it is fifteen lines. A package here would mean a supply-chain
 * surface on the exact path a token travels — which is a poor trade for
 * quote-stripping.
 *
 * It returns the values rather than mutating `process.env`. A secret placed in
 * the environment is inherited by every child process from then on, and this
 * process shells out to `git`.
 */
export function readEnvFile(path: string): Record<string, string> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }

  const values: Record<string, string> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const equals = trimmed.indexOf('=')
    if (equals === -1) continue

    const key = trimmed.slice(0, equals).trim().replace(/^export\s+/, '')
    let value = trimmed.slice(equals + 1).trim()

    // Strip one matched pair of quotes. A token pasted with quotes and stored
    // with them authenticates as nobody, and the error says "bad credentials"
    // rather than "you have quotes in there".
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }

    if (key !== '') values[key] = value
  }

  return values
}

/**
 * The environment, with a file layered underneath it.
 *
 * A real environment variable wins over the file, so `$env:X = ...; grndctrl-cli
 * ...` works for anyone who would rather not have a secret in a file at all —
 * which is the better habit, and should not be harder than the convenient one.
 */
export function resolveEnv(filePath: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const fromFile = readEnvFile(filePath)
  const merged: Record<string, string> = { ...fromFile }

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') merged[key] = value
  }

  return merged
}
