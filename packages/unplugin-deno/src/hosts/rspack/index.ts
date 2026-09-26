/**
 * The Rspack adapter (docs/architecture.md §6.6), through unplugin's `rspack(compiler)` escape
 * hatch: unplugin's generic hooks cannot express externals (`external: true` becomes an empty
 * virtual module) and give virtual modules a wrong importer, so the plugin taps Rspack's own
 * hooks (`plugin.ts`, shared with the Rsbuild adapter). The compiler is the whole build: the
 * platform hint is `compiler.platform` (Rspack has no Deno target: Node.js targets give the
 * Deno platform for projects with a `deno.json`), the root `compiler.context`.
 *
 * @module
 */
import type { RspackCompiler } from 'unplugin'
import type { PluginState } from '../../core/state.js'
import { applyRspack } from './plugin.js'

/** Builds the `rspack(compiler)` hook of the plugin. */
export function rspackApply(state: PluginState): (compiler: RspackCompiler) => void {
  return (compiler) => applyRspack(state, compiler, { standalone: true })
}
