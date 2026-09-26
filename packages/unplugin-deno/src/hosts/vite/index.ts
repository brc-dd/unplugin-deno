/**
 * Vite hooks (Vite 8 and 7), placed under unplugin's `vite` escape hatch and merged over the
 * generic Rollup-family hooks (docs/architecture.md §6.1):
 *
 * - `config`: loads the project for the Vite root; applies the `deno.json` JSX settings
 *   (`oxc.jsx` on Vite 8, `esbuild.jsx*` on Vite 7) unless the config sets JSX; mirrors path-like
 *   import-map entries into `resolve.alias` (CSS `@import`, Sass `@use`); registers the plugin in
 *   `worker.plugins`; in the dev server adds the `https:`/`data:` alias so import analysis hands
 *   those imports to plugins; defaults `cacheDir` to `<root>/node_modules/.vite` for Deno
 *   projects without a `package.json`;
 * - `configEnvironment`: the `deno` export condition for server environments on the Deno
 *   platform, and the optimizer plugin per environment (Vite 8);
 * - `configResolved`: host facts, and `server.fs.allow` for the mirror and the workspace root;
 * - `configureServer`/`hotUpdate`: `deno.json(c)`, import maps, `package.json` files and
 *   `deno.lock` reload the project, invalidate every environment and reload the page;
 * - `resolveId`: the platform of `this.environment`, prebundled npm and JSR dependencies in the
 *   dev server (`depsOptimizer`), and virtual ids for import-attribute markers;
 * - `load`: marker modules (watching their target file) and mirror files;
 * - `transform`: import attributes and the source transforms of §5.10 for the platform of
 *   `this.environment` (`import.meta.main` only in builds).
 *
 * @module
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type {
  Alias,
  AliasOptions,
  Environment,
  EnvironmentOptions,
  Logger as ViteLogger,
  Plugin as VitePlugin,
  PluginOption,
  ResolvedConfig,
  UserConfig,
  ViteDevServer,
} from 'vite'
import type { HostInput } from '../../core/entries.js'
import { matchPattern } from '../../core/platform.js'
import { writeSidecar } from '../../core/sidecar.js'
import { parseSpecifier } from '../../core/specifier.js'
import type { PluginState } from '../../core/state.js'
import { transformCodeFilter } from '../../core/state.js'
import { isWatchedFile } from '../../core/watch.js'
import { realpathMaybeMissing } from '../../engine/npm-package.js'
import { toDirUrl, toPath } from '../../utils/path.js'
import type { HostLogTarget, HostResolve, TransformHostContext } from '../shared.js'
import {
  esbuildJsxOptions,
  oxcJsxOptions,
  rollupEntryDirectory,
  toRollupResult,
  transformContext,
} from '../shared.js'
import {
  consumerOf,
  conditionsToAdd,
  environmentPlatform,
  environmentTarget,
  targetOf,
  VITE_EXTERNAL_CONDITIONS,
  VITE_SERVER_CONDITIONS,
} from './environment.js'
import {
  coreMarkerId,
  parseViteMarkerId,
  VITE_MARKER_ID_FILTER,
  viteMarkerIdFor,
} from './marker.js'
import type { DepsOptimizer } from './optimizer.js'
import { optimizedDependency, optimizerPlugin, packageKind } from './optimizer.js'
import { esbuildOptimizerPlugin } from './optimizer-esbuild.js'

const REMOTE_URL = /^(https?:\/\/|data:)/

/**
 * Makes the dev server's import analysis resolve `https:` and `data:` imports through plugins
 * (it skips URLs no alias matches). The replacement is the match itself (`'$&'` breaks Vite 8
 * builds, research/feasibility.md §5); the alias is only needed, and added, in the dev server.
 */
export const REMOTE_ALIAS: Alias = { find: REMOTE_URL, replacement: '$1' }

/** Options of {@link viteHooks}. */
export interface ViteHooksOptions {
  /**
   * The plugins for Vite's worker bundles (`worker.plugins`, D7): a new instance of this plugin.
   * Unset for that instance itself (the main config's `worker.plugins` also serves nested
   * workers).
   */
  workerPlugins?: (() => PluginOption) | undefined
}

