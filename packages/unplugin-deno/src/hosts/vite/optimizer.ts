/**
 * Vite's dependency optimizer (docs/architecture.md §5.4, §6.1; research/feasibility.md §3).
 * Prebundled dependencies are keyed on the specifier as written (`npm:kleur@^4`,
 * `jsr:@std/path@^1`, `@std/path`, `https://…`), the key Vite's dependency scanner records, so
 * the imports the scanner found and those met later agree and the optimizer runs once:
 *
 * - {@link optimizedDependency} returns the prebundled id (`/node_modules/.vite/deps/…`) of an npm
 *   package or mirror file in the dev server, registering it when it is missing;
 * - {@link optimizerPlugin} (in `optimizeDeps.rolldownOptions.plugins`, Vite 8) resolves what
 *   prebundled modules import (pinned `npm:` specifiers in mirror files, markers, bare imports in
 *   packages from Deno's global npm cache). Vite also runs it in the dependency scan, where it
 *   registers the `https:` and `data:` imports the scanner cannot see.
 *
 * @module
 */
import type { DevEnvironment, Rolldown } from 'vite'
import { isGlobalCachePath, isNodeModulesPath } from '../../core/npm.js'
import type { ResolveOutcome, ResolveTarget } from '../../core/resolve.js'
import type { SpecifierKind } from '../../core/specifier.js'
import { parseSpecifier } from '../../core/specifier.js'
import type { PluginState } from '../../core/state.js'
import type { HostResolve, RollupFamilyResolveResult } from '../shared.js'
import { toRollupResult } from '../shared.js'

/** A dev environment's optimizer (`DevEnvironment.depsOptimizer`). */
export type DepsOptimizer = NonNullable<DevEnvironment['depsOptimizer']>

/** Entries Vite's optimizer bundles (`OPTIMIZABLE_ENTRY_RE` in Vite 7 and 8). */
const OPTIMIZABLE_ENTRY = /\.[cm]?[jt]s$/

/** Bare imports as Vite's dependency scanner sees them (`vite:dep-scan:resolve`). */
const SCANNER_BARE_IMPORT = /^[\w@][^:]/

/** Remote and `data:` URLs: the scanner never asks the dev server's plugins about them. */
const URL_KINDS: ReadonlySet<SpecifierKind> = new Set<SpecifierKind>(['https', 'http', 'data'])

/**
 * The optimizer key of an import, or `null` when it is not prebundled: `jsr:`, `npm:` and bare
 * specifiers without a query as the scanner records them, and `https:`/`data:` URLs.
 */
export function optimizerKey(source: string): string | null {
  const { kind, query } = parseSpecifier(source)
  if (URL_KINDS.has(kind)) return source
  if (query !== '' || (kind !== 'jsr' && kind !== 'npm' && kind !== 'bare')) return null
  return SCANNER_BARE_IMPORT.test(source) ? source : null
}

/** Whether Vite's optimizer can bundle `file` as an entry. */
export function isOptimizable(
  file: string,
  options: { extensions?: string[] | undefined },
): boolean {
  return (
    OPTIMIZABLE_ENTRY.test(file) ||
    (options.extensions?.some((extension) => file.endsWith(extension)) ?? false)
  )
}

/** Whether `key` is excluded from optimization (`optimizeDeps.exclude`, subpaths included). */
export function isExcluded(key: string, exclude: readonly string[] | undefined): boolean {
  if (exclude === undefined) return false
  return exclude.some(
    (entry) => key === entry || key.startsWith(entry.endsWith('/') ? entry : `${entry}/`),
  )
}

/**
 * What a resolution is for the optimizer: an npm package file under `node_modules` (a redirect or
 * a path), a file of Deno's global npm cache, or a mirror file. Anything else (local files,
 * workspace members, externals, markers) is never prebundled.
 */
export type PackageKind = 'node_modules' | 'global-cache' | 'mirror'

/** The {@link PackageKind} of `outcome`, or `null`. */
export function packageKind(state: PluginState, outcome: ResolveOutcome): PackageKind | null {
  if (outcome === null) return null
  switch (outcome.type) {
    case 'npm-redirect':
      return 'node_modules'
    case 'mirror':
      return 'mirror'
    case 'path': {
      const path = stripQuery(outcome.path)
      if (isGlobalCachePath(path, state.denoDirs, state.flavor)) return 'global-cache'
      return isNodeModulesPath(path, state.flavor) ? 'node_modules' : null
    }
    default:
      return null
  }
}

/**
 * Whether `id` is a package file: in `node_modules`, in Deno's global npm cache or in the mirror.
 * The optimizer bundles those; the dependency scanner reads the app's files and never enters them.
 */
export function isPackageFile(state: PluginState, id: string): boolean {
  const { base, kind } = parseSpecifier(id)
  if (kind !== 'absolute') return false
  return (
    isNodeModulesPath(base, state.flavor) ||
    isGlobalCachePath(base, state.denoDirs, state.flavor) ||
    state.mirror.isMirrorPath(base)
  )
}

/** The file an outcome of a {@link PackageKind} stands for (the host resolves npm redirects). */
async function packageFile(outcome: ResolveOutcome, resolve: HostResolve): Promise<string | null> {
  if (outcome === null) return null
  switch (outcome.type) {
    case 'npm-redirect': {
      const resolved = await resolve(outcome.request, outcome.packageJsonPath)
      if (resolved === null) return outcome.fallbackPath
      return resolved.external ? null : stripQuery(resolved.id)
    }
    case 'mirror':
    case 'path':
      return stripQuery(outcome.path)
    default:
      return null
  }
}

