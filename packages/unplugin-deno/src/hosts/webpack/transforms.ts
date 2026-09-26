/**
 * The source transforms, checks and Wasm modules of the webpack-family adapters (webpack, Rspack
 * and Rsbuild; docs/architecture.md §5.10, §5.12, §6.5, §6.6). The rules are added once the
 * project is loaded (`beforeRun`/`watchRun`, before the host compiles `module.rules`):
 *
 * - local script modules (`.[cm][jt]sx?` outside `node_modules`, the mirror and Deno's npm cache)
 *   go through `state.transform` in a `pre` loader, on the source as written, before the user's
 *   TypeScript/JSX loader: `import.meta.main` is `false` outside entry modules (entries are the
 *   resources the host resolved for dependencies without an issuer, or for workers on webpack),
 *   environment variables are inlined and `Deno.*` references of browser bundles are reported
 *   (errors fail the module's build). The loader is unplugin's public `transform` loader; the
 *   hosts do not pass a map into a first loader, and esbuild-loader ignores one, so the output
 *   maps name the transformed source (only the replaced expressions differ);
 * - mirror files are loaded through unplugin's `load` loader and transformed in the same hook
 *   (the edit's map composed with the mirror's), since the `load` loader replaces the source any
 *   `pre` loader produced;
 * - `.wasm` module imports (no query, no import attribute, not `new URL()`) of local and mirror
 *   files are loaded as the core's instantiating wrapper; the `.wasm` files of npm packages keep
 *   the host's own Wasm support (`experiments.asyncWebAssembly`), which instantiates
 *   asynchronously (browsers limit synchronous compilation to small modules), and `wasm: false`
 *   leaves every `.wasm` file to the host;
 * - loader idents carry a hash of the transform settings (platform, options, inlined variables),
 *   so webpack's persistent cache rebuilds transformed modules when they change; the `.env` files
 *   are dependencies of the modules that read environment variables.
 *
 * npm package files are left alone: webpack (5.111) and Rspack (2.2) evaluate their
 * `import.meta.main` per module themselves (`false` outside the entry module).
 *
 * @module
 */
import { createRequire } from 'node:module'
import { join, normalize } from 'node:path'
import { inlinesEnv } from '../../core/env.js'
import { pathPrefixFilter, splitQuery } from '../../core/id.js'
import { isGlobalCachePath, isNodeModulesPath } from '../../core/npm.js'
import type { Platform } from '../../core/options.js'
import { denoGlobalsFor } from '../../core/options.js'
import type { LoadResult, PluginState } from '../../core/state.js'
import { transformCodeFilter } from '../../core/state.js'
import { PLUGIN_VERSION } from '../../core/version.js'
import { shortHash } from '../../utils/hash.js'
import type { HostLogTarget } from '../shared.js'
import type { LoaderUse, LoadHook, LoadHookResult, MirrorTransform } from './requests.js'
import { loadLoader, mirrorLoad, TAP_NAME, toHostError } from './requests.js'

/** Script modules the source transforms read (the core's `isScriptModuleId` extensions). */
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i

/** Mirror code files (raw assets have no source maps). */
const CODE_FILE = /\.[cm]?js$/

/** `.wasm` files. */
const WASM_FILE = /\.wasm$/i

/** Absolute paths (POSIX, Windows drive letters, UNC); synthesised `unplugin-deno:` modules are not. */
const ABSOLUTE_PATH = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/

/** Files of npm packages (and the mirror, and Rspack's virtual marker modules). */
const NODE_MODULES_DIR = /[\\/]node_modules[\\/]/

/** A `?raw` query: the module is the file's text (`asset/source`), not code. */
const RAW_QUERY = /(?:^\?|&)raw(?:[&=]|$)/

/** Any query. */
const ANY_QUERY = /./

/** The `this` of a `transform` hook run by unplugin's `transform` loader (the part used). */
export interface TransformHookContext {
  addWatchFile(file: string): void
}

/** A `transform` hook for unplugin's `transform` loader, with its code filter. */
export interface TransformHook {
  filter: { code: RegExp }
  handler(this: TransformHookContext, code: string, id: string): Promise<LoadHookResult | null>
}

