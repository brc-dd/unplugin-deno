/**
 * The Rspack adapter (docs/architecture.md §6.6), through unplugin's `rspack(compiler)` escape
 * hatch: Rspack's `resolveForScheme` hook and a scheme-matched loader stand in for the generic
 * hooks, which cannot express externals or non-file ids there.
 *
 * @module
 */
import type { RspackCompiler } from 'unplugin'
import type { PluginState } from '../../core/state.js'
import { DenoPluginError } from '../../diagnostics/errors.js'

/** Builds the `rspack(compiler)` hook of the plugin. */
export function rspackApply(_state: PluginState): (compiler: RspackCompiler) => void {
  return () => {
    throw new DenoPluginError(
      'ENGINE_UNAVAILABLE',
      'The Rspack adapter of unplugin-deno is not implemented yet.',
      { hint: 'Use unplugin-deno with Vite, Rolldown, Rollup or esbuild meanwhile.' },
    )
  }
}
