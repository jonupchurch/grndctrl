import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import type { Settings } from '../domain/types.js'
import { invalid } from '../registry/errors.js'

/**
 * Settings live in `authored.db` — they are the user's, not a cache, and a sync
 * must never touch them (constitution XIII). Stored as one JSON row rather than
 * a column per field, because the shape changes often and an authored migration
 * may never lose data; adding a key with a default is safer than an ALTER on
 * the one table there is no backup for.
 */

export const DEFAULT_SETTINGS: Settings = {
  appearance: 'system',
  density: 'comfortable',
  // 5min. Jira status changes do not reward a tighter loop, and the ticket poll
  // costs two calls now that history is a separate fetch (R2). The 60s GitHub
  // interval that sat beside it was for CI and review state, which move on a
  // human timescale; nothing left here does.
  pollIntervalSec: { jira: 300 },
  // `sessions` takes the old `pulls` value of 24, which is a carry-over rather
  // than a rename — see the type. A session that has not reported in a day is
  // the thing this threshold is about.
  laneThresholdHours: { tickets: 72, sessions: 24 },
  heartbeatMissMultiplier: 3,
  activeProjectId: null,
  mineOnly: false,
  windowGeometry: null,
  // Off by default. A window that puts itself over everything else without
  // being asked is the behaviour people disable an application over.
  alwaysOnTop: false,
}

const geometrySchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export const settingsSchema = z.object({
  appearance: z.enum(['system', 'light', 'dark']),
  density: z.enum(['comfortable', 'compact']),
  pollIntervalSec: z.object({
    // A floor, not a preference. The failure from a too-tight poll looks like a
    // broken app rather than a bad setting.
    jira: z.number().int().min(30).max(3600),
  }),
  laneThresholdHours: z.object({
    tickets: z.number().min(1).max(24 * 90),
    sessions: z.number().min(1).max(24 * 90),
  }),
  // Below 2, one dropped heartbeat on a busy machine reads as a dead agent.
  heartbeatMissMultiplier: z.number().int().min(2).max(10),
  activeProjectId: z.string().nullable(),
  mineOnly: z.boolean(),
  windowGeometry: geometrySchema.nullable(),
  alwaysOnTop: z.boolean(),
})

export interface SettingsStore {
  get(): Settings
  /**
   * `| undefined` spelled out on every key: patches arrive from a Zod-parsed
   * payload where an absent key really is `undefined`, and `exactOptionalPropertyTypes`
   * treats that as different from missing. `stripUndefined` is what makes it safe.
   */
  update(patch: { [K in keyof Settings]?: Settings[K] | undefined }): Settings
}

export function settingsStore(db: Database): SettingsStore {
  const read = (): Settings => {
    const row = db.prepare('SELECT payload FROM settings WHERE id = 1').get() as
      | { payload: string }
      | undefined

    if (row === undefined) return DEFAULT_SETTINGS

    // Merged over the defaults rather than parsed strictly: a settings row
    // written by an older version is missing keys the current one expects, and
    // refusing to start over a missing preference would be absurd. An unusable
    // row falls back to defaults rather than blocking launch.
    const parsed = settingsSchema.partial().safeParse(safeJson(row.payload))
    return parsed.success ? { ...DEFAULT_SETTINGS, ...stripUndefined(parsed.data) } : DEFAULT_SETTINGS
  }

  const write = (settings: Settings): void => {
    db.prepare(
      `INSERT INTO settings (id, payload) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
    ).run(JSON.stringify(settings))
  }

  return {
    get: read,

    update(patch) {
      const merged = { ...read(), ...stripUndefined(patch) }
      const parsed = settingsSchema.safeParse(merged)

      if (!parsed.success) {
        throw invalid(
          `Invalid settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        )
      }

      write(parsed.data)
      return parsed.data
    },
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * `{ density: undefined }` must not erase a stored value on a partial update.
 *
 * The return type drops `undefined` from each value rather than staying
 * `Partial<T>`, so that spreading the result over a complete object still
 * produces a complete object under `exactOptionalPropertyTypes`.
 */
function stripUndefined<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>
  }
}
