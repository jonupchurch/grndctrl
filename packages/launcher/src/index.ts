/**
 * grndctrl launcher — resolves the Electron runtime, verifies it, caches it per
 * machine, and spawns the app (T160–T165).
 *
 * Deliberately dependency-free. This package installs and runs *before* the
 * Electron runtime exists on the machine, so anything it pulls in is time the
 * user spends waiting at `npx grndctrl` — and every transitive dependency here
 * is code that runs before a single checksum has been verified.
 *
 * The order of operations is the load-bearing part and it lives in `launch.ts`:
 * verify before extracting, check the ABI before spawning, and leave no cache
 * entry behind when either fails.
 */

export const LAUNCHER_VERSION = '0.1.0'

export { abiMismatch, probeRuntime, type AbiCheck, type ProbeIo, type RuntimeIdentity } from './abi.js'
export {
  cacheRoot,
  ensureRuntime,
  slotFor,
  slotName,
  stale,
  type CacheIo,
  type CacheTarget,
  type InstallRequest,
} from './cache.js'
export {
  assetName,
  assetUrl,
  checksumUrl,
  digestFor,
  executablePath,
  fetchRuntime,
  sha256,
  ELECTRON_RELEASES,
  type DownloadIo,
  type FetchRequest,
  type RuntimeTarget,
} from './runtime.js'
export { extractorFor, unpackFailure, type Extractor } from './unpack.js'
export {
  helperIsUsable,
  refusal,
  sandboxDecision,
  userNamespacesAvailable,
  type FileOwner,
  type SandboxDecision,
  type SandboxIo,
} from './sandbox.js'
export {
  launch,
  LaunchError,
  type AppRequirements,
  type LaunchIo,
  type LaunchRequest,
} from './launch.js'
