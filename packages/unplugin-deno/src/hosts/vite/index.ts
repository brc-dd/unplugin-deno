/**
 * Vite-specific hooks, placed under unplugin's `vite` escape hatch (docs/architecture.md §6.1).
 * The generic Rollup-family hooks already give Vite builds resolution and loading; this module adds
 * the dev-server and configuration behaviour that only Vite has.
 *
 * @module
 */
import type { Plugin as VitePlugin } from 'vite'
import type { PluginState } from '../../core/state.js'

/** The Vite-specific hooks of the plugin (merged over the generic ones by unplugin). */
export function viteHooks(_state: PluginState): Partial<VitePlugin> {
  return {}
}
