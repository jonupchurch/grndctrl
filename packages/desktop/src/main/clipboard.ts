/**
 * The one place a string becomes something the operator will paste (FR-138,
 * FR-139).
 *
 * The shape is `main/links.ts`'s, applied to a different destination, and for
 * the same reason: **the renderer names a stored thing, not a value.** It sends
 * a prompt id, main reads that prompt through `prompts.get`, and what reaches
 * the clipboard is what main read. A page with an injected script in it can ask
 * for any id it likes and every one of them resolves to something an agent
 * actually recorded — where a channel taking text would let it stage anything at
 * all for the operator to paste into a terminal.
 *
 * The renderer does hold the text: the panel lists prompts, and a list of
 * prompts is a list of their text. That is not the same capability. Displaying a
 * string inside a sandboxed page and choosing the string the operating system
 * hands to the next application are different powers, and only the second one is
 * being withheld.
 *
 * ## The read-back, which is the other half of the requirement
 *
 * FR-138 has two clauses and the second is the one that gets dropped: a copy
 * must **confirm that it happened**. A click that silently copied nothing is
 * indistinguishable from a click that worked, until the paste — by which time
 * the operator is in another window, hours later, and the thing they get is
 * whatever was on the clipboard before.
 *
 * So this writes and then reads the clipboard back, in main, and refuses to
 * report success unless what came back is what went in. That catches the empty
 * write, the truncated write, and the platform that failed silently — the last
 * of which is not hypothetical: a clipboard write can fail when another
 * application holds the OS clipboard open, and Electron's `writeText` returns
 * nothing either way.
 */

export interface CopyRequest {
  /** The recorded prompt to copy. Never the text. */
  id: string
}

export interface CopyResult {
  id: string
  /**
   * How many characters landed. The renderer shows a confirmation and this is
   * what makes it a claim about the clipboard rather than about the click.
   */
  length: number
}

export interface ClipboardOptions {
  dispatch(operation: string, payload: unknown): Promise<unknown>
  /** `clipboard.writeText`, injected so this is testable with no display. */
  writeText(text: string): void
  /** `clipboard.readText`. The confirmation, not decoration — see above. */
  readText(): string
}

export function promptCopier(options: ClipboardOptions) {
  return async function copy(request: CopyRequest): Promise<CopyResult> {
    const prompt = (await options.dispatch('prompts.get', { id: request.id })) as {
      id?: unknown
      text?: unknown
    }

    const text = prompt.text
    if (typeof text !== 'string' || text === '') {
      // Reachable only if core's own schema regressed — `prompts.record` refuses
      // an empty string. Saying so beats clearing the operator's clipboard and
      // reporting a copy, which is the shape of failure this whole file is about.
      throw new Error(`Prompt '${request.id}' has no text to copy.`)
    }

    options.writeText(text)

    /*
     * Verified against the clipboard, not against the argument.
     *
     * `writeText(text); return { length: text.length }` is the version that
     * passes every test anyone would think to write and tells the operator a
     * copy happened whether or not one did. The only honest source for "what is
     * on the clipboard" is the clipboard.
     */
    const readBack = options.readText()
    if (readBack !== text) {
      /*
       * Two messages, split on whether this is a **truncation** rather than on
       * whether the lengths differ.
       *
       * A shorter read-back is not evidence of a truncated write: the commonest
       * cause of a failed write is another application holding the clipboard, in
       * which case what comes back is the *previous* contents, at whatever
       * length those happened to be. Saying "took 25 of 62 characters" there
       * would invent a partial copy that never happened and send whoever reads
       * it looking in the wrong place. A prefix test is what actually
       * distinguishes the two.
       */
      const truncated = readBack.length < text.length && text.startsWith(readBack)
      throw new Error(
        truncated
          ? `The clipboard took ${readBack.length} of ${text.length} characters.`
          : 'The clipboard holds something other than that prompt.',
      )
    }

    return { id: request.id, length: text.length }
  }
}
