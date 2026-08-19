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

  /**
   * The collapsed-region map (007/T102).
   *
   * The reason this has a test of its own is the failure it would otherwise
   * have: `settingsSchema` is a Zod object, so it **strips** keys it does not
   * declare. A `collapsedRegions` added to the type and the defaults but not to
   * the schema would round-trip through `update` losing the value silently, and
   * the symptom is a fold that survives until the next settings write of any
   * kind — a theme change, a project chip — and then quietly reverts.
   */
  it('stores which regions are folded, and reads them back', () => {
    const store = settingsStore(db)

    expect(store.get().collapsedRegions).toEqual({})

    store.update({ collapsedRegions: { prompts: true, court: true } })
    expect(store.get().collapsedRegions).toEqual({ prompts: true, court: true })

    // A write of something else must not disturb it. This is the assertion the
    // stripping failure above would break.
    store.update({ appearance: 'dark' })
    expect(store.get().collapsedRegions).toEqual({ prompts: true, court: true })
  })

  it('takes a region id it has never heard of, because core does not know the screen', () => {
    // Deliberately not an enum of the known ids. Core has no business knowing
    // what regions the one screen has, and an enum here would turn a renamed
    // region into a settings row that fails to parse — which falls back to
    // defaults and takes every other preference with it.
    const store = settingsStore(db)
    store.update({ collapsedRegions: { 'a-region-that-does-not-exist': true } })

    const settings = store.get()
    expect(settings.collapsedRegions).toEqual({ 'a-region-that-does-not-exist': true })
    expect(settings.appearance).toBe(DEFAULT_SETTINGS.appearance)
  })

  it('reads a row written before the key existed as nothing folded', () => {
    // 0.4.0's payload has no `collapsedRegions`. The read merges over the
    // defaults, so it arrives as `{}` — which is exactly what a board nobody has
    // folded should be. This is why there is no migration for the key.
    db.prepare('INSERT INTO settings (id, payload) VALUES (1, ?)').run(
      JSON.stringify({ appearance: 'dark', density: 'compact' }),
    )

    const settings = settingsStore(db).get()
    expect(settings.collapsedRegions).toEqual({})
    expect(settings.appearance).toBe('dark')
  })

  it('keeps exactly one settings row', () => {
    const store = settingsStore(db)
    store.update({ appearance: 'dark' })
    store.update({ appearance: 'light' })

    const count = db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }
    expect(count.c).toBe(1)
  })
})
