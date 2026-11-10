import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../../src/registry/index.js'
import { OperationError } from '../../src/registry/errors.js'
import { configOperations } from '../../src/registry/ops/config.js'
import { ticketTagsOperations } from '../../src/registry/ops/ticketTags.js'
import type { Ctx, Surface } from '../../src/registry/types.js'
import { DEFAULT_TICKET_TAGS, settingsStore } from '../../src/services/settings.js'
import { ticketTagsService } from '../../src/services/ticketTags.js'
import { ticketTagsRepository } from '../../src/store/authored/ticketTags.js'
import { openAuthored } from '../../src/store/open.js'

/**
 * 010 — ticket tags, through the registry: one tag per ticket, chosen from the
 * definitions in settings.
 */

const KEY = 'jira:acme.atlassian.net/MERC-1184'
const OTHER = 'jira:acme.atlassian.net/MERC-1201'

interface WireTag {
  ticketKey: string
  issueKey: string
  tagId: string
  label: string
  color: string
  authorKind: 'user' | 'agent'
}

function ctxOn(surface: Surface): Ctx {
  const agent = surface !== 'ipc'
  return {
    authorKind: agent ? 'agent' : 'user',
    authorId: agent ? 'claude-code' : null,
    surface,
    now: () => new Date(Date.UTC(2026, 10, 9, 10)),
  }
}

let dir: string
let close: () => void
let registry: Registry
let settings: ReturnType<typeof settingsStore>

const run = async <T>(op: string, input: unknown, surface: Surface = 'ipc'): Promise<T> =>
  (await registry.dispatch(op, input, ctxOn(surface))) as T

async function refusal(op: string, input: unknown): Promise<OperationError> {
  try {
    await run(op, input)
  } catch (e) {
    if (e instanceof OperationError) return e
    throw e
  }
  throw new Error(`expected '${op}' to be refused`)
}

let ids = 0

beforeEach(() => {
  ids = 0
  dir = mkdtempSync(join(tmpdir(), 'grndctrl-tags-'))
  const opened = openAuthored({ dir })
  close = () => opened.db.close()
  settings = settingsStore(opened.db)

  registry = new Registry()
  const service = ticketTagsService({
    tags: ticketTagsRepository(opened.db),
    definitions: () => settings.get().ticketTags,
    saveDefinitions: (ticketTags) => void settings.update({ ticketTags }),
    newId: () => `tag-${++ids}`,
  })
  for (const op of ticketTagsOperations(service)) registry.register(op)
})

afterEach(() => {
  close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ticket tags', () => {
  it('starts with Blocked, Waiting and Deploy in red, yellow and green', async () => {
    const { definitions, tags } = await run<{ definitions: unknown[]; tags: unknown[] }>(
      'tags.list',
      {},
    )
    expect(definitions).toEqual(DEFAULT_TICKET_TAGS)
    expect(DEFAULT_TICKET_TAGS.map((t) => t.label)).toEqual(['Blocked', 'Waiting', 'Deploy'])
    expect(tags).toEqual([])
  })

  it('puts one tag on a ticket, and a second replaces the first', async () => {
    await run('tags.set', { ticketKey: KEY, tagId: 'blocked' })
    const after = await run<WireTag>('tags.set', { ticketKey: KEY, tagId: 'deploy' })
    expect(after).toMatchObject({ issueKey: 'MERC-1184', tagId: 'deploy', label: 'Deploy' })

    const { tags } = await run<{ tags: WireTag[] }>('tags.list', {})
    expect(tags).toHaveLength(1)
    expect(tags[0]?.tagId).toBe('deploy')
  })

  it('clears with null', async () => {
    await run('tags.set', { ticketKey: KEY, tagId: 'waiting' })
    await run('tags.set', { ticketKey: OTHER, tagId: 'waiting' })
    expect(await run('tags.set', { ticketKey: KEY, tagId: null })).toBeNull()

    const { tags } = await run<{ tags: WireTag[] }>('tags.list', {})
    expect(tags.map((t) => t.issueKey)).toEqual(['MERC-1201'])
  })

  it('refuses a tag that is not defined, naming the ones that are', async () => {
    const e = await refusal('tags.set', { ticketKey: KEY, tagId: 'urgent' })
    expect(e.message).toContain("no tag 'urgent'")
    expect(e.message).toContain('blocked (Blocked)')
  })

  it('refuses a key that is not a ticket', async () => {
    const e = await refusal('tags.set', { ticketKey: 'session:abc', tagId: 'blocked' })
    expect(e.code).toBe('invalid')
  })

  it('lets an agent tag a ticket, and stamps it as the agent', async () => {
    const tag = await run<WireTag>('tags.set', { ticketKey: KEY, tagId: 'blocked' }, 'mcp')
    expect(tag.authorKind).toBe('agent')
    expect((await run<{ tags: unknown[] }>('tags.list', {}, 'mcp')).tags).toHaveLength(1)
  })

  it('follows a rename and a recolour in settings', async () => {
    await run('tags.set', { ticketKey: KEY, tagId: 'blocked' })
    settings.update({
      ticketTags: [{ id: 'blocked', label: 'Stuck', color: '#ff0000' }],
    })
    const { tags } = await run<{ tags: WireTag[] }>('tags.list', {})
    expect(tags[0]).toMatchObject({ label: 'Stuck', color: '#ff0000' })
  })

  it('stops showing a tag once it is deleted from settings', async () => {
    await run('tags.set', { ticketKey: KEY, tagId: 'waiting' })
    settings.update({ ticketTags: [DEFAULT_TICKET_TAGS[0]!] })
    expect((await run<{ tags: unknown[] }>('tags.list', {})).tags).toEqual([])
  })
})

