import type { UnpluginInstance } from 'unplugin'
import { createVitePlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Vite plugin: `plugins: [deno()]` in `vite.config.ts` (Vite 7 and 8).
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['vite'] = createVitePlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
