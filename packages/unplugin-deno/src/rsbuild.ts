import type { UnpluginInstance } from 'unplugin'
import { createRsbuildPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Rsbuild plugin: `plugins: [deno()]` in `rsbuild.config.ts`.
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['rsbuild'] = createRsbuildPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
