import type { UnpluginInstance } from 'unplugin'
import { createFarmPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Farm (best effort) plugin: `plugins: [deno()]` in `farm.config.ts`.
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['farm'] = createFarmPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
