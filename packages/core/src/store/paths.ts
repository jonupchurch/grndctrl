import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/**
 * Where Ground Control's data lives.
 *
 * Resolved natively rather than through Electron's `app.getPath('userData')`,
 * because `core` may not import Electron (constitution XVIII) — and because the
 * headless core, the CLI, and the MCP server all need to find the same
 * directory without a desktop shell running.
 *
 * All state is local. Nothing here is ever synchronised anywhere (XI).
 */

const APP_DIR = 'grndctrl'

/**
 * The per-user data directory, following each platform's own convention.
 *
 * `GRNDCTRL_DATA_DIR` overrides it everywhere. That exists for the end-to-end
 * suite, which drives a real Electron build and would otherwise write notes,
 * sessions and dispatched actions into the operator's actual database — and
 * would read their real projects while asserting on an empty board. The
 * alternative is per-platform trickery with `LOCALAPPDATA` and `XDG_DATA_HOME`
 * that works on whichever machine it was written on.
 */
export function appDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['GRNDCTRL_DATA_DIR']
  if (override !== undefined && override.trim() !== '') return override.trim()

  switch (platform()) {
    case 'win32': {
      // LOCALAPPDATA rather than APPDATA: this is machine-local cache and state,
      // and roaming profiles should not drag a SQLite mirror across the network.
      const base = env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
      return join(base, APP_DIR)
    }
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', APP_DIR)
    default: {
      const base = env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share')
      return join(base, APP_DIR)
    }
  }
}

/**
 * The disposable provider cache. Deleting this file is a supported operation
 * (XIII) — the app rebuilds it from the providers and no authored data is lost.
 */
export function mirrorDbPath(dir: string = appDataDir()): string {
  return join(dir, 'mirror.db')
}

/**
 * The user's own data: notes, sessions, dispatched actions, projects, settings.
 * A sync must never write here, and no migration here may lose a row — there is
 * no server-side copy to restore from (XI).
 */
export function authoredDbPath(dir: string = appDataDir()): string {
  return join(dir, 'authored.db')
}

/**
 * Where the MCP server looks to find a running app: an ephemeral port and a
 * per-launch token. Not a provider credential — see research R1 — but still a
 * secret, so it is created with user-only permissions and deleted on exit.
 */
export function handshakePath(dir: string = appDataDir()): string {
  return join(dir, 'runtime.json')
}
