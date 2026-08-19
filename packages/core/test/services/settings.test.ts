import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, settingsStore } from '../../src/services/settings.js'
import type { Settings } from '../../src/domain/types.js'
import { openAuthored } from '../../src/store/open.js'
import { isOperationError } from '../../src/registry/errors.js'

let dir: string
let db: Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-settings-'))
  db = openAuthored({ dir }).db
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('settings', () => {
  it('returns defaults before anything has been written', () => {
    expect(settingsStore(db).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('persists an update across a reopen', () => {
    settingsStore(db).update({ appearance: 'dark', density: 'compact' })
    db.close()

    const reopened = openAuthored({ dir })
    expect(reopened.db.pragma('journal_mode', { simple: true })).toBeDefined()
    const settings = settingsStore(reopened.db).get()
    expect(settings.appearance).toBe('dark')
    expect(settings.density).toBe('compact')
    reopened.db.close()

    db = openAuthored({ dir }).db
  })

  it('merges a partial update instead of replacing the row', () => {
    const store = settingsStore(db)
    store.update({ appearance: 'dark' })
    const after = store.update({ mineOnly: true })

    expect(after.appearance).toBe('dark')
    expect(after.mineOnly).toBe(true)
    expect(after.density).toBe(DEFAULT_SETTINGS.density)
  })

  // `exactOptionalPropertyTypes` already blocks a typed caller from passing an
  // explicit undefined, so this asserts the runtime guard behind it — settings
  // arrive from an adapter as parsed JSON, where the type system has no say.
  it('does not let an explicit undefined erase a stored value', () => {
    const store = settingsStore(db)
    store.update({ appearance: 'dark' })

    const fromTheWire = JSON.parse('{"appearance": null}') as Record<string, unknown>
    fromTheWire['appearance'] = undefined

    expect(store.update(fromTheWire as Partial<Settings>).appearance).toBe('dark')
  })

  // A floor, not a preference. A five-second poll spends the rate limit on
  // nothing useful, and the failure looks like a broken app rather than a bad
  // setting.
  it('rejects a poll interval that would burn the rate limit', () => {
    const store = settingsStore(db)

    expect(() => store.update({ pollIntervalSec: { jira: 5 } })).toThrow()
    try {
      store.update({ pollIntervalSec: { jira: 5 } })
    } catch (e) {
      expect(isOperationError(e) && e.code).toBe('invalid')
    }

    // And the rejected update leaves the stored value alone.
    expect(store.get().pollIntervalSec.jira).toBe(DEFAULT_SETTINGS.pollIntervalSec.jira)
  })

  it('rejects a heartbeat multiplier low enough to report live agents as dead', () => {
    expect(() => settingsStore(db).update({ heartbeatMissMultiplier: 1 })).toThrow()
  })

  // A settings row written by an older version is missing keys the current one
  // expects. Refusing to launch over a missing preference would be absurd.
  it('fills in keys a row from an older version does not have', () => {
    db.prepare('INSERT INTO settings (id, payload) VALUES (1, ?)').run(
      JSON.stringify({ appearance: 'dark' }),
    )

    const settings = settingsStore(db).get()
    expect(settings.appearance).toBe('dark')
    expect(settings.laneThresholdHours).toEqual(DEFAULT_SETTINGS.laneThresholdHours)
    expect(settings.heartbeatMissMultiplier).toBe(DEFAULT_SETTINGS.heartbeatMissMultiplier)
  })

  it('falls back to defaults rather than blocking launch on an unreadable row', () => {
    db.prepare('INSERT INTO settings (id, payload) VALUES (1, ?)').run('{not json at all')
    expect(settingsStore(db).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps exactly one settings row', () => {
    const store = settingsStore(db)
    store.update({ appearance: 'dark' })
    store.update({ appearance: 'light' })

    const count = db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }
    expect(count.c).toBe(1)
  })
})
