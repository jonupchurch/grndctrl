/**
 * Real OS keychain round-trip. Not a unit test — the unit tests use a double,
 * and a double cannot tell you whether Windows Credential Manager, macOS
 * Keychain, or libsecret actually works on this machine.
 *
 * Run it on Windows first (constitution XVII):
 *
 *     npm run keychain:roundtrip -w packages/core
 *
 * It builds first: the script runs against compiled output, because Node's type
 * stripping does not rewrite `.js` import specifiers back to `.ts` sources.
 *
 * It writes a dummy secret, reads it back, deletes it, and confirms it is gone.
 * The value is obviously fake and short-lived; nothing real is ever written.
 */

import { Entry } from '@napi-rs/keyring'
import { credentialRef, osKeychain } from '../dist/auth/keychain.js'

const ACCOUNT = 'roundtrip-check'
const SECRET = `dummy-${Date.now().toString(36)}`

function main(): void {
  const keychain = osKeychain((service, account) => new Entry(service, account))
  const ref = credentialRef(ACCOUNT)

  console.log(`platform: ${process.platform}`)
  console.log(`entry:    ${ref.service}/${ref.account}`)

  // Leave nothing behind from an interrupted earlier run.
  keychain.delete(ref)

  keychain.set(ref, SECRET)
  const readBack = keychain.get(ref)

  if (readBack !== SECRET) {
    console.error(`FAIL: read back ${readBack === null ? 'nothing' : 'a different value'}`)
    process.exitCode = 1
    return
  }
  console.log('write + read: ok')

  const removed = keychain.delete(ref)
  const afterDelete = keychain.get(ref)

  if (!removed || afterDelete !== null) {
    console.error('FAIL: the entry survived deletion')
    process.exitCode = 1
    return
  }
  console.log('delete:       ok')
  console.log('\nOS credential store is working. Nothing was left behind.')
}

try {
  main()
} catch (e) {
  // The expected failure on a headless Linux box with no libsecret provider.
  // Reported as a clear diagnosis rather than a stack trace, because this
  // script exists to answer exactly that question.
  console.error(`FAIL: ${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
}
