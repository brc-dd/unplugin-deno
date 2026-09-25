/**
 * `unplugin-deno/api`: programmatic access to Deno resolution for other tools (Tailwind, PostCSS,
 * Sass, tsc bridges). Planned for a later release (docs/plan.md, E2).
 *
 * @module
 */
import type { Options } from './core/options.js'
import { DenoPluginError } from './diagnostics/errors.js'

export type { Options } from './core/options.js'

/**
 * Creates a resolver that applies Deno's resolution rules outside a bundler.
 * Not implemented in this version.
 *
 * @param _options Plugin options.
 * @throws {DenoPluginError} Always, with code `ENGINE_UNAVAILABLE`.
 */
export function createDenoResolver(_options?: Options): never {
  throw new DenoPluginError(
    'ENGINE_UNAVAILABLE',
    '`createDenoResolver` from `unplugin-deno/api` is not implemented in this version.',
    { hint: 'It is planned for a later release (docs/plan.md, E2).' },
  )
}
