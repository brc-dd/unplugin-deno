/**
 * unplugin-deno: Deno module resolution (`jsr:`, `npm:`, `https:`, import maps, workspaces) for
 * every bundler. Use a host entry such as `unplugin-deno/vite`; this module exposes the unplugin
 * instance, the options type and the error type.
 *
 * @module
 */
import type { UnpluginInstance } from 'unplugin'
import { createUnplugin } from 'unplugin'
import type { Options } from './core/options.js'
import { unpluginFactory } from './core/plugin.js'

export type {
  ChecksOptions,
  EnvOptions,
  Options,
  Pattern,
  Platform,
  ResolvedConfigOption,
  ResolvedOptions,
  ResolveHook,
  ResolveHookContext,
  ResolveHookResult,
} from './core/options.js'
export { DEFAULT_ALLOW_IMPORT } from './core/options.js'
export { PLUGIN_NAME, unpluginFactory } from './core/plugin.js'
export type { DenoPluginErrorOptions, ErrorCode } from './diagnostics/errors.js'
export { DenoPluginError, ERROR_CODES, isDenoPluginError } from './diagnostics/errors.js'

/** The unplugin instance: `unplugin.vite(options)`, `unplugin.esbuild(options)`, and so on. */
export const unplugin: UnpluginInstance<Options | undefined, false> =
  createUnplugin(unpluginFactory)