/** The Vite-specific hooks of the plugin (merged over the generic ones by unplugin). */
export function viteHooks(
  state: PluginState,
  { workerPlugins }: ViteHooksOptions = {},
): Partial<VitePlugin> {
  const loadFilter = { id: [...state.loadFilter(), VITE_MARKER_ID_FILTER] }
  const codeFilter = transformCodeFilter(state.options)
  /** Whether Vite's optimizer bundles with Rolldown (Vite 8) rather than esbuild (Vite 7). */
  let rolldownOptimizer = true
  /** The Vite root (marker ids are relative to it). */
  let root = process.cwd()
  /** The dev server's environments by name (for the optimizer plugin). */
  const environments = new Map<string, Environment>()
  const hooks: Partial<VitePlugin> = {
    async config(config, env) {
      state.setLogTarget(this)
      rolldownOptimizer =
        typeof (this.meta as { rolldownVersion?: unknown }).rolldownVersion === 'string'
      root = viteRoot(config)
      // The build's own platform is the client's; other environments resolve with a target.
      state.setHints({
        root,
        command: env.command,
        platform: 'browser',
        version: this.meta.viteVersion,
      })
      await state.prepare()
      loadFilter.id = [...state.loadFilter(), VITE_MARKER_ID_FILTER]
      addAliases(config, importMapAliases(state, root))
      if (env.command === 'serve') addRemoteAlias(config)
      const result: UserConfig = { ...jsxConfig(state, config, rolldownOptimizer) }
      if (workerPlugins !== undefined) result.worker = { plugins: () => [workerPlugins()] }
      const { project } = state
      if (
        config.cacheDir === undefined &&
        project.configPath !== null &&
        !hasPackageJson(root, project.workspaceRoot)
      ) {
        // Vite would use the node_modules of the nearest ancestor with a package.json.
        result.cacheDir = join(root, 'node_modules', '.vite')
      }
      return Object.keys(result).length === 0 ? null : result
    },

    configEnvironment(name, config, env) {
      if (!state.ready) return null
      const consumer = consumerOf(name, config.consumer)
      const result: EnvironmentOptions = {}
      if (consumer === 'server' && environmentPlatform(state, name, consumer) === 'deno') {
        const conditions = conditionsToAdd(
          config.resolve?.conditions,
          VITE_SERVER_CONDITIONS,
          'deno',
        )
        const externalConditions = conditionsToAdd(
          config.resolve?.externalConditions,
          VITE_EXTERNAL_CONDITIONS,
          'deno',
        )
        result.resolve = {
          ...(conditions === undefined ? {} : { conditions }),
          ...(externalConditions === undefined ? {} : { externalConditions }),
        }
      }
      if (env.command === 'serve') {
        const target = environmentTarget(state, name, consumer, true)
        const optimizer = (): DepsOptimizer | undefined => devOptimizer(environments.get(name))
        // Vite 8 bundles dependencies with Rolldown, Vite 7 with esbuild.
        result.optimizeDeps = rolldownOptimizer
          ? {
              rolldownOptions: {
                plugins: [optimizerPlugin(state, target, state.generation, optimizer)],
              },
            }
          : {
              esbuildOptions: {
                plugins: [esbuildOptimizerPlugin(state, target, state.generation, optimizer)],
              },
            }
      }
      return result
    },

    configResolved(config) {
      state.setLogTarget(this)
      state.setHints({ command: config.command, version: this.meta.viteVersion })
      if (config.command === 'serve' && state.ready) allowServing(config, state)
    },

    configureServer(server) {
      for (const [name, environment] of Object.entries(server.environments)) {
        environments.set(name, environment)
      }
      const logTarget = viteLogTarget(server.config.logger)
      const watch = (): void => {
        const files = state.watchFiles()
        if (files.length > 0) server.watcher.add(files)
      }
      watch()
      let reloading: Promise<void> = Promise.resolve()
      const onFile = (file: string): void => {
        if (!state.ready || !isWatchedFile(state.project, file, state.flavor)) return
        reloading = reloading
          .then(async () => {
            state.setLogTarget(logTarget)
            if (!(await state.watchChange(file))) return
            watch()
            reloadEnvironments(server)
          })
          .catch((error: unknown) => {
            server.config.logger.error(`[unplugin-deno] ${String(error)}`, {
              error: error instanceof Error ? error : undefined,
            })
          })
      }
      server.watcher.on('add', onFile)
      server.watcher.on('change', onFile)
      server.watcher.on('unlink', onFile)
    },

    hotUpdate(options) {
      // configureServer's watcher reloads the project and sends the full reload.
      if (state.ready && isWatchedFile(state.project, options.file, state.flavor)) return []
      return undefined
    },

    async buildStart(options) {
      state.setLogTarget(this)
      await state.prepare()
      for (const file of state.watchFiles()) this.addWatchFile(file)
      const environment = this.environment
      if (environment?.mode === 'build') {
        state.setHints({ input: moduleInputs(options.input) })
        await state.addEntrypoints(targetOf(state, environment))
      }
    },

    resolveId: {
      filter: { id: state.resolveIdFilter(true) },
      async handler(source, importer, options) {
        state.setLogTarget(this)
        await state.prepare()
        const environment: Environment | undefined = this.environment
        const scan = (options as { scan?: boolean }).scan === true
        const target = environment === undefined ? undefined : targetOf(state, environment)
        const outcome = await state.resolve(source, importer, {
          kind: options.kind,
          isEntry: options.isEntry,
          scan,
          target,
        })
        if (outcome === null) return null
        // Vite keeps builtins external itself, side-effect free: an unused `node:module` import
        // of Rolldown's runtime is then dropped from SSR output instead of kept as a bare import.
        if (outcome.type === 'external' && parseSpecifier(outcome.id).kind === 'node') return null
        const resolve: HostResolve = (request, from) =>
          this.resolve(request, from, { skipSelf: true, kind: options.kind })
        if (outcome.type === 'marker' || outcome.type === 'host-marker') {
          const result = await toRollupResult(outcome, importer, resolve)
          const id = result === null ? null : viteMarkerIdFor(result.id, root, state.flavor)
          return id === null ? result : { id }
        }
        const optimizer = devOptimizer(environment)
        const kind = optimizer === undefined ? null : packageKind(state, outcome)
        if (optimizer !== undefined && kind !== null) {
          const optimized = await optimizedDependency(
            optimizer,
            source,
            kind,
            outcome,
            resolve,
            scan,
          )
          if (optimized !== null) return optimized
        }
        return toRollupResult(outcome, importer, resolve)
      },
    },

    load: {
      filter: loadFilter,
      async handler(id) {
        state.setLogTarget(this)
        const marker = parseViteMarkerId(id, root, state.flavor)
        if (marker === null) return state.load(id)
        // Edits of the target file update the importers (dev server) or rebuild (watch mode).
        this.addWatchFile(marker.path)
        return state.load(coreMarkerId(marker))
      },
    },

    transform: {
      filter: { id: { exclude: [/^\0/] }, code: codeFilter ?? /\bwith\s*\{/ },
      async handler(code, id) {
        state.setLogTarget(this)
        await state.prepare()
        const environment: Environment | undefined = this.environment
        return state.transform(code, id, {
          ...transformContext(this as TransformHostContext, id),
          platform: environment === undefined ? undefined : targetOf(state, environment).platform,
          // The dev server serves modules one by one: nothing is bundled into an entry chunk.
          importMetaMain: environment === undefined || environment.mode === 'build',
        })
      },
    },

    async watchChange(id) {
      // The dev server's changes are handled by configureServer.
      if (this.environment?.mode !== 'build') return
      await state.watchChange(id)
    },

    async buildEnd() {
      state.setLogTarget(this)
      const environment: Environment | undefined = this.environment
      if (state.ready) {
        state.reportDuplicates(
          environment === undefined ? undefined : targetOf(state, environment).platform,
        )
      }
      // Watch mode keeps the engines between rebuilds; a build, or a closing dev server, ends.
      if (environment?.mode === 'build' && this.meta.watchMode) await state.flush()
      else await state.close()
    },

    // The sidecar deno.json and deno.lock of a Deno server environment's output (S3).
    async writeBundle(output, bundle) {
      if (state.options.emitDenoConfig === false || !state.ready) return
      const dir = rollupEntryDirectory(output, bundle)
      if (dir === undefined) return
      state.setLogTarget(this)
      const environment: Environment | undefined = this.environment
      await writeSidecar(state, dir, {
        platform: environment === undefined ? undefined : targetOf(state, environment).platform,
        dispose: !this.meta.watchMode,
      })
    },
  }
  // The generic transform hook is removed too when nothing needs it (core/plugin.ts).
  if (codeFilter === null) delete hooks.transform
  return hooks
}

/**
 * The JSX settings of `deno.json` as Vite config (§5.11): `oxc.jsx` on Vite 8, or `esbuild.jsx*`
 * on Vite 7 and on Vite 8 configs that set `esbuild` options (Vite converts them, and would ignore
 * them next to `oxc`). Nothing when the config sets JSX itself or turns the transform off.
 */
export function jsxConfig(state: PluginState, config: UserConfig, vite8: boolean): UserConfig {
  const { oxc, esbuild } = config
  if (vite8 ? oxc === false : esbuild === false) return {}
  if (typeof oxc === 'object' && oxc.jsx !== undefined) return {}
  const esbuildJsx = ['jsx', 'jsxFactory', 'jsxFragment', 'jsxImportSource', 'jsxDev'] as const
  if (typeof esbuild === 'object' && esbuildJsx.some((key) => esbuild[key] !== undefined)) return {}
  const decision = state.jsxTransform(vite8 ? 'Vite (Oxc)' : 'Vite (esbuild)')
  if (decision === null) return {}
  const useEsbuild = !vite8 || (typeof esbuild === 'object' && oxc === undefined)
  return useEsbuild
    ? { esbuild: esbuildJsxOptions(decision.transform) }
    : { oxc: { jsx: oxcJsxOptions(decision.transform) } }
}

/**
 * `resolve.alias` entries for the path-like entries of the import map that applies to the Vite
 * root (D4): bare keys whose target is a local file or directory (`"@styles/": "./src/styles/"`,
 * `"@app/theme": "./theme.css"`), so what Vite resolves without user plugins (CSS `@import`, Sass
 * `@use`, PostCSS) sees them. The map is the root `imports` with the scope that contains `root`
 * (the member a member-rooted app lives in) over it, as import maps try scopes first. Never
 * `jsr:`/`npm:`/URL targets, keys other scopes redefine (an alias would apply everywhere), or keys
 * matched by `exclude`. Replacements use `/` separators.
 */
export function importMapAliases(state: PluginState, root: string): Alias[] {
  const { project, options } = state
  if (project.disabled) return []
  const { map } = project.importMap
  const rootUrl = toDirUrl(root, state.flavor)
  const own = map.scopes
    .filter((scope) => rootUrl.startsWith(scope.prefix))
    .toSorted((a, b) => b.prefix.length - a.prefix.length)[0]
  const ownKeys = new Set(own?.map.entries.map((entry) => entry.key))
  const redefined = new Set(
    map.scopes
      .filter((scope) => scope !== own)
      .flatMap((scope) => scope.map.entries.map((entry) => entry.key)),
  )
  const entries = [
    ...(own?.map.entries ?? []),
    ...map.imports.entries.filter((entry) => !ownKeys.has(entry.key)),
  ]
  const aliases: Alias[] = []
  for (const entry of entries) {
    const { key, address } = entry
    if (!entry.bare || address === null || !address.startsWith('file:') || redefined.has(key)) {
      continue
    }
    if (matchPattern(options.exclude, key)) continue
    const path = toPath(address, state.flavor)
    const target = state.flavor === 'win32' ? path.replaceAll('\\', '/') : path
    const escaped = key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    aliases.push({
      find: new RegExp(key.endsWith('/') ? `^${escaped}` : `^${escaped}(?=[?#]|$)`),
      // `$` is special in String.prototype.replace replacements.
      replacement: target.replaceAll('$', '$$$$'),
    })
  }
  return aliases
}

/** Appends `aliases` after the configured ones (which win), skipping those already there. */
function addAliases(config: UserConfig, aliases: readonly Alias[]): void {
  if (aliases.length === 0) return
  const resolve = (config.resolve ??= {})
  const existing = normalizeAlias(resolve.alias)
  const sources = new Set(
    existing.flatMap((alias) => (alias.find instanceof RegExp ? [alias.find.source] : [])),
  )
  const added = aliases.filter(
    (alias) => !(alias.find instanceof RegExp && sources.has(alias.find.source)),
  )
  if (added.length > 0) resolve.alias = [...existing, ...added]
}

/** The dev optimizer of an environment (not during builds). */
function devOptimizer(environment: Environment | undefined): DepsOptimizer | undefined {
  return environment?.mode === 'dev' ? environment.depsOptimizer : undefined
}

/** Vite's root: `root` resolved against the working directory, symlinks resolved like Vite. */
function viteRoot(config: UserConfig): string {
  const root = resolvePath(config.root ?? '.')
  if (config.resolve?.preserveSymlinks === true) return root
  try {
    return realpathSync(root)
  } catch {
    return root
  }
}

/** Whether a `package.json` exists in `root` or an ancestor up to the workspace root. */
function hasPackageJson(root: string, workspaceRoot: string): boolean {
  let dir = root
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return true
    const parent = dirname(dir)
    if (dir === workspaceRoot || parent === dir) return false
    dir = parent
  }
}

