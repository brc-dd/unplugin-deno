import type { UnpluginInstance } from 'unplugin'
import { createBunPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Bun plugin: `plugins: [deno()]` in `Bun.build()`.
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['bun'] = createBunPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
