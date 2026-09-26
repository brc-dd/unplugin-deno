/**
 * The Rsbuild adapter (docs/architecture.md §6.6). Rsbuild does not call unplugin's
 * `rspack(compiler)` hook, so the plugin provides `rsbuild.setup(api)` and configures Rspack
 * through `api.modifyRspackConfig`.
 *
 * @module
 */
import type { RsbuildPlugin } from 'unplugin'
import type { PluginState } from '../../core/state.js'
import { DenoPluginError } from '../../diagnostics/errors.js'

/** Builds the `rsbuild` part of the plugin (`Partial<RsbuildPlugin>`). */
export function rsbuildHooks(_state: PluginState): Partial<RsbuildPlugin> {
  return {
    setup() {
      throw new DenoPluginError(
        'ENGINE_UNAVAILABLE',
        'The Rsbuild adapter of unplugin-deno is not implemented yet.',
        { hint: 'Use unplugin-deno with Vite, Rolldown, Rollup or esbuild meanwhile.' },
      )
    },
  }
}
