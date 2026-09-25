/**
 * Engine selection: one factory per {@link EngineKind}.
 *
 * @module
 */
import { denoCliEngineFactory } from './deno-cli/engine.js'
import { loaderEngineFactory } from './loader/engine.js'
import type { Engine, EngineCreateOptions, EngineFactory, EngineKind } from './types.js'

/** The factory of every engine kind. */
export const ENGINE_FACTORIES: Readonly<Record<EngineKind, EngineFactory>> = Object.freeze({
  loader: loaderEngineFactory,
  deno: denoCliEngineFactory,
})

/**
 * Creates an engine of the given kind.
 *
 * @throws {DenoPluginError} `ENGINE_UNAVAILABLE` for the `deno` engine (M2) or when the vendored
 *   loader cannot be loaded; `CONFIG_INVALID` when the loader rejects the project configuration.
 */
export function createEngine(kind: EngineKind, options: EngineCreateOptions): Promise<Engine> {
  return ENGINE_FACTORIES[kind].create(options)
}
