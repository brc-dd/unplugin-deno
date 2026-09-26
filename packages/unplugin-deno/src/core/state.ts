/**
 * The state of one plugin instance across a build (docs/architecture.md §5): resolved options, the
 * project, the platform, the engines (one per engine platform and conditions, created lazily), the
 * mirror and the resolver. Host adapters feed it host facts (`setHints`, `setLogTarget`) and call
 * its hook implementations.
 *
 * @module
 */
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { MagicString } from 'magic-string'
import type { UnpluginContextMeta } from 'unplugin'
import type { Project } from '../config/project.js'
import { configGeneration, loadProject } from '../config/project.js'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import { resolveDenoDir } from '../engine/deno-dir.js'
import { createEngine } from '../engine/create.js'
import type { EngineSelection } from '../engine/select.js'
import { selectEngineKind } from '../engine/select.js'
import type { EncodedSourceMap, Engine } from '../engine/types.js'
import type { HostContext, HostLogTarget } from '../hosts/shared.js'
import { createHostLogger } from '../hosts/shared.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR, toFileUrl, toPath } from '../utils/path.js'
import { vendoredLoaderVersion } from '../vendored-deno-loader.js'
import type { ImportAllowList } from './allow-import.js'
import {
  createImportAllowList,
  DEFAULT_JSR_REGISTRY,
  jsrRegistryUrl,
  projectRemoteUrls,
} from './allow-import.js'
import type { AstParser, MarkerModule } from './attributes.js'
import { applyImportAttributes, synthesizeMarkerModule } from './attributes.js'
import {
  denoGlobalsMessage,
  displayModule,
  foreignNodeModulesMessage,
  PackageVersions,
} from './checks.js'
import type { HostInput } from './entries.js'
import { normalizeEntries } from './entries.js'
import type { EnvInlining } from './env.js'
import { inlinesEnv, loadEnv } from './env.js'
import {
  DENO_TYPE_ID_FILTER,
  DENO_VIRTUAL_ID_FILTER,
  EMPTY_MODULE_ID,
  isDenoVirtualId,
  isForeignId,
  isScriptModuleId,
  isVirtualId,
  pathPrefixFilter,
  readDenoType,
  splitQuery,
} from './id.js'
import type { JsrRoute, JsrRouteDecision } from './jsr-npm.js'
import { jsrRouteFor } from './jsr-npm.js'
import { LockfilePolicy, lockfileModeFor } from './lockfile-policy.js'
import type { Mirror } from './mirror.js'
import { createMirror, hostMirrorMap, mirrorGeneration } from './mirror.js'
import type { JsxDecision } from './jsx.js'
import { jsxTransformFor, precompileWarning } from './jsx.js'
import type { NpmStrategy } from './npm.js'
import { denoDirVariants, isGlobalCachePath, isNodeModulesPath, npmStrategyFor } from './npm.js'
import type { Platform, ResolvedOptions } from './options.js'
import { defaultCacheDir, denoGlobalsFor, resolveOptions } from './options.js'
import type { Options } from './options.js'
import type { PlatformHint } from './platform.js'
import { conditionsFor, derivePlatform, enginePlatformFor } from './platform.js'
import type {
  ResolveOutcome,
  Resolver,
  ResolveRequest,
  ResolverState,
  ResolveTarget,
} from './resolve.js'
import { BROAD_RESOLVE_ID_FILTER, createResolver, resolveIdFilter } from './resolve.js'
import type { ExternalRecord } from './sidecar.js'
import { ExternalRecorder } from './sidecar.js'
import type { DenoReference } from './source.js'
import { applySourceTransforms, scanSource } from './source.js'
import { isWasmModuleId, synthesizeWasmModule, WASM_MODULE_ID_FILTER } from './wasm.js'
import { PLUGIN_VERSION } from './version.js'
import type { InvalidationTarget } from './watch.js'
import { invalidateProject, isWatchedFile, watchFiles } from './watch.js'

/** Host facts an adapter reports before the build starts. */
export interface StateHints {
  /** The host root (Rolldown `cwd`); default `process.cwd()`. */
  root?: string | undefined
  platform?: PlatformHint | undefined
  conditions?: readonly string[] | undefined
  /** The build inputs, for `engine.addEntrypoints`. */
  input?: HostInput
  /** The host's version, for debug output. */
  version?: string | undefined
  /** `serve` for dev servers; default `build`. */
  command?: 'build' | 'serve' | undefined
}