/** Adds {@link REMOTE_ALIAS} after the configured aliases (which win), once. */
function addRemoteAlias(config: UserConfig): void {
  const resolve = (config.resolve ??= {})
  const aliases = normalizeAlias(resolve.alias)
  const present = aliases.some(
    (alias) => alias.find instanceof RegExp && alias.find.source === REMOTE_URL.source,
  )
  if (!present) resolve.alias = [...aliases, REMOTE_ALIAS]
}

/** Vite's two alias shapes as an array. */
function normalizeAlias(alias: AliasOptions | undefined): Alias[] {
  if (alias === undefined) return []
  if (isAliasArray(alias)) return [...alias]
  return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }))
}

function isAliasArray(alias: AliasOptions): alias is readonly Alias[] {
  return Array.isArray(alias)
}

/**
 * Lets the dev server serve files from the mirror and the Deno workspace root (members outside
 * the Vite root). Done on the resolved config: a `server.fs.allow` from the `config` hook would
 * replace Vite's default (the searched workspace root) instead of extending it.
 */
function allowServing(config: ResolvedConfig, state: PluginState): void {
  const allow = config.server.fs.allow
  for (const dir of [state.cacheDir, state.project.workspaceRoot]) {
    for (const spelling of new Set([dir, realpathMaybeMissing(dir, state.flavor)])) {
      const path = state.flavor === 'win32' ? spelling.replaceAll('\\', '/') : spelling
      if (!allow.includes(path)) allow.push(path)
    }
  }
}

/** The module inputs of a build (HTML entries are not modules the engine can read). */
function moduleInputs(input: HostInput): HostInput {
  if (input === null || input === undefined) return input
  if (typeof input === 'string') return isModuleInput(input) ? input : []
  if (isStringArray(input)) return input.filter(isModuleInput)
  return Object.fromEntries(Object.entries(input).filter(([, value]) => isModuleInput(value)))
}

function isModuleInput(value: string): boolean {
  return !/\.html?$/i.test(value)
}

function isStringArray(value: HostInput): value is readonly string[] {
  return Array.isArray(value)
}

/** Invalidates every environment's module graph and reloads its clients. */
function reloadEnvironments(server: ViteDevServer): void {
  for (const environment of Object.values(server.environments)) {
    environment.moduleGraph.invalidateAll()
    environment.hot.send({ type: 'full-reload', path: '*' })
  }
}

/** Log output through Vite's logger, for work outside plugin hooks (file watcher events). */
function viteLogTarget(logger: ViteLogger): HostLogTarget {
  return {
    warn: (message) => logger.warn(`[unplugin-deno] ${message}`, { timestamp: true }),
    info: (message) => logger.info(`[unplugin-deno] ${message}`, { timestamp: true }),
  }
}