describe('tag definitions in settings', () => {
  it('refuses a colour that is not #rrggbb, and duplicate ids', () => {
    expect(() => settings.update({ ticketTags: [{ id: 'x', label: 'X', color: 'red' }] })).toThrow(
      /colour/,
    )
    expect(() =>
      settings.update({
        ticketTags: [
          { id: 'x', label: 'X', color: '#000000' },
          { id: 'x', label: 'Y', color: '#ffffff' },
        ],
      }),
    ).toThrow(/unique/)
  })

  it('cannot be changed by an agent', async () => {
    const reg = new Registry()
    for (const op of configOperations({ settings } as never)) {
      if (op.name === 'settings.update') reg.register(op)
    }
    await expect(
      reg.dispatch('settings.update', { ticketTags: [] }, ctxOn('mcp')),
    ).rejects.toBeInstanceOf(OperationError)
  })
})

describe('an agent creating a tag (0.11.0)', () => {
  it('creates one with the colour asked for, and can then put it on a ticket', async () => {
    const made = await run<{
      definition: { id: string; label: string; color: string }
      created: boolean
    }>('tags.define', { label: 'Needs design', color: '#7C3AED' }, 'mcp')
    expect(made).toEqual({
      definition: { id: 'tag-1', label: 'Needs design', color: '#7c3aed' },
      created: true,
    })
    expect(settings.get().ticketTags.map((t) => t.label)).toEqual([
      'Blocked',
      'Waiting',
      'Deploy',
      'Needs design',
    ])

    const tag = await run<WireTag>('tags.set', { ticketKey: KEY, tagId: 'tag-1' }, 'mcp')
    expect(tag.label).toBe('Needs design')
  })

  it('picks an unused colour when none is given', async () => {
    const a = await run<{ definition: { color: string } }>('tags.define', { label: 'One' }, 'mcp')
    const b = await run<{ definition: { color: string } }>('tags.define', { label: 'Two' }, 'mcp')
    expect(a.definition.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(b.definition.color).not.toBe(a.definition.color)
  })

  it('returns the existing tag instead of duplicating one, ignoring case', async () => {
    const again = await run<{ definition: { id: string }; created: boolean }>(
      'tags.define',
      { label: '  blocked ' },
      'mcp',
    )
    expect(again).toEqual({ definition: DEFAULT_TICKET_TAGS[0], created: false })
    expect(settings.get().ticketTags).toHaveLength(3)
  })

  it('refuses a bad colour and an over-long name', async () => {
    expect((await refusal('tags.define', { label: 'X', color: 'purple' })).code).toBe('invalid')
    expect((await refusal('tags.define', { label: 'x'.repeat(25) })).code).toBe('invalid')
  })

  it('stops at the tag limit, with the reason', async () => {
    for (let i = 0; i < 21; i++) await run('tags.define', { label: `T${i}` })
    const e = await refusal('tags.define', { label: 'One too many' })
    expect(e.message).toMatch(/ticketTags/)
  })
})
