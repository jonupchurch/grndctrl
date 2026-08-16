import { isEnvelopeSchema } from './envelope.js'
import { invalid, toOperationError } from './errors.js'
import { surfaceAllows, type Ctx, type Operation, type Surface } from './types.js'

export * from './envelope.js'
export * from './errors.js'
export * from './types.js'
// The adapter contract lives with the registry it describes, so an adapter can
// import `@grndctrl/core/registry` and have everything it is allowed to reach —
// which is the boundary the ESLint rule enforces from the other side.
export * from './conformance.js'

/**
 * The service layer, as one enumerable list.
 *
 * Everything the product can do is an entry here, and the IPC, HTTP, and MCP
 * adapters are three translations of this list (constitution XII). Enumerating
 * operations rather than exporting functions is what makes "is this capability
 * on every surface it should be?" a question a test can answer.
 */
export class Registry {
  readonly #ops = new Map<string, Operation<never, never>>()

  register<In, Out>(op: Operation<In, Out>): this {
    if (this.#ops.has(op.name)) {
      throw new Error(`Operation '${op.name}' is already registered.`)
    }

    // XIV as a startup failure rather than a code review. An operation that
    // says it returns provider data but does not return an envelope cannot be
    // registered at all.
    if (op.providerDerived && !isEnvelopeSchema(op.output)) {
      throw new Error(
        `Operation '${op.name}' is marked providerDerived but its output schema is not an ` +
          `envelope. Provider-derived data must carry its freshness (constitution XIV) — ` +
          `wrap the output in envelopeOf(...).`,
      )
    }

    this.#ops.set(op.name, op as unknown as Operation<never, never>)
    return this
  }

  get(name: string): Operation<never, never> | undefined {
    return this.#ops.get(name)
  }

  names(): string[] {
    return [...this.#ops.keys()].sort()
  }

  all(): Operation<never, never>[] {
    return this.names().map((n) => this.#ops.get(n) as Operation<never, never>)
  }

  /** The operations a given adapter is required to expose. */
  namesFor(surface: Surface): string[] {
    return this.all()
      .filter((op) => surfaceAllows(op.exposure, surface))
      .map((op) => op.name)
  }

  /**
   * Validate, run, validate.
   *
   * Input is revalidated here even though an adapter may already have checked
   * it — the renderer and an agent are both trust boundaries, not friends
   * (Principle II), and the handler is the last place that can refuse.
   *
   * Output is validated too, which is the unusual half. It costs a little on
   * every call and buys the guarantee that IPC and MCP cannot answer the same
   * question differently: both go through the same schema, so a handler that
   * quietly drops `freshness` fails here rather than on someone's board.
   */
  async dispatch(name: string, rawInput: unknown, ctx: Ctx): Promise<unknown> {
    const op = this.#ops.get(name)
    if (op === undefined) throw invalid(`Unknown operation '${name}'.`)

    if (!surfaceAllows(op.exposure, ctx.surface)) {
      throw invalid(`Operation '${name}' is not available on the ${ctx.surface} surface.`)
    }

    const parsedInput = op.input.safeParse(rawInput)
    if (!parsedInput.success) {
      throw invalid(`Invalid input for '${name}': ${describeIssues(parsedInput.error)}`)
    }

    let result: unknown
    try {
      result = await op.handler(parsedInput.data as never, ctx)
    } catch (e) {
      throw toOperationError(e)
    }

    const parsedOutput = op.output.safeParse(result)
    if (!parsedOutput.success) {
      throw new Error(
        `Operation '${name}' returned a value that does not match its declared output schema: ` +
          describeIssues(parsedOutput.error),
      )
    }

    return parsedOutput.data
  }
}

/**
 * Issue text without echoing the value that failed.
 *
 * The value is frequently the thing worth protecting — a token pasted into a
 * connection form, a note body — and error strings travel to logs and to
 * agents.
 */
function describeIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}
