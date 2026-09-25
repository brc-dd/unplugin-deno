/**
 * The esbuild adapter (docs/architecture.md §6.4). unplugin's generic esbuild adapter registers a
 * catch-all `onResolve` before the `esbuild.setup` escape hatch runs and forces every result into
 * the plugin namespace, so for esbuild the factory returns only `{ name, esbuild: { setup } }` and
 * this module implements the whole plugin against esbuild's own API.
 *
 * @module
 */
import type { PluginBuild } from 'esbuild'
import type { PluginState } from '../../core/state.js'
import { DenoPluginError } from '../../diagnostics/errors.js'

/** Builds the `setup` function of the esbuild plugin. */
export function esbuildSetup(_state: PluginState): (build: PluginBuild) => void {
  return () => {
    throw new DenoPluginError(
      'ENGINE_UNAVAILABLE',
      'The esbuild adapter of unplugin-deno lands in the next phase.',
      { hint: 'Use unplugin-deno with Rolldown, Rollup or Vite meanwhile.' },
    )
  }
}
