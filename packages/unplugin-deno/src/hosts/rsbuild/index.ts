/**
 * The Rsbuild adapter (docs/architecture.md §6.6). Rsbuild does not call unplugin's
 * `rspack(compiler)` hook, so the plugin provides `rsbuild.setup(api)`: `api.modifyRspackConfig`
 * adds the Rspack plugin of `../rspack/plugin.ts` to the Rspack config of every Rsbuild
 * environment, with that environment's resolve target (§5.6): `web` and `web-worker` environments
 * build for the browser (unless a `platform` record names them), `node` environments take the
 * `platform` record entry, a `platform` string, or `deno` when the project has a `deno.json`
 * (else `node`), as Vite's server environments do. The environments share one plugin state
 * (project, engines per target, mirror), prepared once with Rsbuild's root and closed with the
 * build or the dev server.
 *
 * @module
 */
import type { RsbuildPlugin, RspackCompiler } from 'unplugin'
import type { Platform } from '../../core/options.js'
import { derivePlatform } from '../../core/platform.js'
import type { ResolveTarget } from '../../core/resolve.js'
import type { PluginState } from '../../core/state.js'
import { applyRspack } from '../rspack/plugin.js'
import { ConfigReloader, TAP_NAME } from '../webpack/requests.js'

/** Rsbuild's `output.target` of an environment. */
export type RsbuildTarget = 'web' | 'node' | 'web-worker'

/**
 * The platform of an Rsbuild environment (§5.6): browser for `web` and `web-worker`
 * environments unless the `platform` option is a record naming them (a `platform` string never
 * applies to them, their code runs in the browser); for `node` environments the record entry, a
 * `platform` string, or `deno` with a `deno.json`, else `node`. The project must be loaded.
 */
export function environmentPlatform(
  state: PluginState,
  name: string,
  target: RsbuildTarget,
): Platform {
  const { platform } = state.options
  if (target !== 'node') {
    return typeof platform === 'object' ? (platform[name] ?? 'browser') : 'browser'
  }
  return derivePlatform(state.options, { platformHint: 'node' }, state.project, name)
}

/** The resolve target of an Rsbuild environment (Rspack applies its own conditions). */
export function environmentTarget(
  state: PluginState,
  name: string,
  target: RsbuildTarget,
): ResolveTarget {
  return { platform: environmentPlatform(state, name, target), conditions: [] }
}

/** Builds the `rsbuild` part of the plugin (`Partial<RsbuildPlugin>`). */
export function rsbuildHooks(state: PluginState): Partial<RsbuildPlugin> {
  return {
    setup(api) {
      const reloader = new ConfigReloader(state)
      // The state's own platform is the default environment's (`web`); environments resolve
      // with their targets.
      state.setHints({
        root: api.context.rootPath,
        platform: 'browser',
        version: api.context.version,
        command: api.context.action === 'dev' ? 'serve' : 'build',
      })
      api.modifyRspackConfig(async (_config, utils) => {
        await state.prepare()
        const target = environmentTarget(state, utils.environment.name, utils.target)
        state.logger.debug(
          `[rsbuild] environment ${utils.environment.name} (${utils.target}) builds for ${target.platform}`,
        )
        utils.appendPlugins({
          name: TAP_NAME,
          apply: (compiler: RspackCompiler) =>
            applyRspack(state, compiler, { target, standalone: false, reloader }),
        })
      })
      api.onAfterBuild(async () => {
        await state.flush()
      })
      api.onAfterDevCompile(async () => {
        await state.flush()
      })
      api.onCloseBuild(async () => {
        await state.close()
      })
      api.onCloseDevServer(async () => {
        await state.close()
      })
    },
  }
}