/** What depends on the loaded project; replaced when the project is reloaded. */
interface Configuration {
  project: Project
  platform: Platform
  conditions: string[]
  npmStrategy: NpmStrategy
  cacheDir: string
  /** `configGeneration(project)`, the input of every mirror generation. */
  configGeneration: string
  generation: string
  mirror: Mirror
  denoDirs: string[]
  filter: RegExp
  /** The remote-import allow-list (R15). */
  allowImport: ImportAllowList
  /** How `deno.lock` is used (R5, X5). */
  lockfilePolicy: LockfilePolicy
  /** Where `jsr:` packages come from (R11). */
  jsrRoute: JsrRouteDecision
  /** Resolvers of other {@link ResolveTarget}s, keyed by target. */
  targets: Map<string, Resolver>
  /** Mirrors of other generations (targets with another platform or conditions). */
  mirrors: Map<string, Mirror>
  /** The environment variables to inline (read on first use, §5.10). */
  env?: Promise<EnvInlining>
}

/** The platform and conditions an engine is created for. */
export interface EngineTarget {
  platform: Platform
  conditions: readonly string[]
}

/** A source map in the shape hosts accept (`sources` without `null`, `file` a string). */
export interface HostSourceMap {
  version: 3
  file?: string
  sources: string[]
  sourcesContent?: string[]
  names: string[]
  mappings: string
}

/** Host facts of one `transform` call (§5.10). */
export interface TransformContext {
  /** The host's parser (`this.parse`), for the import-attribute pre-pass and the source scan. */
  parse?: AstParser | undefined
  /** Whether the module is an entry of the build (`this.getModuleInfo(id)?.isEntry`). */
  isEntry?: (() => boolean) | undefined
  /** The platform the module is bundled for (a Vite environment's); default: the build's. */
  platform?: Platform | undefined
  /** `false` leaves `import.meta.main` alone (Vite's dev server serves modules unbundled). */
  importMetaMain?: boolean | undefined
}

/**
 * The `code` filter of the `transform` hook for the resolved options: import attributes, and the
 * source transforms and checks that are on (§5.5, §5.10); `null` when none is (no hook needed).
 */
export function transformCodeFilter(options: ResolvedOptions): RegExp | null {
  const alternatives: string[] = []
  if (options.importAttributes) alternatives.push('\\bwith\\s*\\{')
  if (options.importMetaMain) alternatives.push('import\\.meta\\.main')
  if (options.env !== false) alternatives.push('Deno\\.env\\.get', 'process\\.env')
  if (options.denoGlobals !== 'off') alternatives.push('\\bDeno\\.')
  return alternatives.length === 0 ? null : new RegExp(alternatives.join('|'))
}

/** The source of a module returned from `load` or `transform`. */
export interface LoadResult {
  code: string
  map?: HostSourceMap | null
  /** `js` for synthesised and mirrored modules (Rolldown `moduleType`). */
  moduleType?: MarkerModule['moduleType']
}

/** Converts an engine or mirror source map to {@link HostSourceMap}. */
export function toHostSourceMap(map: EncodedSourceMap | null | undefined): HostSourceMap | null {
  if (map === null || map === undefined) return null
  const result: HostSourceMap = {
    version: 3,
    sources: map.sources.map((source) => source ?? ''),
    names: map.names,
    mappings: map.mappings,
  }
  if (typeof map.file === 'string') result.file = map.file
  const content = map.sourcesContent
  if (content !== undefined && content.every((item) => typeof item === 'string')) {
    result.sourcesContent = content as string[]
  }
  return result
}

/** See the module documentation. */
export class PluginState implements ResolverState, InvalidationTarget {
  readonly framework: UnpluginContextMeta['framework']
  readonly logger: Logger
  readonly resolver: Resolver
  readonly flavor: PathFlavor = HOST_PATH_FLAVOR
  options: ResolvedOptions
  /**
   * Set by adapters whose host resolves every import with its attributes (esbuild's `args.with`):
   * the transform pre-pass is then not needed (§5.5). Rollup does not set it: it
   * resolves each specifier once per module whatever its attributes (§5.9).
   */
  nativeAttributes = false
  readonly #userOptions: Options | undefined
  #hints: StateHints = {}
  #logTarget: HostLogTarget | undefined
  #configuration: Configuration | undefined
  #preparing: Promise<Configuration> | undefined
  readonly #engines = new Map<string, Promise<Engine>>()
  /** The engine kind for this project (`engine: 'auto'` may probe the Deno binary once). */
  #selection: Promise<EngineSelection> | undefined
  /** Keys of the warnings logged once (see {@link PluginState.warnOnce}). */
  readonly #warned = new Set<string>()
  /** npm packages bundled in this build, per platform (X4). */
  readonly #packages = new PackageVersions()
  /** Imports kept external, per platform (the sidecar deno.lock, S3). */
  readonly #externals = new ExternalRecorder()

