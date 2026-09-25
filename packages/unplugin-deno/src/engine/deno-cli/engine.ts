/**
 * The `deno` engine (docs/architecture.md §4.3): resolution through the installed Deno CLI
 * (`deno info --json`). Planned for M2; this stub keeps the dispatch typed.
 *
 * @module
 */
import { DenoPluginError } from '../../diagnostics/errors.js'
import type { Engine, EngineCreateOptions, EngineFactory } from '../types.js'

/**
 * Creates a `deno` engine. Not implemented yet.
 *
 * @throws {DenoPluginError} Always `ENGINE_UNAVAILABLE`.
 */
export async function createDenoCliEngine(_options: EngineCreateOptions): Promise<Engine> {
  throw new DenoPluginError('ENGINE_UNAVAILABLE', 'The `deno` engine is not available yet.', {
    hint: "Use `engine: 'loader'` (the default); the Deno CLI engine is planned for M2.",
  })
}

/** Creates `deno` engines; see {@link createDenoCliEngine}. */
export const denoCliEngineFactory: EngineFactory = {
  kind: 'deno',
  create: (options) => createDenoCliEngine(options),
}
