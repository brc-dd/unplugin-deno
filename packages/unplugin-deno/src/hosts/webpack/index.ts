/**
 * The webpack adapter (docs/architecture.md §6.5). unplugin's generic `resolveId` never sees
 * scheme-prefixed requests on webpack (`jsr:`, `npm:`, `https:` take the `resolveForScheme` path),
 * so the plugin taps webpack's own hooks through unplugin's `webpack(compiler)` escape hatch.
 *
 * @module
 */
import type { WebpackCompiler } from 'unplugin'
import type { PluginState } from '../../core/state.js'
import { DenoPluginError } from '../../diagnostics/errors.js'

/** Builds the `webpack(compiler)` hook of the plugin. */
export function webpackApply(_state: PluginState): (compiler: WebpackCompiler) => void {
  return () => {
    throw new DenoPluginError(
      'ENGINE_UNAVAILABLE',
      'The webpack adapter of unplugin-deno is not implemented yet.',
      { hint: 'Use unplugin-deno with Vite, Rolldown, Rollup or esbuild meanwhile.' },
    )
  }
}