/** A `use` entry that runs a `transform` hook through unplugin's `transform` loader. */
export interface TransformLoaderUse {
  loader: string
  ident: string
  options: { plugin: { name: string; transform: TransformHook } }
}

/** A `module.rules` entry of the adapters (valid for webpack and Rspack). */
export interface AdapterRule {
  enforce?: 'pre'
  test: RegExp
  include?: RegExp | ((path: string) => boolean)
  exclude?: RegExp[]
  resourceQuery?: { not: RegExp }
  dependency?: { not: string }
  type?: 'javascript/esm'
  use: Array<LoaderUse | TransformLoaderUse>
}

const requireFromHere = createRequire(import.meta.url)
const transformLoaders = new Map<string, string>()

/**
 * The `use` entry that runs `hook` through unplugin's `transform` loader for `host` (the public
 * `unplugin/{webpack,rspack}/loaders/transform` entries): the loader calls
 * `options.plugin.transform` with the source and `this.resource`, filtered by the hook's code
 * filter. `ident` names the options in the host's module identifiers (persistent cache).
 */
export function transformLoader(
  host: 'webpack' | 'rspack',
  hook: TransformHook,
  ident: string,
): TransformLoaderUse {
  let loader = transformLoaders.get(host)
  if (loader === undefined) {
    loader = requireFromHere.resolve(`unplugin/${host}/loaders/transform`)
    transformLoaders.set(host, loader)
  }
  return { loader, ident, options: { plugin: { name: TAP_NAME, transform: hook } } }
}

/** A resource as a key of {@link EntryModules}: the path, without query, `#` unescaped. */
function resourceKey(resource: string): string {
  return normalize(splitQuery(resource.replaceAll('\0#', '#')).base)
}

/**
 * The entry modules of a compiler (they keep `import.meta.main`, §5.10): the resources the host
 * resolved for dependencies without an issuer (entries, also those of child compilations) and,
 * where the host says so (webpack's `dependencyType`), for workers, which are the main module of
 * their thread in Deno too. Kept across compilations: a host that resolves again only what
 * changed (watch mode) still knows its entries.
 */
export class EntryModules {
  readonly #paths = new Set<string>()

  /** `normalModuleFactory.hooks.afterResolve`: records the resource of an entry. */
  note(issuer: string, resource: string | undefined, dependencyType?: string): void {
    if (resource === undefined || resource === '') return
    if (issuer === '' || dependencyType === 'worker') this.#paths.add(resourceKey(resource))
  }

  /** Whether the module `id` (a path, with an optional query) is an entry. */
  has(id: string): boolean {
    return this.#paths.has(resourceKey(id))
  }
}

/** What {@link SourceTransforms} needs from its adapter. */
export interface SourceTransformsHost {
  /** The host whose loaders run the hooks. */
  host: 'webpack' | 'rspack'
  /** The platform the compiler bundles for (an Rsbuild environment's, else the build's). */
  platform(): Platform
  /** The compiler's log target (set before the core logs, as it may log for several compilers). */
  log: HostLogTarget
}

/**
 * The source transforms of one compiler (see the module documentation): the `transform` hook
 * shared by local script modules and mirror files, and the rules that run it.
 */
export class SourceTransforms {
  readonly entries: EntryModules = new EntryModules()
  readonly #state: PluginState
  readonly #adapter: SourceTransformsHost

  constructor(state: PluginState, adapter: SourceTransformsHost) {
    this.#state = state
    this.#adapter = adapter
  }

