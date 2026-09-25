import type { UnpluginInstance } from 'unplugin'
import { createRspackPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Rspack plugin: `plugins: [deno()]` in `rspack.config.ts`.
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['rspack'] = createRspackPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
