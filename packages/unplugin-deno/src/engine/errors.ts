/**
 * Engine-level error types shared by every engine implementation.
 *
 * @module
 */
import type { DenoPluginErrorOptions, ErrorCode } from '../diagnostics/errors.js'
import { DenoPluginError } from '../diagnostics/errors.js'

/** Options of {@link EngineResolveError}. */
export interface EngineResolveErrorOptions extends DenoPluginErrorOptions {
  /** See {@link EngineResolveError.isOptionalDependency}. */
  isOptionalDependency?: boolean | undefined
}

/**
 * A {@link DenoPluginError} for a failed resolution that also says whether the missing module is
 * an optional dependency of the importing npm package (`optionalDependencies`, or an optional peer
 * in `peerDependenciesMeta`), so callers can treat it as absent instead of failing.
 */
export class EngineResolveError extends DenoPluginError {
  /** The specifier names an optional dependency of the importing package that is not installed. */
  readonly isOptionalDependency: boolean

  /**
   * @param code Stable error code.
   * @param message One sentence describing what went wrong.
   * @param options Hint, specifier, importer, cause and `isOptionalDependency`.
   */
  constructor(code: ErrorCode, message: string, options: EngineResolveErrorOptions = {}) {
    const { isOptionalDependency, ...rest } = options
    super(code, message, rest)
    this.isOptionalDependency = isOptionalDependency === true
  }
}

/** Whether `error` reports a missing optional dependency (see {@link EngineResolveError}). */
export function isOptionalDependencyError(error: unknown): boolean {
  return error instanceof EngineResolveError && error.isOptionalDependency
}
