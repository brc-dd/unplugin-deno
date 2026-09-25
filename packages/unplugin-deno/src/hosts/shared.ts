/**
 * What host adapters share (docs/architecture.md §5.1, §6): the {@link HostContext} the core reads
 * host facts from, a {@link Logger} backed by the host's plugin context, and the conversion of a
 * core {@link ResolveOutcome} into a Rollup-family `resolveId` result.
 *
 * @module
 */
import type { UnpluginContextMeta } from 'unplugin'
import type { ResolveOutcome } from '../core/resolve.js'
import { withDenoType } from '../core/id.js'
import type { PlatformHint } from '../core/platform.js'
import type { Logger } from '../diagnostics/logger.js'
import { createConsoleLogger } from '../diagnostics/logger.js'

/** Host facts the core needs; the core never imports a host package. */
export interface HostContext {
  /** unplugin's `meta.framework`. */
  framework: UnpluginContextMeta['framework']
  /** Absolute host root (Vite `root`, Rolldown `cwd`, esbuild `absWorkingDir`, `process.cwd()`). */
  root: string
  command: 'build' | 'serve'
  /** The host's target platform (Rolldown/esbuild `platform`), see `derivePlatform`. */
  platformHint?: PlatformHint | undefined
  /** Export conditions the host resolves with (Rolldown `resolve.conditionNames`, …). */
  conditionsHint?: string[] | undefined
  logger: Logger
  /** Host version, when known. */
  version?: string | undefined
}

/**
 * The logging methods of a host plugin context (Rollup, Rolldown and Vite have them all; unplugin's
 * generic context only `warn`). `error` is not used: Rollup's `this.error` throws.
 */
export interface HostLogTarget {
  warn?: ((message: string) => void) | undefined
  info?: ((message: string) => void) | undefined
}

/**
 * A {@link Logger} that reports through the current host context (`target()`, updated by the
 * adapter at each hook): warnings and errors via `this.warn`, info and (when enabled) debug lines
 * via `this.info`, so they appear in the host's own output and `onLog`. Without a context the
 * messages go to stderr. Errors are logged, never thrown: hooks throw `DenoPluginError`s instead.
 */
export function createHostLogger(
  target: () => HostLogTarget | undefined,
  options: { debug: boolean },
): Logger {
  const fallback = createConsoleLogger({ debug: options.debug })
  const warn = (message: string): void => {
    const context = target()
    if (typeof context?.warn === 'function') context.warn(message)
    else fallback.warn(message)
  }
  const info = (message: string): void => {
    const context = target()
    if (typeof context?.info === 'function') context.info(message)
    else fallback.info(message)
  }
  return {
    debugEnabled: options.debug,
    error: (message) => warn(`error: ${message}`),
    warn,
    info,
    debug: (message) => {
      if (options.debug) info(message)
    },
    downloading: (url) => {
      if (options.debug) info(`[engine] Downloading ${url}`)
    },
  }
}

/** The part of a Rollup-family `this.resolve` result the adapters read. */
export interface HostResolvedId {
  id: string
  external?: boolean | 'absolute' | 'relative' | undefined
  moduleSideEffects?: boolean | 'no-treeshake' | null | undefined
}

/** A Rollup-family `resolveId` result. */
export interface RollupFamilyResolveResult {
  id: string
  external?: boolean | 'absolute' | 'relative'
  moduleSideEffects?: boolean | 'no-treeshake'
}

/** Resolves through the host (Rollup/Rolldown/Vite `this.resolve`, with `skipSelf: true`). */
export type HostResolve = (
  source: string,
  importer: string | undefined,
) => Promise<HostResolvedId | null>

/**
 * Converts a core outcome into a Rollup-family `resolveId` result (§5.4, §5.5):
 *
 * - `path`/`mirror`/`marker`/`virtual` → their id (`moduleSideEffects: false` for npm packages
 *   declaring `"sideEffects": false`);
 * - `npm-redirect` → the host's resolution of `request` from the package's `package.json` (so the
 *   host applies `exports` conditions, `browser` and `sideEffects`), `fallbackPath` when the host
 *   cannot resolve it (Rollup without a node-resolve plugin);
 * - `host-marker` → the host's resolution of `request` from `importer`, with the marker added;
 * - `external` → `{ id, external: true }`.
 */
export async function toRollupResult(
  outcome: ResolveOutcome,
  importer: string | undefined,
  resolve: HostResolve | undefined,
): Promise<RollupFamilyResolveResult | null> {
  if (outcome === null) return null
  switch (outcome.type) {
    case 'path':
      return outcome.sideEffects === false
        ? { id: outcome.path, moduleSideEffects: false }
        : { id: outcome.path }
    case 'mirror':
    case 'marker':
      return { id: outcome.path }
    case 'virtual':
      return { id: outcome.id }
    case 'external':
      return { id: outcome.id, external: true }
    case 'npm-redirect': {
      const resolved = await resolve?.(outcome.request, outcome.packageJsonPath)
      if (resolved === null || resolved === undefined) {
        return outcome.sideEffects === false
          ? { id: `${outcome.fallbackPath}${outcome.query}`, moduleSideEffects: false }
          : { id: `${outcome.fallbackPath}${outcome.query}` }
      }
      return fromHost(resolved, outcome.query)
    }
    case 'host-marker': {
      const resolved = await resolve?.(outcome.request, importer)
      if (resolved === null || resolved === undefined || resolved.external) return null
      return { id: withDenoType(resolved.id, outcome.denoType) }
    }
  }
}

function fromHost(resolved: HostResolvedId, query: string): RollupFamilyResolveResult {
  const result: RollupFamilyResolveResult = {
    id: resolved.external ? resolved.id : `${resolved.id}${query}`,
  }
  if (resolved.external !== undefined && resolved.external !== false)
    result.external = resolved.external
  if (resolved.moduleSideEffects !== undefined && resolved.moduleSideEffects !== null) {
    result.moduleSideEffects = resolved.moduleSideEffects
  }
  return result
}
