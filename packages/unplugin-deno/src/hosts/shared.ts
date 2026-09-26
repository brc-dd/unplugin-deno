/**
 * What host adapters share (docs/architecture.md §5.1, §6): the {@link HostContext} the core reads
 * host facts from, a {@link Logger} backed by the host's plugin context, and the conversion of a
 * core {@link ResolveOutcome} into a Rollup-family `resolveId` result.
 *
 * @module
 */
import type { UnpluginContextMeta } from 'unplugin'
import type { AstLang, AstParser } from '../core/attributes.js'
import type { JsxTransform } from '../core/jsx.js'
import type { ResolveOutcome } from '../core/resolve.js'
import type { TransformContext } from '../core/state.js'
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

/** The members of a Rollup-family `transform` context the plugin reads (untyped by unplugin). */
export interface TransformHostContext {
  parse?: ((code: string, options: { lang: AstLang }) => unknown) | undefined
  getModuleInfo?: ((id: string) => { isEntry?: boolean } | null) | undefined
}

/**
 * The host facts of a Rollup-family `transform` call (docs/architecture.md §5.10): the host's
 * parser (Rolldown and Vite 8 parse TypeScript and JSX with oxc; Rollup and Vite 7 only
 * JavaScript) and whether the module is an entry of the build (`this.getModuleInfo(id).isEntry`).
 */
export function transformContext(context: TransformHostContext, id: string): TransformContext {
  const { parse, getModuleInfo } = context
  const parser: AstParser | undefined =
    typeof parse === 'function' ? (text, lang) => parse.call(context, text, { lang }) : undefined
  return {
    parse: parser,
    isEntry: () => {
      try {
        return getModuleInfo?.call(context, id)?.isEntry === true
      } catch {
        return false
      }
    },
  }
}

/**
 * A `deno.json` {@link JsxTransform} as Oxc's `jsx` options (docs/architecture.md §5.11): Vite 8
 * `oxc.jsx` and Rolldown `transform.jsx`. The classic runtime turns development mode off: Vite
 * enables it outside production, and it would pass `__source`/`__self` props to the `jsxFactory`
 * (Deno never does). The automatic runtime keeps Vite's default unless `react-jsxdev` asks for it.
 */
export function oxcJsxOptions(transform: JsxTransform): {
  runtime: 'automatic' | 'classic'
  importSource?: string
  development?: boolean
  pragma?: string
  pragmaFrag?: string
} {
  if (transform.runtime === 'classic') {
    return {
      runtime: 'classic',
      pragma: transform.factory,
      pragmaFrag: transform.fragment,
      development: false,
    }
  }
  return {
    runtime: 'automatic',
    importSource: transform.importSource,
    ...(transform.development ? { development: true } : {}),
  }
}

/** A {@link JsxTransform} as esbuild's JSX options (Vite 7's `esbuild` config, esbuild). */
export function esbuildJsxOptions(transform: JsxTransform): {
  jsx: 'automatic' | 'transform'
  jsxImportSource?: string
  jsxDev?: boolean
  jsxFactory?: string
  jsxFragment?: string
} {
  if (transform.runtime === 'classic') {
    return { jsx: 'transform', jsxFactory: transform.factory, jsxFragment: transform.fragment }
  }
  return {
    jsx: 'automatic',
    jsxImportSource: transform.importSource,
    ...(transform.development ? { jsxDev: true } : {}),
  }
}

/**
 * A {@link JsxTransform} as Rollup's `jsx` option: `jsxImportSource` is the runtime module
 * (`<source>/jsx-runtime`) and `factory`/`importSource` the `createElement` Rollup falls back to
 * for a `key` after a spread. Rollup has no development runtime: `react-jsxdev` compiles like
 * `react-jsx`. The classic runtime uses global factories, as in Deno.
 */
export function rollupJsxOptions(
  transform: JsxTransform,
):
  | { mode: 'automatic'; factory: string; importSource: string; jsxImportSource: string }
  | { mode: 'classic'; factory: string; fragment: string } {
  if (transform.runtime === 'classic') {
    return { mode: 'classic', factory: transform.factory, fragment: transform.fragment }
  }
  return {
    mode: 'automatic',
    factory: 'createElement',
    importSource: transform.importSource,
    jsxImportSource: `${transform.importSource}/jsx-runtime`,
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