  /**
   * @throws {DenoPluginError} `OPTIONS_INVALID` for invalid options (checked at plugin creation).
   */
  constructor(userOptions: Options | undefined, framework: UnpluginContextMeta['framework']) {
    this.#userOptions = userOptions
    this.framework = framework
    this.options = resolveOptions(userOptions, { root: process.cwd(), env: process.env })
    this.logger = createHostLogger(() => this.#logTarget, { debug: this.options.debug })
    this.resolver = createResolver(this)
  }

  /** The host context whose `warn`/`info` the logger uses (adapters set it in every hook). */
  setLogTarget(target: HostLogTarget | undefined): void {
    this.#logTarget = target
  }

  /** Records host facts (see {@link StateHints}); takes effect at the next project load. */
  setHints(hints: StateHints): void {
    this.#hints = { ...this.#hints, ...hints }
  }

  get hints(): Readonly<StateHints> {
    return this.#hints
  }

  /** The host facts the core reads (§5.1), from the adapter's hints. */
  get host(): HostContext {
    const hints = this.#hints
    return {
      framework: this.framework,
      root: hints.root ?? process.cwd(),
      command: hints.command ?? 'build',
      platformHint: hints.platform,
      conditionsHint: hints.conditions === undefined ? undefined : [...hints.conditions],
      logger: this.logger,
      version: hints.version,
    }
  }

  // -- configuration --------------------------------------------------------------------------

  /** Loads the project and derives everything from it, once (until the project is invalidated). */
  prepare(): Promise<Configuration> {
    if (this.#preparing === undefined) {
      const preparing = this.loadProject().then(async (project) => {
        await this.configure(project)
        return this.#configured()
      })
      this.#preparing = preparing
      preparing.catch(() => {
        if (this.#preparing === preparing) this.#preparing = undefined
      })
    }
    return this.#preparing
  }

  /** Discovers the project from the host root (re-resolving the options against it). */
  async loadProject(): Promise<Project> {
    this.options = resolveOptions(this.#userOptions, { root: this.host.root, env: process.env })
    const { config } = this.options
    return loadProject(this.options.cwd, {
      config: config.mode === 'file' ? config.path : config.mode === 'none' ? false : undefined,
      packageJson: !process.env.DENO_NO_PACKAGE_JSON,
      lockfile: this.options.lockfile,
    })
  }

  /** Derives platform, conditions, npm strategy, generation, mirror and filter from `project`. */
  async configure(project: Project): Promise<void> {
    for (const warning of project.warnings) this.logger.warn(`${warning.message} (${warning.file})`)
    for (const warning of project.importMap.warnings) this.logger.warn(warning)
    const foreign = foreignNodeModulesMessage(project.nodeModules)
    if (foreign !== undefined)
      this.warnOnce(`foreign-node-modules\0${project.nodeModules.dir}`, foreign)
    const host = this.host
    const platform = derivePlatform(this.options, host, project)
    const conditions = conditionsFor(platform, [
      ...(host.conditionsHint ?? []),
      ...this.options.conditions,
    ])
    const npmStrategy = npmStrategyFor(this.options.npm, project.nodeModules.mode)
    const cacheDir = this.options.cacheDir ?? defaultCacheDir(project.workspaceRoot)
    const projectGeneration = await configGeneration(project)
    const generation = mirrorGeneration(projectGeneration, PLUGIN_VERSION, platform, conditions)
    const denoDirs = denoDirVariants(resolveDenoDir())
    const jsrRegistries = [...new Set([DEFAULT_JSR_REGISTRY, jsrRegistryUrl()])]
    const allowImport = createImportAllowList({
      allowImport: this.options.allowImport,
      projectUrls: projectRemoteUrls(project),
      jsrRegistries,
    })
    const lockfilePolicy = new LockfilePolicy({
      decision: lockfileModeFor(this.options.lockfile, project, process.env),
      project,
      explain: this.options.checks.lockfile,
      logger: this.logger,
      jsrRegistries,
      denoDirs,
    })
    const jsrRoute = jsrRouteFor(project, npmStrategy)
    const mirror = this.#createMirror(
      { cacheDir, project, allowImport, lockfilePolicy, jsrRoute: jsrRoute.route },
      generation,
    )
    this.#configuration = {
      project,
      platform,
      conditions,
      npmStrategy,
      cacheDir,
      configGeneration: projectGeneration,
      generation,
      mirror,
      denoDirs,
      filter: resolveIdFilter(project, this.options, platform),
      allowImport,
      lockfilePolicy,
      jsrRoute,
      targets: new Map(),
      mirrors: new Map(),
    }
    const removed = await mirror.collectGarbage().catch((error: unknown) => {
      this.logger.debug(`[mirror] garbage collection failed: ${String(error)}`)
      return []
    })
    if (removed.length > 0)
      this.logger.debug(`[mirror] removed ${removed.length} old generation(s)`)
    await this.#logSummary()
  }

  #configured(): Configuration {
    if (this.#configuration === undefined) {
      throw new Error('unplugin-deno: the project is not loaded yet (buildStart has not run).')
    }
    return this.#configuration
  }