  /**
   * The code filter of the transforms that are on (`null`: none is); the import-attribute
   * pre-pass is not needed on these hosts (their `beforeResolve` sees the attributes).
   */
  codeFilter(): RegExp | null {
    return transformCodeFilter({ ...this.#state.options, importAttributes: false })
  }

  /**
   * `state.transform` for the module `id` with the compiler's platform and entries. `watch`
   * receives the `.env` files the module's inlined variables come from.
   *
   * @throws The host error of a `DenoPluginError` (`denoGlobals: 'error'`).
   */
  async transform(
    code: string,
    id: string,
    watch?: (file: string) => void,
  ): Promise<LoadResult | null> {
    const state = this.#state
    state.setLogTarget(this.#adapter.log)
    const platform = this.#adapter.platform()
    try {
      const result = await state.transform(code, id, {
        platform,
        isEntry: () => this.entries.has(id),
      })
      if (watch !== undefined && inlinesEnv(state.options, platform) && ENV_READ.test(code)) {
        const env = await state.envInlining()
        for (const file of env?.files ?? []) watch(file)
      }
      return result
    } catch (error) {
      throw toHostError(error)
    }
  }

  /**
   * The rules to append to `module.rules` once the project is loaded: the `pre` transform of
   * local script modules (when a transform is on), the mirror files' `load` (and transform), and
   * `.wasm` module imports (the `wasm` option).
   */
  async rules(): Promise<AdapterRule[]> {
    const state = this.#state
    const { host } = this.#adapter
    const ident = await this.#ident()
    const transform: MirrorTransform = (code, id, watch) => this.transform(code, id, watch)
    const mirrorDir = pathPrefixFilter(state.cacheDir, state.flavor)
    const rules: AdapterRule[] = []
    const filter = this.codeFilter()
    if (filter !== null) {
      rules.push({
        enforce: 'pre',
        test: SCRIPT_FILE,
        include: ABSOLUTE_PATH,
        exclude: [
          NODE_MODULES_DIR,
          mirrorDir,
          ...state.denoDirs.map((dir) => pathPrefixFilter(join(dir, 'npm'), state.flavor)),
        ],
        resourceQuery: { not: RAW_QUERY },
        dependency: { not: 'url' },
        use: [
          transformLoader(
            host,
            {
              filter: { code: filter },
              async handler(code, id) {
                const result = await transform(code, id, (file) => this.addWatchFile(file))
                return result === null ? null : { code: result.code, map: result.map ?? null }
              },
            },
            `${TAP_NAME}-transform-${ident}`,
          ),
        ],
      })
    }
    // A RegExp (not a function) keeps Rspack from calling into JavaScript for every module.
    rules.push({
      test: CODE_FILE,
      include: mirrorDir,
      use: [loadLoader(host, mirrorLoad(state, transform), `${TAP_NAME}-mirror-${ident}`)],
    })
    if (state.options.wasm) {
      rules.push({
        test: WASM_FILE,
        include: (path) => takesOverWasm(state, path),
        resourceQuery: { not: ANY_QUERY },
        dependency: { not: 'url' },
        type: 'javascript/esm',
        use: [loadLoader(host, wasmLoad(state), `${TAP_NAME}-wasm`)],
      })
    }
    return rules
  }

  /**
   * A hash of what the transforms depend on besides the module's source: the plugin version,
   * the platform, the options and the inlined variables with their values.
   */
  async #ident(): Promise<string> {
    const state = this.#state
    const { options } = state
    const platform = this.#adapter.platform()
    const env = inlinesEnv(options, platform) ? await state.envInlining() : null
    return shortHash(
      JSON.stringify([
        PLUGIN_VERSION,
        platform,
        options.importMetaMain,
        denoGlobalsFor(options, platform),
        env === null ? null : [options.env, env.entries()],
      ]),
      12,
    )
  }
}

/** Code that reads environment variables (the `.env` files become its dependencies). */
const ENV_READ = /Deno\.env|process\.env/

/**
 * Whether the plugin loads the `.wasm` file at `path` (§5.12): local files and mirror files (Wasm
 * of remote and JSR modules), not those of npm packages (`node_modules` and Deno's npm cache).
 */
export function takesOverWasm(state: PluginState, path: string): boolean {
  if (!state.ready || !ABSOLUTE_PATH.test(path)) return false
  if (state.mirror.isMirrorPath(path)) return true
  return (
    !isNodeModulesPath(path, state.flavor) && !isGlobalCachePath(path, state.denoDirs, state.flavor)
  )
}

/** The `load` hook of `.wasm` modules: the core's instantiating wrapper (§5.12). */
export function wasmLoad(state: PluginState): LoadHook {
  return async (id) => {
    const loaded = await state.load(id).catch((error: unknown) => {
      throw toHostError(error)
    })
    return loaded === null ? null : { code: loaded.code }
  }
}
