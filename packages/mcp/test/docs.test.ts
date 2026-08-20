import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TOOLS } from '../src/tools/index.js'

/**
 * The `CLAUDE.md` snippet is part of the feature, so it is checked like one
 * (007/T147).
 *
 * Three of 007's four new regions are empty until an agent is *told* to call the
 * tools — connecting the server puts them in a tool list and does nothing else.
 * `docs/agents.md` carries the standing instruction that closes that gap, which
 * makes the tool names in it load-bearing: an operator pastes the block into
 * their repository, an agent reads it, and a name that does not exist produces
 * a failed call and a panel that stays blank for a reason nobody can see from
 * the board.
 *
 * The first draft of that snippet said `grndctrl_create_note`. The tool is
 * called `grndctrl_add_note`. Nothing in the build would have noticed, and the
 * symptom would have been an agent that "does not write notes".
 *
 * This is the same class of gate as `preload-surface.test.ts`: a hand-written
 * list that cannot ask the registry what exists, checked against the thing that
 * does.
 */

const DOCS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'agents.md'),
  'utf8',
)

const NAMES = new Set(TOOLS.map((t) => t.tool))

/**
 * Tools the document names **because they are gone**.
 *
 * Naming a removed tool is correct prose — an agent author who remembers
 * `grndctrl_get_drift` needs to be told it left and why, and deleting the
 * sentence would leave them wondering. So the rule below is "every name either
 * exists or is on this list", and the list is short on purpose: a growing one
 * would turn this gate back into a comment.
 *
 * Each entry is checked in both directions. If one of these ever comes back as
 * a real tool, the second assertion fails and the entry has to be removed —
 * otherwise the exemption would quietly stop meaning anything.
 */
const RETIRED = ['grndctrl_get_drift', 'grndctrl_enqueue_action', 'grndctrl_mint_confirmation']

describe('the tool names in docs/agents.md', () => {
  it('all exist, or are named as retired', () => {
    // Every `grndctrl_*` token in the file, whether it is in the snippet, a
    // table or a sentence. A name mentioned in prose is one somebody will type.
    const mentioned = [...new Set([...DOCS.matchAll(/\bgrndctrl_[a-z_]+\b/g)].map((m) => m[0]))]

    expect(mentioned.length).toBeGreaterThan(10)
    for (const name of mentioned) {
      if (RETIRED.includes(name)) continue
      expect(NAMES.has(name), `docs/agents.md names '${name}', which is not a tool`).toBe(true)
    }
  })

  it('does not exempt a tool that actually exists', () => {
    // The other direction. `grndctrl_enqueue_action` and
    // `grndctrl_mint_confirmation` are named in "what agents cannot do" and must
    // stay absent from the surface — if either appeared, this exemption would be
    // hiding the thing the conformance test exists to catch.
    for (const name of RETIRED) {
      expect(NAMES.has(name), `'${name}' is a real tool and must not be exempt here`).toBe(false)
    }
  })

  it('cover the tools the empty panels depend on', () => {
    // The other direction, and only for the three that matter: these are the
    // tools without which a region added in 007 renders its empty state
    // forever. A snippet that forgot one would be a feature that looks broken
    // on a correctly configured installation.
    for (const required of [
      'grndctrl_start_session',
      'grndctrl_set_active_ticket',
      'grndctrl_post_update',
      'grndctrl_record_prompt',
    ]) {
      expect(DOCS.includes(required), `the CLAUDE.md snippet omits '${required}'`).toBe(true)
    }
  })
})
