import type { UnpluginInstance } from 'unplugin'
import { createRollupPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Rollup plugin: `plugins: [deno()]` in `rollup.config.js` (Rollup 4.40+).
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['rollup'] = createRollupPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