  /**
   * The mirror of `generation`, checking remote imports against the allow-list and the lockfile;
   * its engines are those of `target` (the build's when omitted).
   */
  #createMirror(
    parts: Pick<Configuration, 'cacheDir' | 'project' | 'allowImport' | 'lockfilePolicy'> & {
      jsrRoute: JsrRoute
    },
    generation: string,
    target?: EngineTarget,
  ): Mirror {
    const { allowImport, lockfilePolicy } = parts
    return createMirror({
      cacheDir: parts.cacheDir,
      generation,
      engine: () => this.engine('main', target),
      rawEngine: () => this.engine('raw', target),
      lockfile: parts.project.lockfile,
      logger: this.logger,
      checkRemote: (url, context) => allowImport.check(url, context),
      checkLockfile: (check, importer) => lockfilePolicy.check(check, importer),
      keepJsrSpecifiers: parts.jsrRoute === 'node_modules',
    })
  }

  get project(): Project {
    return this.#configured().project
  }

  get platform(): Platform {
    return this.#configured().platform
  }

  get conditions(): string[] {
    return this.#configured().conditions
  }

  get npmStrategy(): NpmStrategy {
    return this.#configured().npmStrategy
  }

  get mirror(): Mirror {
    return this.#configured().mirror
  }

  get denoDirs(): readonly string[] {
    return this.#configured().denoDirs
  }

  get cacheDir(): string {
    return this.#configured().cacheDir
  }

  get generation(): string {
    return this.#configured().generation
  }

  /** The remote-import allow-list (R15). */
  get allowImport(): ImportAllowList {
    return this.#configured().allowImport
  }

  /** How `deno.lock` is used (R5, X5). */
  get lockfilePolicy(): LockfilePolicy {
    return this.#configured().lockfilePolicy
  }

  /** Where `jsr:` packages come from (R11). */
  get jsrRoute(): JsrRoute {
    return this.#configured().jsrRoute.route
  }

  /** The JSR registries: `https://jsr.io/` (the loader's) and `JSR_URL` (the Deno CLI's). */
  get jsrRegistries(): readonly string[] {
    return [...new Set([DEFAULT_JSR_REGISTRY, jsrRegistryUrl()])]
  }

  /** Whether the project is loaded (after `prepare`). */
  get ready(): boolean {
    return this.#configuration !== undefined
  }

  /** Records an import kept external for `platform` (the sidecar deno.lock, S3). */
  recordExternal(platform: Platform, record: ExternalRecord): void {
    this.#externals.record(platform, record)
  }

  /** The imports kept external for `platform` so far (every build of this instance). */
  externals(platform: Platform): ExternalRecord[] {
    return this.#externals.list(platform)
  }

  /**
   * The command that downloads what the build needs into Deno's cache, for `cachedOnly` hints:
   * `deno cache <entries>` with the build's module inputs relative to `cwd`, or `deno install`.
   */
  cacheCommand(): string {
    const root = this.#configuration?.project.root ?? this.options.cwd
    const entries = normalizeEntries(this.#hints.input, root).map((entry) => {
      if (!entry.startsWith('file:')) return entry
      const path = relative(this.options.cwd, toPath(entry, this.flavor))
      return path.replaceAll('\\', '/')
    })
    return entries.length === 0 ? 'deno install' : `deno cache ${entries.join(' ')}`
  }

  // -- diagnostics ------------------------------------------------------------------------------

  /** Logs `message` as a warning, once per `key` for this plugin instance. */
  warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    this.logger.warn(message)
  }

  /** Records an npm package bundled for `platform` (X4); see {@link PluginState.reportDuplicates}. */
  recordNpmPackage(platform: Platform, name: string, version: string): void {
    if (this.options.checks.duplicates) this.#packages.record(platform, name, version)
  }

  /**
   * Warns about npm packages bundled in several versions for `platform` (every platform when
   * omitted) and forgets the records; hosts call it when a build ends.
   */
  reportDuplicates(platform?: Platform): void {
    for (const message of this.#packages.take(platform)) this.logger.warn(message)
  }

  /**
   * The JSX transform the host should apply to local files (§5.11), or `null` to leave the host's
   * settings alone; warns once for `jsx: "precompile"`. The project must be loaded. `host` names
   * the host in the warning.
   */
  jsxTransform(host: string): JsxDecision | null {
    const decision = jsxTransformFor(this.project, this.options)
    if (decision?.precompile === true && decision.transform.runtime === 'automatic') {
      this.warnOnce('jsx-precompile', precompileWarning(host, decision.transform.importSource))
    }
    return decision
  }

  /** The environment variables to inline, or `null` when `env` is off (§5.10). */
  envInlining(): Promise<EnvInlining> | null {
    const configuration = this.#configured()
    const { env } = this.options
    if (env === false) return null
    configuration.env ??= loadEnv(env, this.options.cwd, process.env, this.logger)
    return configuration.env
  }

  /**
   * The `resolveId` filter (§5.2): precise once the project is loaded, otherwise (and when
   * `broad`) owned schemes, markers and every bare specifier.
   */
  resolveIdFilter(broad = false): RegExp {
    return broad || this.#configuration === undefined
      ? BROAD_RESOLVE_ID_FILTER
      : this.#configuration.filter
  }

  /**
   * The `load` filter: mirror files (first), marker ids, the plugin's own virtual ids and, with
   * the `wasm` option, `.wasm` modules (§5.12).
   */
  loadFilter(): RegExp[] {
    const cacheDir = this.#configuration?.cacheDir ?? this.options.cacheDir
    const mirror =
      cacheDir === null
        ? /[\\/]node_modules[\\/]\.unplugin-deno[\\/]/
        : pathPrefixFilter(cacheDir, this.flavor)
    const filters = [mirror, DENO_TYPE_ID_FILTER, DENO_VIRTUAL_ID_FILTER]
    return this.options.wasm ? [...filters, WASM_MODULE_ID_FILTER] : filters
  }

  // -- engines ----------------------------------------------------------------------------------

  /**
   * The engine for the build's platform and conditions, or for `target` (created on first use).
   * `raw` is a second engine that only loads raw assets the main engine refuses (see
   * `MirrorOptions`).
   */
  engine(purpose: 'main' | 'raw' = 'main', target?: EngineTarget): Promise<Engine> {
    const configuration = this.#configured()
    const { project } = configuration
    const platform = target?.platform ?? configuration.platform
    const conditions = target?.conditions ?? configuration.conditions
    const enginePlatform = enginePlatformFor(platform)
    const key = `${purpose}\0${enginePlatform}\0${conditions.join(',')}`
    let engine = this.#engines.get(key)
    if (engine === undefined) {
      engine = this.#engineSelection(project).then((selection) =>
        createEngine(selection.kind, {
          project: {
            root: project.root,
            workspaceRoot: project.workspaceRoot,
            configPath: project.configPath ?? undefined,
            // Only an existing (v5) lockfile; the engine writes none (§3.4, §4.4).
            lockfilePath:
              project.lockfile === null ? undefined : (project.lockfilePath ?? undefined),
            nodeModulesDir: project.nodeModules.mode,
          },
          platform: enginePlatform,
          conditions: [...conditions],
          cachedOnly: this.options.cachedOnly,
          ...(project.minimumDependencyAge.newestDependencyDate === null
            ? {}
            : { newestDependencyDate: project.minimumDependencyAge.newestDependencyDate }),
          logger: this.logger,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
          denoBinary: this.options.denoBinary,
        }),
      )
      this.#engines.set(key, engine)
      const created = engine
      created.catch(() => {
        if (this.#engines.get(key) === created) this.#engines.delete(key)
      })
    }
    return engine
  }

  /**
   * Which engine implements the project (§4.3): the loader unless `engine: 'deno'`, or `'auto'`
   * with a project that uses a feature the vendored loader lacks and a usable Deno on `PATH`. The
   * reason goes to the debug log; a fallback to the loader despite such a feature is a warning.
   */
  #engineSelection(project: Project): Promise<EngineSelection> {
    this.#selection ??= selectEngineKind({
      engine: this.options.engine,
      project,
      denoBinary: this.options.denoBinary,
    }).then((selection) => {
      this.logger.debug(`[engine] ${selection.kind}: ${selection.reason}`)
      if (selection.warning !== undefined) this.logger.warn(selection.warning)
      return selection
    })
    return this.#selection
  }

  /** Disposes every engine; the next resolution creates new ones. */
  async disposeEngines(): Promise<void> {
    this.#selection = undefined
    const engines = [...this.#engines.values()]
    this.#engines.clear()
    await Promise.allSettled(engines.map(async (engine) => (await engine).dispose()))
  }

  /**
   * Seeds the engine with the build inputs (downloads, npm installs for `nodeModulesDir: "auto"`).
   * Diagnostics with a code (e.g. `CACHED_ONLY_MISS`) are warnings; the others are debug output,
   * because the graph also holds imports the host owns (`?raw`, `node_modules` packages, other
   * plugins' virtual modules) that Deno reports as errors. Failing owned imports fail in
   * `resolveId` with their importer. With a `target`, the engine of that target is seeded; with
   * an `input`, that input instead of the build's (hosts that meet entries while resolving).
   */
  async addEntrypoints(target?: ResolveTarget, input?: HostInput): Promise<void> {
    const { project } = this.#configured()
    const entries = normalizeEntries(input ?? this.#hints.input, project.root)
    if (entries.length === 0) return
    const started = performance.now()
    const engine = await this.engine('main', target && this.#engineTarget(target))
    const diagnostics = await engine.addEntrypoints(entries)
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === undefined) this.logger.debug(`[engine] ${diagnostic.message}`)
      else this.logger.warn(`${diagnostic.message} (${diagnostic.code})`)
    }
    this.logger.debug(
      `[core] added ${entries.length} entrypoint(s) in ${Math.round(performance.now() - started)} ms`,
    )
  }

  // -- hooks --------------------------------------------------------------------------------------

  /**
   * `resolveId` for the owned id `rawId` (§5.2), for the build's platform or for
   * `request.target`.
   */
  async resolve(
    rawId: string,
    importer: string | undefined,
    request: ResolveRequest = {},
  ): Promise<ResolveOutcome> {
    if (isForeignId(rawId)) return null
    await this.prepare()
    const resolver =
      request.target === undefined ? this.resolver : this.#targetResolver(request.target)
    return resolver.resolveOwned(rawId, importer, request)
  }

  /** The platform and engine conditions of `target` (§5.6). */
  #engineTarget(target: ResolveTarget): EngineTarget {
    const hostConditions = target.conditions ?? this.#hints.conditions ?? []
    return {
      platform: target.platform,
      conditions: conditionsFor(target.platform, [...hostConditions, ...this.options.conditions]),
    }
  }

  /**
   * The resolver of `target`: the build's own when the target changes nothing, otherwise one
   * that reads the target's platform, engine, mirror generation and `bundle` patterns. The
   * mirror of a generation is shared by the targets that have it.
   */
  #targetResolver(target: ResolveTarget): Resolver {
    const configuration = this.#configured()
    const engineTarget = this.#engineTarget(target)
    const { platform, conditions } = engineTarget
    const bundle = target.bundle ?? []
    const sameConditions =
      conditions.length === configuration.conditions.length &&
      conditions.every((condition, index) => condition === configuration.conditions[index])
    if (platform === configuration.platform && sameConditions && bundle.length === 0) {
      return this.resolver
    }
    const key = JSON.stringify([platform, conditions, bundle.map(String)])
    let resolver = configuration.targets.get(key)
    if (resolver === undefined) {
      const options =
        bundle.length === 0
          ? this.options
          : { ...this.options, bundle: [...this.options.bundle, ...bundle] }
      resolver = createResolver({
        options,
        project: configuration.project,
        platform,
        npmStrategy: configuration.npmStrategy,
        denoDirs: configuration.denoDirs,
        mirror: this.#mirrorFor(configuration, engineTarget),
        logger: this.logger,
        framework: this.framework,
        flavor: this.flavor,
        engine: () => this.engine('main', engineTarget),
        warnOnce: (warning, message) => this.warnOnce(warning, message),
        recordNpmPackage: (packagePlatform, name, version) =>
          this.recordNpmPackage(packagePlatform, name, version),
        allowImport: configuration.allowImport,
        lockfilePolicy: configuration.lockfilePolicy,
        jsrRoute: configuration.jsrRoute.route,
        recordExternal: (externalPlatform, record) => this.recordExternal(externalPlatform, record),
        cacheCommand: () => this.cacheCommand(),
      })
      configuration.targets.set(key, resolver)
    }
    return resolver
  }

  /** The mirror of `target`'s generation (the build's own mirror when the generation is its). */
  #mirrorFor(configuration: Configuration, target: EngineTarget): Mirror {
    const generation = mirrorGeneration(
      configuration.configGeneration,
      PLUGIN_VERSION,
      target.platform,
      target.conditions,
    )
    if (generation === configuration.generation) return configuration.mirror
    let mirror = configuration.mirrors.get(generation)
    if (mirror === undefined) {
      mirror = this.#createMirror(
        { ...configuration, jsrRoute: configuration.jsrRoute.route },
        generation,
        target,
      )
      configuration.mirrors.set(generation, mirror)
    }
    return mirror
  }

  /**
   * `load` for marker ids (synthesised modules), `.wasm` modules (synthesised, §5.12), mirror code
   * files (code and source map) and the empty module; `null` for everything else (the host loads
   * assets and local files).
   */
  async load(id: string): Promise<LoadResult | null> {
    if (isDenoVirtualId(id)) {
      return id === EMPTY_MODULE_ID ? { code: 'export default {};\n', moduleType: 'js' } : null
    }
    if (isVirtualId(id)) return null
    const { mirror } = await this.prepare()
    const marker = readDenoType(id)
    if (marker !== null) {
      const path = splitQuery(marker.base).base
      const bytes = await readFile(path).catch((error: unknown) => {
        throw new DenoPluginError(
          'RESOLVE_NOT_FOUND',
          `Cannot read ${path} for a \`with { type: "${marker.type}" }\` import.`,
          { hint: 'Check that the imported file exists.', specifier: id, cause: error },
        )
      })
      const url = (await mirror.urlForMirrorPath(path)) ?? toFileUrl(path, this.flavor)
      return synthesizeMarkerModule(marker.type, bytes, url)
    }
    if (this.options.wasm && isWasmModuleId(id)) {
      const bytes = await readFile(id).catch((error: unknown) => {
        throw new DenoPluginError('RESOLVE_NOT_FOUND', `Cannot read the Wasm module ${id}.`, {
          hint: 'Check that the imported file exists.',
          specifier: id,
          cause: error,
        })
      })
      return synthesizeWasmModule(bytes, id, this.flavor)
    }
    if (!mirror.isMirrorPath(id)) return null
    const module = await mirror.readModule(id)
    if (module === null) return null
    const map = module.map === null ? null : hostMirrorMap(module.map, id, this.flavor)
    return { code: module.code, map: toHostSourceMap(map), moduleType: 'js' }
  }

  /**
   * The `transform` hook: the import-attribute pre-pass (§5.5; not for mirror files, which were
   * rewritten when mirrored, nor on hosts that pass attributes to `resolveId`), then the source
   * transforms and checks of §5.10: `import.meta.main` → `false` outside entries, environment
   * variables inlined (browser platform, or `env.server`; local and mirror files), and `Deno.*`
   * references in local files of browser bundles reported once per file (an error with
   * `denoGlobals: 'error'`). npm package files are left alone except for `import.meta.main`.
   *
   * @throws {DenoPluginError} `PLATFORM_INCOMPATIBLE` for `Deno.*` with `denoGlobals: 'error'`.
   */
  async transform(
    code: string,
    id: string,
    context: TransformContext = {},
  ): Promise<LoadResult | null> {
    if (isVirtualId(id) || isForeignId(id)) return null
    const configuration = await this.prepare()
    const path = splitQuery(id).base
    const kind = this.#moduleKind(configuration, path)
    const { options } = this
    const magic = new MagicString(code)
    let changed = false
    if (options.importAttributes && !this.nativeAttributes && kind !== 'mirror') {
      changed = applyImportAttributes(magic, code, id, context.parse)
    }
    const platform = context.platform ?? configuration.platform
    // The source transforms read JavaScript and TypeScript only (not CSS, HTML or SFC templates).
    const script = isScriptModuleId(id)
    const replaceMain =
      script &&
      options.importMetaMain &&
      context.importMetaMain !== false &&
      code.includes('import.meta.main')
    const inlineEnv =
      script &&
      kind !== 'package' &&
      inlinesEnv(options, platform) &&
      /Deno\.env|process\.env/.test(code)
    const denoGlobals =
      script && kind === 'local' && platform === 'browser'
        ? denoGlobalsFor(options, platform)
        : 'off'
    const checkDeno = denoGlobals !== 'off' && code.includes('Deno')
    if (replaceMain || inlineEnv || checkDeno) {
      const scan = scanSource(code, id, context.parse)
      const env = inlineEnv ? await this.envInlining() : null
      const applied = applySourceTransforms(magic, scan, {
        importMetaMain:
          replaceMain && scan.importMetaMain.length > 0 && context.isEntry?.() !== true,
        envValue: env === null ? undefined : (key) => env.value(key),
      })
      changed = applied.changed || changed
      if (checkDeno && applied.denoReferences.length > 0) {
        this.#reportDenoGlobals(path, code, applied.denoReferences, denoGlobals)
      }
    }
    if (!changed) return null
    const map = magic.generateMap({ source: id, hires: 'boundary', includeContent: true })
    return { code: magic.toString(), map: toHostSourceMap({ ...map, version: 3 }) }
  }

  /** What a module is for the source transforms: a mirror file, an npm package file or local. */
  #moduleKind(configuration: Configuration, path: string): 'mirror' | 'package' | 'local' {
    if (configuration.mirror.isMirrorPath(path)) return 'mirror'
    if (
      isNodeModulesPath(path, this.flavor) ||
      isGlobalCachePath(path, configuration.denoDirs, this.flavor)
    ) {
      return 'package'
    }
    return 'local'
  }

  /** Reports `Deno.*` references in a local module of a browser bundle (L10). */
  #reportDenoGlobals(
    path: string,
    code: string,
    references: readonly DenoReference[],
    mode: 'warn' | 'error',
  ): void {
    const message = denoGlobalsMessage(displayModule(path, this.options.cwd), code, references)
    if (mode === 'error') {
      throw new DenoPluginError('PLATFORM_INCOMPATIBLE', message, { specifier: path })
    }
    this.warnOnce(`deno-globals\0${path}`, message)
  }

  /** The files the host should watch. */
  watchFiles(): string[] {
    return this.#configuration === undefined ? [] : watchFiles(this.#configuration.project)
  }

  /** Reloads the project when `id` is one of its config files or the lockfile (§5.7). */
  async watchChange(id: string): Promise<boolean> {
    const configuration = this.#configuration
    if (configuration === undefined || !isWatchedFile(configuration.project, id, this.flavor)) {
      return false
    }
    const reloading = invalidateProject(this, id).then(() => this.#configured())
    this.#preparing = reloading
    await reloading
    return true
  }

  /** Persists the mirror manifests (the build's and those of other targets). */
  async flush(): Promise<void> {
    const configuration = this.#configuration
    if (configuration === undefined) return
    await Promise.all(
      [configuration.mirror, ...configuration.mirrors.values()].map((mirror) => mirror.flush()),
    )
  }

  /** Flushes the manifest and disposes the engines (end of a non-watch build). */
  async close(): Promise<void> {
    await this.flush()
    await this.disposeEngines()
  }

  async #logSummary(): Promise<void> {
    if (!this.logger.debugEnabled) return
    const configuration = this.#configured()
    const { project } = configuration
    const engine =
      this.options.engine === 'deno'
        ? 'deno (CLI)'
        : `loader (@deno/loader ${(await vendoredLoaderVersion()) ?? 'unknown'})`
    const host = `${this.framework}${this.#hints.version === undefined ? '' : ` ${this.#hints.version}`}`
    const lines = [
      `unplugin-deno ${PLUGIN_VERSION} on ${host}, engine ${engine}`,
      `config ${project.configPath ?? 'none'}, workspace root ${project.workspaceRoot} (${project.members.length} member(s), ${project.links.length} link(s))`,
      configuration.lockfilePolicy.describe(),
      `nodeModulesDir ${project.nodeModules.mode} (layout ${project.nodeModules.layout ?? 'none'}), npm ${configuration.npmStrategy}`,
      `jsr: packages ${configuration.jsrRoute.route === 'node_modules' ? 'from node_modules/@jsr (npm:@jsr/<scope>__<name>)' : 'mirrored from the JSR registry'} (${configuration.jsrRoute.reason})`,
      `platform ${configuration.platform}, conditions [${configuration.conditions.join(', ')}]`,
      configuration.allowImport.describe(),
      `cacheDir ${configuration.cacheDir}, generation ${configuration.generation}`,
    ]
    for (const line of lines) this.logger.debug(`[core] ${line}`)
  }
}