/** A module id without its query (Vite's dev resolver adds `?v=<hash>` to package files). */
function stripQuery(id: string): string {
  return parseSpecifier(id).base
}

/** A prebundled dependency's metadata. */
type OptimizedDepInfo = ReturnType<DepsOptimizer['registerMissingImport']>

/**
 * Registers `key` for `file` unless it is excluded, not bundleable, or discovery is off;
 * returns its metadata.
 */
function register(
  optimizer: DepsOptimizer,
  key: string,
  file: string | null,
): OptimizedDepInfo | undefined {
  const { options } = optimizer
  if (file === null || options.noDiscovery === true || isExcluded(key, options.exclude)) {
    return undefined
  }
  return isOptimizable(file, options) ? optimizer.registerMissingImport(key, file) : undefined
}

/**
 * The prebundled dependency for the import `source` in a dev environment, or `null` when the
 * import is not prebundled (the caller then resolves it as in a build):
 *
 * - during the dependency `scan`, the scanner records package files under `node_modules` itself
 *   (keyed on `source`); files of Deno's global npm cache are registered here, and the scanner
 *   gets an id that keeps it from crawling them as app files, so the first optimizer run already
 *   includes them;
 * - afterwards, the optimized or discovered entry of the key, registered when missing.
 *
 * Nothing is registered for keys in `optimizeDeps.exclude`, for files the optimizer cannot bundle,
 * or when discovery is off (`noDiscovery`). The optimizer resolves what these files import with
 * {@link optimizerPlugin} (or its esbuild twin on Vite 7).
 */
export async function optimizedDependency(
  optimizer: DepsOptimizer,
  source: string,
  kind: PackageKind,
  outcome: ResolveOutcome,
  resolve: HostResolve,
  scan: boolean,
): Promise<RollupFamilyResolveResult | null> {
  const key = optimizerKey(source)
  if (key === null || isExcluded(key, optimizer.options.exclude)) return null
  if (scan) {
    if (kind !== 'global-cache') return null
    const registered = register(optimizer, key, await packageFile(outcome, resolve))
    return registered === undefined ? null : { id: key, external: true }
  }
  const { metadata } = optimizer
  const info =
    metadata.optimized[key] ??
    metadata.discovered[key] ??
    register(optimizer, key, await packageFile(outcome, resolve))
  return info === undefined ? null : { id: optimizer.getOptimizedDepId(info) }
}

/**
 * The Rolldown plugin Vite's optimizer runs for an environment (`optimizeDeps.rolldownOptions.
 * plugins`, Vite 8): it resolves imports of package files (prebundled modules) for the
 * environment's `target` and loads mirror files and markers. `generation` (the project's mirror
 * generation) is part of the name, which Vite hashes into the optimizer cache key, so prebundled
 * dependencies are rebuilt when `deno.json` or `deno.lock` changed between two server starts.
 *
 * Vite runs these plugins in its dependency scan too, before the scanner's own. Imports of the
 * app's files are the scanner's there (it asks the dev server's plugins, which record packages),
 * except `https:` and `data:` URLs, which it never asks about: the plugin registers their mirror
 * files with `optimizer()` (the environment's optimizer) so the first optimizer run has them.
 */
export function optimizerPlugin(
  state: PluginState,
  target: ResolveTarget,
  generation: string,
  optimizer: () => DepsOptimizer | undefined,
): Rolldown.Plugin {
  return {
    name: `unplugin-deno:optimizer:${generation}`,
    resolveId: {
      filter: { id: state.resolveIdFilter(true) },
      async handler(source, importer, extra) {
        if (importer === undefined || !isPackageFile(state, importer)) {
          const url = await registerScannedUrl(state, target, optimizer(), source, importer)
          return url ? { id: source, external: true } : null
        }
        const outcome = await state.resolve(source, importer, {
          kind: extra.kind,
          isEntry: extra.isEntry,
          target,
        })
        return toRollupResult(outcome, importer, (request, from) =>
          this.resolve(request, from, { skipSelf: true, kind: extra.kind }),
        )
      },
    },
    load: {
      filter: { id: state.loadFilter() },
      async handler(id) {
        const loaded = await state.load(id)
        if (loaded === null) return null
        return { code: loaded.code, map: loaded.map ?? null, moduleType: 'js' }
      },
    },
  }
}

/**
 * During the dependency scan: registers the mirror file of an `https:` or `data:` import of an
 * app file with `optimizer`. Returns whether `source` is such a URL, which the scanner keeps
 * external; a URL that cannot be mirrored is left for the dev server to report when requested.
 */
export async function registerScannedUrl(
  state: PluginState,
  target: ResolveTarget,
  optimizer: DepsOptimizer | undefined,
  source: string,
  importer: string | undefined,
): Promise<boolean> {
  if (optimizer === undefined || !URL_KINDS.has(parseSpecifier(source).kind)) return false
  try {
    const outcome = await state.resolve(source, importer, { scan: true, target })
    if (outcome?.type === 'mirror') register(optimizer, source, stripQuery(outcome.path))
  } catch (error) {
    state.logger.debug(`[vite] cannot prebundle ${source}: ${String(error)}`)
  }
  return true
}
