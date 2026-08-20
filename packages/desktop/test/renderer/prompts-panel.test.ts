import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * FR-139, asserted where it lives (T141).
 *
 * The end-to-end test proves the clipboard ends up holding the whole prompt.
 * What it cannot prove is *where that string came from* — a panel that passed
 * its own rendered text to a channel that accepted text would produce an
 * identical clipboard and an identical green run. The property is about what
 * this module is able to send, so it is asserted against the source, the same
 * way `preload-surface.test.ts` asserts what the bridge is able to expose.
 *
 * The failure this exists to prevent is a plausible one line: the panel already
 * holds `prompt.text` for the preview, so handing it to the copy call looks like
 * saving a round trip. It would also mean a page rendering provider-supplied
 * strings could choose what the operator pastes into a terminal next.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL = readFileSync(join(HERE, '..', '..', 'src', 'renderer', 'panels', 'Prompts.tsx'), 'utf8')
const BRIDGE = readFileSync(join(HERE, '..', '..', 'src', 'renderer', 'bridge.ts'), 'utf8')

describe('the prompts panel', () => {
  it('copies by id and has no way to send a string', () => {
    // The call site takes the id and nothing else. Written as a positive match
    // on the shape rather than a search for the word "text", which appears
    // legitimately three times in the preview.
    expect(PANEL).toMatch(/copyPrompt\(id\)/)
    expect(PANEL).not.toMatch(/copyPrompt\([^)]*text/)
  })

  it('is served by a bridge helper that cannot carry one either', () => {
    // The other half. A panel that only ever passes an id is one edit away from
    // passing more if the function it calls would accept it, so the signature is
    // pinned here too.
    expect(BRIDGE).toMatch(/export async function copyPrompt\(id: string\)/)
    expect(BRIDGE).toMatch(/bridge\.copy\(\{ id \}\)/)
  })

  it('cuts the preview itself rather than leaving the whole prompt in the page', () => {
    /*
     * The difference between this and a CSS ellipsis is the difference between
     * the rest of the prompt being absent and being merely invisible.
     *
     * With `text-overflow: ellipsis` the full string sits in the DOM, so a copy
     * path that read the rendered element would work — and the end-to-end test
     * would pass while the property it was written for had quietly gone. Cutting
     * here means the page genuinely does not contain the rest.
     */
    expect(PANEL).toMatch(/slice\(0, PREVIEW\)/)
  })

  it('reports a failed copy rather than swallowing it', () => {
    // FR-138's second clause. A `.catch(() => undefined)` here would be
    // consistent with the rest of this codebase's fire-and-forget writes and
    // would be wrong for exactly this one: a copy that silently did nothing is
    // discovered at the paste, in another window, much later.
    expect(PANEL).toMatch(/\.catch\(/)
    expect(PANEL).not.toMatch(/\.catch\(\(\) => undefined\)/)
    expect(PANEL).toMatch(/prompt__failed/)
  })

  it('confirms with what came back off the clipboard, not with a fixed word', () => {
    // `length` is read back in main (`main/clipboard.ts`). Showing it makes the
    // confirmation a claim about the clipboard; "Copied!" would be a claim about
    // the click, and the two differ exactly when it matters.
    expect(PANEL).toMatch(/Copied \$\{acknowledged\.length\.toLocaleString\(\)\} characters/)
  })
})
