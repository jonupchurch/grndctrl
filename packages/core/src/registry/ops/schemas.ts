import { z } from 'zod'
import type { NaturalKey } from '../../domain/keys.js'
import { subjectKindOf } from '../../domain/keys.js'

/**
 * Schemas shared across operation modules.
 *
 * These sit at a trust boundary: every value reaching a handler has come from a
 * renderer, an agent over MCP, or an HTTP client, and none of the three is
 * trusted (Principle II). The registry revalidates on dispatch, so this is where
 * "a string" becomes "a key this product recognises".
 */

/**
 * A natural key, checked for shape rather than existence.
 *
 * Refusing an unrecognised prefix is cheap and catches the real mistake — an
 * agent passing a Jira id, a row id, or a URL where a key belongs. It says
 * nothing about whether the subject exists, and must not: notes deliberately
 * outlive their subjects (FR-056).
 */
export const naturalKeySchema = z.custom<NaturalKey>(
  (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && subjectKindOf(v) !== null,
  {
    message:
      'not a recognised subject key — expected one of jira:, gh:, repo:, ws:, session:, check:',
  },
)

export const noteTypeSchema = z.enum(['decision', 'gotcha', 'question-for-human', 'todo'])

/** The wire form of a note. `subjectKey` is a plain string here — brands do not survive JSON. */
export const noteSchema = z.object({
  id: z.string(),
  subjectKey: z.string(),
  type: noteTypeSchema,
  body: z.string(),
  authorKind: z.enum(['user', 'agent']),
  authorId: z.string().nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
  subjectPresence: z.enum(['present', 'absent', 'unknown']),
  orphaned: z.boolean(),
})

/**
 * Every timestamp crossing a boundary is absolute ISO-8601.
 *
 * Never "3 minutes ago". A relative string is computed once and then lies for as
 * long as it is held — and an agent may hold a board response for the length of
 * a task (XIV).
 */
export const timestampSchema = z.string().datetime({ offset: true })
