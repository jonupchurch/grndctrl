/**
 * Chromium's sandbox, on a Linux install that was never root (T168).
 *
 * Electron's Linux archive ships `chrome-sandbox`, a setuid helper that has to
 * be owned by root with mode 4755. A distribution package installs it that way.
 * `npx grndctrl` cannot: npm unpacks as the invoking user, and an unprivileged
 * process cannot chown a file to root. So Chromium finds the helper, sees it is
 * not configured, and — correctly — aborts rather than run unsandboxed:
 *
 *     FATAL:setuid_sandbox_host.cc(163) The SUID sandbox helper binary was
 *     found, but is not configured correctly.
 *
 * Found by the first Linux CI run of `scripts/verify-npx.mjs`. It would have
 * shipped: every Linux user installing the advertised way would have hit it, and
 * Windows and macOS both pass, so nothing local would ever have shown it.
 *
 * ## Why not just pass `--no-sandbox`
 *
 * Because the renderer displays strings fetched from Jira and GitHub, and
 * `sandbox: true` plus `contextIsolation` in `main/index.ts` are deliberate
 * choices written out rather than inherited. `--no-sandbox` turns off the thing
 * those exist alongside, quietly, on one platform, for everybody.
 *
 * ## What this does instead
 *
 * Chromium has a second sandbox that needs no root: the **namespace sandbox**,
 * built on unprivileged user namespaces. `--disable-setuid-sandbox` selects it.
 * It is a real sandbox — not a weaker mode of the same one, a different
 * implementation of it — so an install that cannot use the setuid helper is
 * still isolated.
 *
 * That leaves exactly three states, and the point of this module is that they
 * stay three rather than collapsing into "it did not start":
 *
 * 1. the helper is root-owned and setuid — use it, add nothing;
 * 2. it is not, but user namespaces are available — use those, and say so;
 * 3. neither — **refuse**, and print the one-time command that fixes it.
 *
 * State 3 is a refusal rather than a silent `--no-sandbox` because the whole
 * argument above would be worthless if the fallback path quietly reached it.
 */

export interface FileOwner {
  uid: number
  /** The permission bits, as `statSync().mode & 0o7777`. */
  mode: number
}

export interface SandboxIo {
  /** Owner uid and permission bits, or null when the file is not there. */
  fileOwner(path: string): FileOwner | null
  /** A small text file's contents, or null when it cannot be read. */
  readSmallFile(path: string): string | null
}

export type SandboxDecision =
  | { kind: 'setuid'; args: readonly string[]; note: null }
  | { kind: 'namespace'; args: readonly string[]; note: string }
  | { kind: 'refuse'; message: string }

/** Root, and the setuid bit set. Anything else and Chromium will not use it. */
export function helperIsUsable(owner: FileOwner | null): boolean {
  if (owner === null) return false
  return owner.uid === 0 && (owner.mode & 0o4000) !== 0
}

/**
 * Whether an unprivileged process may create a user namespace.
 *
 * Three separate knobs, because distributions disagree about which one to use:
 *
 * - `/proc/sys/user/max_user_namespaces` — the count. `0` disables it outright.
 * - `/proc/sys/kernel/unprivileged_userns_clone` — Debian's older switch.
 * - `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` — **Ubuntu 24.04
 *   and later, on by default.** This one is the reason the check cannot simply
 *   read the first file and stop: the count is nonzero, the clone succeeds, and
 *   AppArmor denies it anyway.
 *
 * A file that is absent is not a denial. On a kernel without AppArmor the third
 * path does not exist, and treating "missing" as "restricted" would refuse to
 * launch on the distributions where this works best.
 */
export function userNamespacesAvailable(io: SandboxIo): boolean {
  const number = (path: string): number | null => {
    const raw = io.readSmallFile(path)
    if (raw === null) return null
    const value = Number.parseInt(raw.trim(), 10)
    return Number.isNaN(value) ? null : value
  }

  if (number('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === 1) return false
  if (number('/proc/sys/kernel/unprivileged_userns_clone') === 0) return false

  const max = number('/proc/sys/user/max_user_namespaces')
  if (max !== null && max <= 0) return false

  return true
}

export function refusal(helperPath: string): string {
  return [
    'Ground Control cannot start: Chromium has no sandbox available on this system.',
    '',
    "Electron's setuid sandbox helper has to be owned by root, and an install run",
    'through npx cannot set that — npm unpacks as you, not as root. The fallback,',
    'the user-namespace sandbox, is disabled on this kernel too (Ubuntu 24.04 and',
    'later restrict it by default through AppArmor).',
    '',
    'Either grant the helper the ownership Chromium expects, once:',
    '',
    `  sudo chown root:root ${helperPath}`,
    `  sudo chmod 4755 ${helperPath}`,
    '',
    'or allow unprivileged user namespaces, which needs no ownership change:',
    '',
    '  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0',
    '',
    'Ground Control will not start itself with the sandbox turned off. The window',
    'renders ticket and pull request titles fetched from the network, and the',
    'sandbox is what stands between those and the rest of your machine.',
  ].join('\n')
}

/**
 * Which sandbox to launch with, if any.
 *
 * Only Linux has this problem: macOS and Windows sandbox without a setuid
 * helper, so every other platform returns `setuid` — meaning "add no flags", not
 * "the helper was checked".
 */
export function sandboxDecision(
  platform: string,
  helperPath: string,
  io: SandboxIo,
): SandboxDecision {
  if (platform !== 'linux') return { kind: 'setuid', args: [], note: null }

  if (helperIsUsable(io.fileOwner(helperPath))) return { kind: 'setuid', args: [], note: null }

  if (userNamespacesAvailable(io)) {
    return {
      kind: 'namespace',
      args: ['--disable-setuid-sandbox'],
      note: 'Using the user-namespace sandbox: the setuid helper is not root-owned, which an npx install cannot arrange.',
    }
  }

  return { kind: 'refuse', message: refusal(helperPath) }
}
