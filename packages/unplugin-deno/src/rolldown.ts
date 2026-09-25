import type { UnpluginInstance } from 'unplugin'
import { createRolldownPlugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

/**
 * Rolldown (and tsdown) plugin: `plugins: [deno()]` in `rolldown.config.ts`.
 *
 * @param options See {@link Options}.
 */
const deno: UnpluginInstance<Options | undefined>['rolldown'] =
  createRolldownPlugin(unpluginFactory)

export default deno
export type { Options } from './core/options.js'
