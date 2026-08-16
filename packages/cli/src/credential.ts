import { randomUUID } from 'node:crypto'
import { Entry } from '@napi-rs/keyring'
import { appDataDir, credentialRef, credentialRefString, osKeychain, openMirror, mirrorRepository } from '@grndctrl/core'
import type { Connection } from '@grndctrl/core'

/**
 * Getting a real credential into the OS keychain, once.
 *
 * Constitution XI says credentials live in the OS keychain and nowhere else —
 * not in a dotfile, not in an environment file, not in SQLite, not in a log.
 * That leaves a practical question this file answers: how does a token that is
 * currently in the operator's environment get there without passing through
 * somewhere it should not?
 *
 * Three rules, and each rules out a place secrets normally leak to:
 *
 * - **The secret is read from an environment variable, never from an argument.**
 *   `--token abc123` lands in shell history, in the process list where any user
 *   on the machine can read it with `ps`, and in the terminal scrollback. There
 *   is no `--token` flag and there must not be one.
 * - **Nothing is echoed.** Not the value, not a prefix, not the last four
 *   characters. The confirmation says the length and nothing else, which is
 *   enough to catch a truncated paste and useless to anyone reading over a
 *   shoulder.
 * - **The round trip is verified.** Writing to the keychain and assuming it
 *   worked is how an operator discovers a broken keyring at the first sync
 *   instead of here.
 */

export interface CredentialArgs {
  connectionId: string
  kind: 'jira' | 'github'
  siteOrHost: string
  accountLabel: string
  /** The name of the variable holding the secret. Never the secret. */
  fromEnv: string
  dir?: string
}

export function importCredential(
  args: CredentialArgs,
  env: Record<string, string>,
): { output: string; exitCode: number } {
  const secret = env[args.fromEnv]

  if (secret === undefined || secret === '') {
    return {
      output: [
        `${args.fromEnv} is empty.`,
        '',
        'Fill it in .env.local, or set it for one command only:',
        `  $env:${args.fromEnv} = '...'; npm run credential:import`,
        '',
        'The secret is only ever read from a variable. There is no --token flag,',
        'because an argument lands in shell history and in the process list, where',
        'any other account on this machine can read it.',
      ].join('\n'),
      exitCode: 1,
    }
  }

  const trimmed = secret.trim()
  if (trimmed !== secret) {
    // A trailing newline from `Get-Content` or a copy-paste is the single most
    // common cause of a token that looks right and authenticates as nobody.
    return {
      output: `${args.fromEnv} has leading or trailing whitespace. Trim it — a stray newline reads as a different token.`,
      exitCode: 1,
    }
  }

  const dir = args.dir ?? appDataDir()
  const ref = credentialRef(args.connectionId)
  const store = osKeychain((service, account) => new Entry(service, account))

  try {
    store.set(ref, trimmed)
  } catch (e) {
    return {
      output: `Could not reach the OS keychain: ${messageOf(e)}\n\nNothing was stored, and nothing was written anywhere else.`,
      exitCode: 1,
    }
  }

  const readBack = store.get(ref)
  if (readBack !== trimmed) {
    return {
      output: 'The keychain accepted the secret but did not return it. Nothing further was written.',
      exitCode: 1,
    }
  }

  const { db } = openMirror({ dir })
  try {
    const connection: Connection = {
      id: args.connectionId,
      kind: args.kind,
      siteOrHost: args.siteOrHost,
      accountLabel: args.accountLabel,
      viewerIdentity: null,
      // A lookup handle, not the secret. This is the only thing about the
      // credential that touches disk (XI, SC-011).
      credentialRef: credentialRefString(ref),
    }
    mirrorRepository(db).upsertConnection(connection)
  } finally {
    db.close()
  }

  return {
    output: [
      `Stored a ${trimmed.length}-character secret for connection '${args.connectionId}'.`,
      '',
      `  keychain   ${credentialRefString(ref)}`,
      `  kind       ${args.kind}`,
      `  host       ${args.siteOrHost}`,
      `  account    ${args.accountLabel}`,
      `  mirror     ${dir}`,
      '',
      'The connection row holds the keychain handle above and no part of the secret.',
      'Verify with: grndctrl-cli probe',
    ].join('\n'),
    exitCode: 0,
  }
}

export function newConnectionId(kind: string): string {
  return `${kind}-${randomUUID().slice(0, 8)}`
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
