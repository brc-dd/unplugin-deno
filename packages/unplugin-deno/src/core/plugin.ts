import type { UnpluginFactory } from 'unplugin'
import type { Options } from './options.js'

/** The plugin name reported to every host. */
export const PLUGIN_NAME = 'unplugin-deno'

/**
 * The factory behind every host entry. This is the M0 skeleton: it returns an inert plugin; the
 * resolver, the loader and the host adapters arrive in M1 (docs/architecture.md §5, §6).
 */
export const unpluginFactory: UnpluginFactory<Options | undefined, false> = (_options, meta) => {
  if (meta.framework === 'esbuild') {
    // unplugin's generic esbuild adapter registers a catch-all onResolve before `esbuild.setup`
    // runs, so the esbuild plugin is implemented only through `esbuild.setup` (§6.4).
    return { name: PLUGIN_NAME, esbuild: { setup() {} } }
  }
  return { name: PLUGIN_NAME }
}
