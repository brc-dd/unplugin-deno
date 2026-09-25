import type { UnpluginInstance } from 'unplugin'
import { createWebpackPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * webpack plugin: `plugins: [deno()]` in `webpack.config.js` (webpack 5.108+).
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['webpack'] = createWebpackPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
