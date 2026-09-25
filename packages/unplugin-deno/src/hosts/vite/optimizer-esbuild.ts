/**
 * The optimizer plugin for Vite 7, whose dependency optimizer bundles with esbuild
 * (`optimizeDeps.esbuildOptions.plugins`): the same job as the Rolldown plugin of
 * `optimizer.ts` (resolve what prebundled package files import, register the `https:` and
 * `data:` imports of app files during the scan), expressed with esbuild's plugin API. It is
 * independent of the esbuild host adapter: it only maps core outcomes to esbuild results.
 *
 * @module
 */
import { dirname } from 'node:path'
import type { OnResolveArgs, OnResolveResult, Plugin as EsbuildPlugin, PluginBuild } from 'esbuild'
import { isOwnedSpecifier, withDenoType } from '../../core/id.js'
import type { ResolveOutcome, ResolveTarget } from '../../core/resolve.js'
import { parseSpecifier } from '../../core/specifier.js'
import type { PluginState } from '../../core/state.js'
import type { PackageInstaller } from './install.js'
import type { DepsOptimizer } from './optimizer.js'
import { isPackageFile, registerScannedUrl } from './optimizer.js'

/** The namespace of the modules the plugin synthesises (markers, the empty module). */
const NAMESPACE = 'unplugin-deno'

/** Marks the plugin's own `build.resolve` calls, so they are not handled again. */
const REDIRECT = Symbol.for('unplugin-deno:vite-optimizer-redirect')

function isOwnRedirect(args: OnResolveArgs): boolean {
  const data: unknown = args.pluginData
  return typeof data === 'object' && data !== null && REDIRECT in data
}

/**
 * The esbuild plugin Vite 7's optimizer runs for an environment (see the module documentation);
 * `generation` in the name ties Vite's optimizer cache to the project's configs and lockfile.
 */
export function esbuildOptimizerPlugin(
  state: PluginState,
  target: ResolveTarget,
  generation: string,
  install: PackageInstaller,
  optimizer: () => DepsOptimizer | undefined,
): EsbuildPlugin {
  const filter = state.resolveIdFilter(true)
  return {
    name: `unplugin-deno:optimizer:${generation}`,
    setup(build) {
      // A JavaScript check: the owned-specifier pattern is not a Go regular expression.
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.namespace === NAMESPACE || isOwnRedirect(args)) return undefined
        if (!isOwnedSpecifier(args.path, filter)) return undefined
        if (args.importer === '' || !isPackageFile(state, args.importer)) {
          const url = await registerScannedUrl(state, target, optimizer(), args.path, args.importer)
          return url ? { path: args.path, external: true } : undefined
        }
        await install(args.path, args.importer, target)
        const outcome = await state.resolve(args.path, args.importer, { kind: args.kind, target })
        return esbuildResult(build, args, outcome)
      })
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
        const loaded = await state.load(args.path)
        return loaded === null ? undefined : { contents: loaded.code, loader: 'js' }
      })
    },
  }
}

/** An esbuild result for a core outcome; npm redirects and host markers resolve through esbuild. */
async function esbuildResult(
  build: PluginBuild,
  args: OnResolveArgs,
  outcome: ResolveOutcome,
): Promise<OnResolveResult | undefined> {
  if (outcome === null) return undefined
  switch (outcome.type) {
    case 'path':
    case 'mirror': {
      const { base, query } = parseSpecifier(outcome.path)
      const result: OnResolveResult = { path: base }
      if (query !== '') result.suffix = query
      if (outcome.type === 'path' && outcome.sideEffects === false) result.sideEffects = false
      return result
    }
    case 'marker':
    case 'virtual':
      return { path: outcome.type === 'marker' ? outcome.path : outcome.id, namespace: NAMESPACE }
    case 'external':
      return { path: outcome.id, external: true }
    case 'npm-redirect': {
      const resolved = await build.resolve(outcome.request, {
        kind: args.kind,
        importer: outcome.packageJsonPath,
        resolveDir: outcome.resolveDir,
        pluginData: { [REDIRECT]: true },
      })
      if (resolved.errors.length > 0) return { path: outcome.fallbackPath }
      return {
        path: resolved.path,
        external: resolved.external,
        namespace: resolved.namespace,
        suffix: `${resolved.suffix}${outcome.query}`,
        sideEffects: resolved.sideEffects,
      }
    }
    case 'host-marker': {
      const resolved = await build.resolve(outcome.request, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: dirname(args.importer),
        pluginData: { [REDIRECT]: true },
      })
      if (resolved.errors.length > 0 || resolved.external) return undefined
      return { path: withDenoType(resolved.path, outcome.denoType), namespace: NAMESPACE }
    }
  }
}
