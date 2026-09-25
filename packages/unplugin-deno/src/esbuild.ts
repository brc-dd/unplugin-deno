import type { UnpluginInstance } from 'unplugin'
import { createEsbuildPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * esbuild plugin: `plugins: [deno()]` in `esbuild.build()`.
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['esbuild'] = createEsbuildPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
