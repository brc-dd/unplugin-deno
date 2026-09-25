/**
 * The state of one plugin instance across a build (docs/architecture.md §5): resolved options, the
 * project, the platform, the engines (one per engine platform and conditions, created lazily), the
 * mirror and the resolver. Host adapters feed it host facts (`setHints`, `setLogTarget`) and call
 * its hook implementations.
 *
 * @module
 */
import { readFile } from 'node:fs/promises'
import type { UnpluginContextMeta } from 'unplugin'
import type { Project } from '../config/project.js'
import { configGeneration, loadProject } from '../config/project.js'
import { DenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import { resolveDenoDir } from '../engine/deno-dir.js'
import { createEngine } from '../engine/create.js'
import type { EncodedSourceMap, Engine } from '../engine/types.js'
import type { HostContext, HostLogTarget } from '../hosts/shared.js'
import { createHostLogger } from '../hosts/shared.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR, toFileUrl } from '../utils/path.js'
import { vendoredLoaderVersion } from '../vendored-deno-loader.js'
import type { AstParser, MarkerModule } from './attributes.js'
import { synthesizeMarkerModule, transformImportAttributes } from './attributes.js'
import type { HostInput } from './entries.js'
import { normalizeEntries } from './entries.js'
import {
  DENO_TYPE_ID_FILTER,
  DENO_VIRTUAL_ID_FILTER,
  EMPTY_MODULE_ID,
  isDenoVirtualId,
  isForeignId,
  isVirtualId,
  pathPrefixFilter,
  readDenoType,
  splitQuery,
} from './id.js'
import type { Mirror } from './mirror.js'
import { createMirror, mirrorGeneration } from './mirror.js'
import type { NpmStrategy } from './npm.js'
import { denoDirVariants, npmStrategyFor } from './npm.js'
import type { Platform, ResolvedOptions } from './options.js'
import { defaultCacheDir, resolveOptions } from './options.js'
import type { Options } from './options.js'
import type { PlatformHint } from './platform.js'
import { conditionsFor, derivePlatform, enginePlatformFor } from './platform.js'
import type { ResolveOutcome, Resolver, ResolveRequest, ResolverState } from './resolve.js'
import { BROAD_RESOLVE_ID_FILTER, createResolver, resolveIdFilter } from './resolve.js'
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
  generation: string
  mirror: Mirror
  denoDirs: string[]
  filter: RegExp
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
   * Set by adapters whose host resolves every import with its attributes (esbuild's `args.with`,
   * next phase): the transform pre-pass is then not needed (§5.5). Rollup does not set it: it
   * resolves each specifier once per module whatever its attributes (§5.9).
   */
  nativeAttributes = false
  readonly #userOptions: Options | undefined
  #hints: StateHints = {}
  #logTarget: HostLogTarget | undefined
  #configuration: Configuration | undefined
  #preparing: Promise<Configuration> | undefined
  readonly #engines = new Map<string, Promise<Engine>>()

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
    const host = this.host
    const platform = derivePlatform(this.options, host, project)
    const conditions = conditionsFor(platform, [
      ...(host.conditionsHint ?? []),
      ...this.options.conditions,
    ])
    const npmStrategy = npmStrategyFor(this.options.npm, project.nodeModules.mode)
    const cacheDir = this.options.cacheDir ?? defaultCacheDir(project.workspaceRoot)
    const generation = mirrorGeneration(
      await configGeneration(project),
      PLUGIN_VERSION,
      platform,
      conditions,
    )
    const mirror = createMirror({
      cacheDir,
      generation,
      engine: () => this.engine(),
      rawEngine: () => this.engine('raw'),
      lockfile: project.lockfile,
      logger: this.logger,
    })
    this.#configuration = {
      project,
      platform,
      conditions,
      npmStrategy,
      cacheDir,
      generation,
      mirror,
      denoDirs: denoDirVariants(resolveDenoDir()),
      filter: resolveIdFilter(project, this.options, platform),
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

  /** Whether the project is loaded (after `prepare`). */
  get ready(): boolean {
    return this.#configuration !== undefined
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

  /** The `load` filter: mirror files, marker ids and the plugin's own virtual ids. */
  loadFilter(): RegExp[] {
    const cacheDir = this.#configuration?.cacheDir ?? this.options.cacheDir
    const mirror =
      cacheDir === null
        ? /[\\/]node_modules[\\/]\.unplugin-deno[\\/]/
        : pathPrefixFilter(cacheDir, this.flavor)
    return [mirror, DENO_TYPE_ID_FILTER, DENO_VIRTUAL_ID_FILTER]
  }

  // -- engines ----------------------------------------------------------------------------------

  /**
   * The engine for the build's platform and conditions (created on first use). `raw` is a
   * second engine that only loads raw assets the main engine refuses (see `MirrorOptions`).
   */
  engine(purpose: 'main' | 'raw' = 'main'): Promise<Engine> {
    const { project, platform, conditions } = this.#configured()
    const enginePlatform = enginePlatformFor(platform)
    const key = `${purpose}\0${enginePlatform}\0${conditions.join(',')}`
    let engine = this.#engines.get(key)
    if (engine === undefined) {
      engine = createEngine(this.options.engine === 'deno' ? 'deno' : 'loader', {
        project: {
          root: project.root,
          workspaceRoot: project.workspaceRoot,
          configPath: project.configPath ?? undefined,
          // Only an existing (v5) lockfile; the engine writes none (§3.4, §4.4).
          lockfilePath: project.lockfile === null ? undefined : (project.lockfilePath ?? undefined),
          nodeModulesDir: project.nodeModules.mode,
        },
        platform: enginePlatform,
        conditions,
        cachedOnly: this.options.cachedOnly,
        ...(project.minimumDependencyAge.newestDependencyDate === null
          ? {}
          : { newestDependencyDate: project.minimumDependencyAge.newestDependencyDate }),
        logger: this.logger,
      })
      this.#engines.set(key, engine)
      const created = engine
      created.catch(() => {
        if (this.#engines.get(key) === created) this.#engines.delete(key)
      })
    }
    return engine
  }

  /** Disposes every engine; the next resolution creates new ones. */
  async disposeEngines(): Promise<void> {
    const engines = [...this.#engines.values()]
    this.#engines.clear()
    await Promise.allSettled(engines.map(async (engine) => (await engine).dispose()))
  }

  /**
   * Seeds the engine with the build inputs (downloads, npm installs for `nodeModulesDir: "auto"`).
   * Diagnostics with a code (e.g. `CACHED_ONLY_MISS`) are warnings; the others are debug output,
   * because the graph also holds imports the host owns (`?raw`, `node_modules` packages, other
   * plugins' virtual modules) that Deno reports as errors. Failing owned imports fail in
   * `resolveId` with their importer.
   */
  async addEntrypoints(): Promise<void> {
    const { project } = this.#configured()
    const entries = normalizeEntries(this.#hints.input, project.root)
    if (entries.length === 0) return
    const started = performance.now()
    const engine = await this.engine()
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

  /** `resolveId` for the owned id `rawId` (§5.2). */
  async resolve(
    rawId: string,
    importer: string | undefined,
    request: ResolveRequest = {},
  ): Promise<ResolveOutcome> {
    if (isForeignId(rawId)) return null
    await this.prepare()
    return this.resolver.resolveOwned(rawId, importer, request)
  }

  /**
   * `load` for marker ids (synthesised modules), mirror code files (code and source map) and the
   * empty module; `null` for everything else (the host loads assets and local files).
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
    if (!mirror.isMirrorPath(id)) return null
    const module = await mirror.readModule(id)
    return module === null
      ? null
      : { code: module.code, map: toHostSourceMap(module.map), moduleType: 'js' }
  }

  /** The import-attribute pre-pass (§5.5), unless the host passes attributes to `resolveId`. */
  async transform(code: string, id: string, parse?: AstParser): Promise<LoadResult | null> {
    if (!this.options.importAttributes || this.nativeAttributes) return null
    if (isVirtualId(id) || isForeignId(id)) return null
    const { mirror } = await this.prepare()
    if (mirror.isMirrorPath(id)) return null
    const result = transformImportAttributes(code, id, parse)
    return result === null ? null : { code: result.code, map: toHostSourceMap(result.map) }
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

  /** Persists the mirror manifest. */
  async flush(): Promise<void> {
    await this.#configuration?.mirror.flush()
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
      `lockfile ${project.lockfile === null ? 'none' : project.lockfile.path}`,
      `nodeModulesDir ${project.nodeModules.mode} (layout ${project.nodeModules.layout ?? 'none'}), npm ${configuration.npmStrategy}`,
      `platform ${configuration.platform}, conditions [${configuration.conditions.join(', ')}]`,
      `cacheDir ${configuration.cacheDir}, generation ${configuration.generation}`,
    ]
    for (const line of lines) this.logger.debug(`[core] ${line}`)
  }
}
