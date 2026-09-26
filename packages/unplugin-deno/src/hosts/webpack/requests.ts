/**
 * Request handling shared by the webpack-family adapters (webpack, Rspack and Rsbuild;
 * docs/architecture.md §6.5, §6.6). Both hosts decide externals (in `factorize`) before they
 * resolve, only their `beforeResolve` hook sees import attributes and only their externals
 * function sees the dependency type. So a {@link Router}:
 *
 * 1. notes the attribute type of every request in `beforeResolve` ({@link Router.note});
 * 2. resolves the requests the plugin owns in the adapter's externals function, which runs before
 *    the host's other externals (`externalsPresets`, `externals`), once per attribute type, and
 *    turns external outcomes into native externals ({@link Router.external});
 * 3. applies the other outcomes in the host's `resolve` hook by rewriting the request (and, for npm
 *    redirects, the context), so the host resolves real files itself ({@link Router.apply}).
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { SourceMapInput } from '@jridgewell/remapping'
import remapping from '@jridgewell/remapping'
import { isDenoType } from '../../core/attributes.js'
import type { DenoType } from '../../core/id.js'
import { isOwnedSpecifier, splitQuery, withDenoType } from '../../core/id.js'
import type { Platform } from '../../core/options.js'
import type { PlatformHint } from '../../core/platform.js'
import type { ResolveOutcome, ResolveTarget } from '../../core/resolve.js'
import { resolveIdFilter } from '../../core/resolve.js'
import { parseSpecifier } from '../../core/specifier.js'
import type { HostSourceMap, PluginState } from '../../core/state.js'
import { isDenoPluginError } from '../../diagnostics/errors.js'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR } from '../../utils/path.js'
import type { HostLogTarget } from '../shared.js'
import { unpluginLoaderPath } from './unplugin-loaders.js'
import type { ExternalResult, ExternalType, TakenPreset } from './presets.js'
import { presetExternal } from './presets.js'

/** The name the adapters tap host hooks and log under (the plugin's name). */
export const TAP_NAME = 'unplugin-deno'

/** The attribute type of an import that becomes a `?deno-type=` marker, or `''` for none. */
export type MarkerType = DenoType | ''

/** Where a request comes from: the fields webpack and Rspack pass to every hook. */
export interface RequestInfo {
  /** The request as written (`resolveData.request`, the externals function's `request`). */
  request: string
  /** The directory the request is resolved from. */
  context: string
  /** The importing module (`contextInfo.issuer`); `''` for entries. */
  issuer: string
}

/** A request the host resolves: webpack's `ResolveData` and Rspack's `JsResolveData` (mutable). */
export interface MutableRequest {
  request: string
  context: string
}

/** What {@link Router.apply} needs from the host. */
export interface RouterHost {
  /**
   * Resolves `request` from `context` with the host's resolver; `false` when the host ignores the
   * request (`resolve.alias` to `false`). Rejects when it cannot be resolved.
   */
  resolve(context: string, request: string): Promise<string | false>
  /** The request of the module the plugin synthesises for `id` (a marker or virtual id). */
  synthetic(id: string): Promise<string>
  /**
   * Adds `files` to the dependencies of the resolution (`resolveData.fileDependencies`, or
   * `missingDependencies` for those that do not exist).
   */
  dependOn(files: readonly string[]): void
}

/** Settings of a {@link Router} that are known once the host applied its defaults. */
export interface RouterSettings {
  /** The host's `externalsPresets` the adapter turned off and applies itself (after the plugin). */
  presets: readonly TakenPreset[]
  /** `experiments.buildHttp`: the `http(s):` URLs webpack fetches itself. */
  buildHttp: ((url: string) => boolean) | undefined
  /** `output.module`: externals are ES module imports. */
  outputModule: boolean
}

/** Dependency types whose requests are URLs, not modules (CSS `url()`, `new URL()`, HTML). */
const NON_MODULE_DEPENDENCY = /^(?:url|css|html|asset)/

/**
 * Routes the requests of one compiler (see the module documentation). `target` is the resolve
 * target of an Rsbuild environment; without it the build's own platform applies.
 */
export class Router {
  readonly state: PluginState
  /** The host, for debug output (`[webpack]`, `[rspack]`). */
  readonly host: 'webpack' | 'rspack'
  readonly target: ResolveTarget | undefined
  settings: RouterSettings = { presets: [], buildHttp: undefined, outputModule: false }
  /**
   * The modules that import requests the plugin owns (kept across compilations): after a config
   * reload, hosts that keep the module graph between rebuilds (Rspack) rebuild them, so their
   * imports resolve with the reloaded project.
   */
  readonly importers = new Set<string>()
  readonly #types = new Map<string, Set<MarkerType>>()
  readonly #outcomes = new Map<string, Promise<ResolveOutcome>>()
  #filter: { project: unknown; filter: RegExp } | undefined

  constructor(state: PluginState, host: 'webpack' | 'rspack', target?: ResolveTarget) {
    this.state = state
    this.host = host
    this.target = target
  }

  /** Forgets the resolutions of the last compilation (outcomes depend on the loaded project). */
  clear(): void {
    this.#types.clear()
    this.#outcomes.clear()
  }

  /** `beforeResolve`: remembers the attribute type of `info.request` for {@link external}. */
  note(info: RequestInfo, attributes: Readonly<Record<string, string>> | undefined): void {
    const type = this.markerType(attributes)
    // Requests the plugin cannot own need no entry (the project is loaded in `beforeCompile`).
    if (this.state.ready && !this.#matches(info.request, type)) return
    const key = requestKey(info)
    let types = this.#types.get(key)
    if (types === undefined) {
      types = new Set()
      this.#types.set(key, types)
    }
    types.add(type)
  }

  /** The marker type of an import with `attributes` (`''` without `importAttributes`). */
  markerType(attributes: Readonly<Record<string, string>> | undefined): MarkerType {
    const type = attributes?.type
    return this.state.options.importAttributes && isDenoType(type) ? type : ''
  }

  /**
   * The externals function (it runs before the host's other externals): resolves an owned
   * request once per attribute type seen in `beforeResolve` and returns the native external for
   * external outcomes; for requests the plugin does not own, what the presets the adapter took
   * over would have returned. Rejects with the host error of a failing owned import.
   */
  async external(info: RequestInfo, dependencyType: string): Promise<ExternalResult | undefined> {
    const types = this.#types.get(requestKey(info)) ?? new Set<MarkerType>([''])
    const owned = [...types].filter((type) => this.#owns(info.request, type, dependencyType))
    const importer = issuerPath(info.issuer)
    if (owned.length > 0 && importer !== undefined) this.importers.add(importer)
    const outcomes = await Promise.all(
      owned.map((type) => this.#resolve(info, type, dependencyType).catch(rethrowForHost)),
    )
    for (const outcome of outcomes) {
      if (outcome?.type === 'external') {
        return { request: outcome.id, type: this.externalType(dependencyType) }
      }
    }
    // What the plugin leaves to the host gets the host presets the adapter took over.
    if (outcomes.every((outcome) => outcome === null)) {
      return presetExternal(this.settings.presets, info.request, dependencyType)
    }
    return undefined
  }

  /**
   * The `resolve` hook: applies the outcome the externals function resolved for `data` (an
   * import with `attributes`), rewriting the request the host goes on to resolve.
   * `dependencyType` tells `require()` calls from imports (webpack; Rspack's `resolve` hook does
   * not say, and an import's outcome is taken first).
   */
  async apply(
    data: MutableRequest,
    issuer: string,
    attributes: Readonly<Record<string, string>> | undefined,
    host: RouterHost,
    dependencyType?: string,
  ): Promise<void> {
    const key = `${requestKey({ request: data.request, context: data.context, issuer })}\n${this.markerType(attributes)}`
    const pending =
      dependencyType === undefined
        ? (this.#outcomes.get(`${key}\nimport`) ?? this.#outcomes.get(`${key}\nrequire`))
        : this.#outcomes.get(`${key}\n${modeOf(dependencyType)}`)
    if (pending === undefined) return
    try {
      const outcome = await pending
      if (outcome === null) return
      await applyOutcome(outcome, data, host, (message) =>
        this.state.logger.debug(`[${this.host}] ${message}`),
      )
      // The resolution depends on the config files: hosts that keep the module graph between
      // rebuilds (Rspack) resolve the import again when one changes.
      host.dependOn(this.state.watchFiles())
    } catch (error) {
      rethrowForHost(error)
    }
  }

  /**
   * The external type of an external the plugin keeps (§5.6): `require()` calls stay `require`
   * (`createRequire` in ES module output), imports become `import` statements in ES module output
   * (`output.module`), `import()` for browser scripts, `require` for other script output.
   */
  externalType(dependencyType: string): ExternalType {
    if (dependencyType === 'commonjs') return 'node-commonjs'
    if (this.settings.outputModule) return 'module-import'
    return this.platform === 'browser' ? 'import' : 'node-commonjs'
  }

  /** The platform requests are resolved for. */
  get platform(): Platform {
    return this.target?.platform ?? this.state.platform
  }

  /** The `resolveId` filter of the router's platform (§5.2). */
  filter(): RegExp {
    const { state } = this
    if (this.target === undefined) return state.resolveIdFilter()
    const cached = this.#filter
    if (cached !== undefined && cached.project === state.project) return cached.filter
    const filter = resolveIdFilter(state.project, state.options, this.target.platform)
    this.#filter = { project: state.project, filter }
    return filter
  }

  #owns(request: string, type: MarkerType, dependencyType: string): boolean {
    if (NON_MODULE_DEPENDENCY.test(dependencyType)) return false
    if (this.settings.buildHttp !== undefined && isRemoteUrl(request)) {
      if (this.settings.buildHttp(request)) return false
    }
    return this.#matches(request, type)
  }

  /** Whether `request` (with the marker of `type`) matches the `resolveId` filter (§5.2). */
  #matches(request: string, type: MarkerType): boolean {
    return isOwnedSpecifier(type === '' ? request : withDenoType(request, type), this.filter())
  }

  #resolve(info: RequestInfo, type: MarkerType, dependencyType: string): Promise<ResolveOutcome> {
    const mode = modeOf(dependencyType)
    const key = `${requestKey(info)}\n${type}\n${mode}`
    let outcome = this.#outcomes.get(key)
    if (outcome === undefined) {
      const id = type === '' ? info.request : withDenoType(info.request, type)
      const importer = issuerPath(info.issuer)
      outcome = this.state.resolve(id, importer, {
        kind: mode === 'require' ? 'require-call' : 'import-statement',
        isEntry: importer === undefined,
        target: this.target,
      })
      this.#outcomes.set(key, outcome)
    }
    return outcome
  }
}

function requestKey(info: RequestInfo): string {
  return `${info.issuer}\n${info.context}\n${info.request}`
}

/** How a dependency loads its module: `require()` (CommonJS) or an import. */
function modeOf(dependencyType: string): 'require' | 'import' {
  return dependencyType === 'commonjs' ? 'require' : 'import'
}

function isRemoteUrl(request: string): boolean {
  const { kind } = parseSpecifier(request)
  return kind === 'https' || kind === 'http'
}

/**
 * Applies an outcome (§5.2) to the request the host resolves next:
 *
 * - `path`/`mirror` → the file's absolute path (the host loads local, npm and mirror files itself);
 * - `npm-redirect` → `name + subpath` resolved from the package directory (§5.4), so the host
 *   applies `exports` conditions, `browser` and `sideEffects`; the engine's file when the host
 *   cannot resolve it;
 * - `host-marker` → the host's resolution of the request, as a synthesised marker module;
 * - `marker`/`virtual` → a synthesised module;
 * - `external` → nothing (the externals function kept it external).
 *
 * `debug` receives the debug lines (the redirects that fall back to the engine's file).
 */
export async function applyOutcome(
  outcome: ResolveOutcome,
  data: MutableRequest,
  host: RouterHost,
  debug: (message: string) => void = () => {},
): Promise<void> {
  if (outcome === null) return
  switch (outcome.type) {
    case 'path':
    case 'mirror':
      data.request = requestPath(outcome.path)
      return
    case 'npm-redirect': {
      const resolved = await host.resolve(outcome.resolveDir, outcome.request).catch(() => false)
      if (resolved === false) {
        debug(
          `${outcome.request} does not resolve from ${outcome.resolveDir}; using ${outcome.fallbackPath}`,
        )
        data.request = requestPath(`${outcome.fallbackPath}${outcome.query}`)
        return
      }
      data.request = `${outcome.request}${outcome.query}`
      data.context = outcome.resolveDir
      return
    }
    case 'host-marker': {
      const resolved = await host.resolve(data.context, outcome.request)
      if (resolved !== false) {
        data.request = await host.synthetic(withDenoType(resolved, outcome.denoType))
      }
      return
    }
    case 'marker':
      data.request = await host.synthetic(outcome.path)
      return
    case 'virtual':
      data.request = await host.synthetic(outcome.id)
      return
    case 'external':
      return
  }
}

/** An issuer as a path (`undefined` for entries): webpack keeps its `\0#` escape of `#`. */
function issuerPath(issuer: string): string | undefined {
  return issuer === '' ? undefined : issuer.replaceAll('\0#', '#')
}

/**
 * An absolute path (with an optional query) as a webpack request: `#` in the path is escaped as
 * `\0#`, which webpack and Rspack read as a literal `#` rather than a fragment.
 */
export function requestPath(path: string): string {
  const { base, query } = splitQuery(path)
  return `${base.replaceAll('#', '\0#')}${query}`
}

/**
 * The error a webpack-family host shows for a failing import: a {@link DenoPluginError} becomes
 * an error whose message is its formatted text (`[unplugin-deno] <message> (<code>)` and the
 * hint; the hosts print only the message, and Rspack also the stack) and which keeps its code.
 */
export function toHostError(error: unknown): Error {
  if (!isDenoPluginError(error) || hostErrors.has(error)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const head = `[unplugin-deno] ${error.message} (${error.code})`
  const hostError = new Error(error.hint === undefined ? head : `${head}\n  hint: ${error.hint}`, {
    cause: error,
  })
  hostError.name = error.name
  hostError.stack = `${error.name}: ${hostError.message}`
  hostErrors.add(hostError)
  return Object.assign(hostError, {
    code: error.code,
    hint: error.hint,
    specifier: error.specifier,
    importer: error.importer,
  })
}

/** The errors {@link toHostError} made (they look like `DenoPluginError`s and pass through). */
const hostErrors = new WeakSet<Error>()

function rethrowForHost(error: unknown): never {
  throw toHostError(error)
}

/** A webpack-style normalised entry: `{ [name]: { import: [...] } }` (or a function). */
export type EntryOption = unknown

/**
 * The entry modules of a normalised webpack or Rspack `entry` option as engine inputs: relative
 * paths are resolved from `context` (as the host resolves them), specifiers are kept, requests
 * with inline loaders (`!`) and dynamic entries (functions) are skipped.
 */
export function entryInput(
  entry: EntryOption,
  context: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string[] {
  if (typeof entry !== 'object' || entry === null) return []
  const syntax = flavor === 'win32' ? win32 : posix
  const result: string[] = []
  for (const description of Object.values(entry as Record<string, unknown>)) {
    const imports: unknown =
      typeof description === 'object' && description !== null
        ? Reflect.get(description, 'import')
        : description
    const list = Array.isArray(imports) ? imports : [imports]
    for (const item of list) {
      if (typeof item !== 'string' || item === '' || item.includes('!')) continue
      const relative = /^\.\.?(?:[\\/]|$)/.test(item)
      result.push(relative ? syntax.resolve(context, item) : item)
    }
  }
  return result
}

/** The platform properties of `compiler.platform` (webpack ≥ 5.94, Rspack). */
export interface PlatformProperties {
  web?: boolean | null | undefined
  browser?: boolean | null | undefined
  webworker?: boolean | null | undefined
  node?: boolean | null | undefined
  deno?: boolean | null | undefined
}

/**
 * The platform hint of a webpack or Rspack build (§5.6): `deno` for webpack's `target: 'deno'`,
 * `node` for Node.js targets (the core picks `deno` for projects with a `deno.json`), `browser`
 * otherwise. Reads `compiler.platform` after the host applied its defaults, else `target`.
 */
export function platformHint(
  platform: PlatformProperties | undefined,
  target: unknown,
): PlatformHint {
  if (platform?.deno === true) return 'deno'
  if (platform?.node === true) return 'node'
  if (platform?.web === true || platform?.browser === true || platform?.webworker === true) {
    return 'browser'
  }
  const targets = (Array.isArray(target) ? target : [target]).filter(
    (item): item is string => typeof item === 'string',
  )
  if (targets.some((item) => item.startsWith('deno'))) return 'deno'
  if (targets.some((item) => /^(?:async-)?node|^electron-main/.test(item))) return 'node'
  return 'browser'
}

/** The export conditions a user set in `resolve.conditionNames` (without webpack's `'...'`). */
export function conditionNames(resolve: { conditionNames?: unknown } | undefined): string[] {
  const names = resolve?.conditionNames
  if (!Array.isArray(names)) return []
  return names.filter((name): name is string => typeof name === 'string' && name !== '...')
}

/**
 * Reloads the project when a watched config file changed (§5.7), from the changed files a
 * compiler reports in `watchRun`. Compilers sharing one plugin state (Rsbuild environments) report
 * the same change each: a file's modification time is remembered, so the project is reloaded once
 * per change, and reloads run one after the other.
 */
export class ConfigReloader {
  readonly #state: PluginState
  readonly #seen = new Map<string, number>()
  #queue: Promise<unknown> = Promise.resolve()
  #generation = 0

  constructor(state: PluginState) {
    this.#state = state
  }

  /**
   * Counts the reloads: a compiler compares it with the value it saw last to learn that the
   * project was reloaded, also when another compiler of the state reported the change.
   */
  get generation(): number {
    return this.#generation
  }

  /** Reloads the project for the first changed config file among `files`; `true` if it did. */
  reload(files: Iterable<string>): Promise<boolean> {
    const list = [...files]
    const run = this.#queue.then(() => this.#reload(list))
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #reload(files: readonly string[]): Promise<boolean> {
    for (const file of files) {
      const modified = await modificationTime(file)
      if (this.#seen.get(file) === modified) continue
      // The times before the reload: a file written while it loads is newer, so it reloads again.
      const watched = this.#state.watchFiles()
      const times = await Promise.all(watched.map(modificationTime))
      if (await this.#state.watchChange(file)) {
        watched.forEach((path, index) => this.#seen.set(path, times[index] ?? -1))
        this.#seen.set(file, modified)
        this.#generation++
        return true
      }
    }
    return false
  }
}

/**
 * The project's watched files (§5.7) as dependencies: those that exist are file dependencies,
 * the others (a lockfile not created yet) missing dependencies, which hosts watch for creation.
 * A file dependency that does not exist is reported as removed by some watchers (Bun's), which
 * rebuilds and reloads the project for nothing.
 */
export class WatchedFiles {
  #missing: ReadonlySet<string> = new Set()

  /** Checks which of `files` exist (once per compilation). */
  update(files: readonly string[]): { existing: string[]; missing: string[] } {
    const existing = files.filter((file) => existsSync(file))
    const missing = files.filter((file) => !existing.includes(file))
    this.#missing = new Set(missing)
    return { existing, missing }
  }

  /** Whether `file` was missing at the last {@link update}. */
  isMissing(file: string): boolean {
    return this.#missing.has(file)
  }
}

/** The modification time of `path`, or `-1` when it does not exist. */
async function modificationTime(path: string): Promise<number> {
  return stat(path).then(
    (stats) => stats.mtimeMs,
    () => -1,
  )
}

/** The build context unplugin's `load` loaders give a `load` hook (the part the adapters use). */
export interface LoadHookContext {
  addWatchFile(file: string): void
}

/** A module's code (and source map) as unplugin's `load` loaders take it. */
export interface LoadHookResult {
  code: string
  map?: HostSourceMap | null | undefined
}

/** A `load` hook run by unplugin's `load` loaders (`this` is unplugin's build context). */
export type LoadHook = (this: LoadHookContext, id: string) => Promise<LoadHookResult | null>

/** A `use` entry of a `module.rules` entry. */
export interface LoaderUse {
  loader: string
  /** Names the options in module identifiers (webpack's persistent cache); default: the rule path. */
  ident?: string
  options: { plugin: { name: string; load: LoadHook } }
}

/**
 * The `use` entry that runs `load` through unplugin's `load` loader for `host` (public entries of
 * the `unplugin` package: `unplugin/webpack/loaders/load`, `unplugin/rspack/loaders/load`). The
 * loader calls `options.plugin.load(resource)` with a build context whose `addWatchFile` adds a
 * dependency of the module, and returns the result's code and source map.
 */
export function loadLoader(host: 'webpack' | 'rspack', load: LoadHook, ident?: string): LoaderUse {
  const loader = unpluginLoaderPath(host, 'load')
  const use: LoaderUse = { loader, options: { plugin: { name: TAP_NAME, load } } }
  if (ident !== undefined) use.ident = ident
  return use
}

/**
 * A transform applied to mirror code after loading it (§5.10): the code and the edit's map, or
 * `null` for no change. `watch` adds a dependency of the module.
 */
export type MirrorTransform = (
  code: string,
  id: string,
  watch: (file: string) => void,
) => Promise<{ code: string; map?: HostSourceMap | null | undefined } | null>

/**
 * The `load` hook of mirror code files (§5.3): their code without the `sourceMappingURL` comment
 * and their source map as the core gives it to Rollup-family hosts, the source named next to the
 * mirror file (`…/https/jsr.io/@std/path/1.1.6/posix/join.ts`), as an absolute path because
 * webpack and Rspack do not resolve a loader's relative sources against the module (sources of
 * equal names would merge). Their own `extractSourceMap` would join the map's URL `sourceRoot`
 * as a path. `transform` (the source transforms, §5.10) edits the loaded code; its map is composed
 * over the mirror's.
 */
export function mirrorLoad(state: PluginState, transform?: MirrorTransform): LoadHook {
  return async function load(id) {
    const loaded = await state.load(id).catch((error: unknown) => {
      throw toHostError(error)
    })
    if (loaded === null) return null
    const edited =
      transform === undefined
        ? null
        : await transform(loaded.code, id, (file) => this.addWatchFile(file))
    const code = edited?.code ?? loaded.code
    const map = edited === null ? loaded.map : composeMaps(edited.map, loaded.map)
    if (map === null || map === undefined) return { code, map: null }
    const syntax = state.flavor === 'win32' ? win32 : posix
    const dir = syntax.dirname(splitQuery(id).base)
    const sources = map.sources.map((source) =>
      syntax.isAbsolute(source) || /^[a-z][a-z\d+.-]*:/i.test(source)
        ? source
        : syntax.join(dir, source),
    )
    return { code, map: { ...map, sources } }
  }
}

/**
 * Composes the map of an edit of a module (`edit`, whose single source is the module) over the
 * module's own map (`base`): the result maps the edited code to `base`'s sources.
 */
export function composeMaps(
  edit: HostSourceMap | null | undefined,
  base: HostSourceMap | null | undefined,
): HostSourceMap | null {
  if (edit === null || edit === undefined) return base ?? null
  if (base === null || base === undefined) return edit
  const composed = remapping([edit as SourceMapInput, base as SourceMapInput], () => null)
  return JSON.parse(composed.toString()) as HostSourceMap
}

/** The methods of a webpack or Rspack infrastructure logger the adapters use. */
export interface InfrastructureLogger {
  warn(message: string): void
  info(message: string): void
}

/**
 * The plugin's log target on webpack-family hosts (§5.8): warnings become warnings of the current
 * compilation (kept until one starts, e.g. project warnings from `beforeCompile`), info and debug
 * lines go to the host's infrastructure logger (`getInfrastructureLogger('unplugin-deno')`).
 */
export class CompilationLog implements HostLogTarget {
  readonly #logger: InfrastructureLogger
  readonly #pending: string[] = []
  #report: ((message: string) => void) | undefined

  constructor(logger: InfrastructureLogger) {
    this.#logger = logger
  }

  readonly warn = (message: string): void => {
    if (this.#report === undefined) this.#pending.push(message)
    else this.#report(message)
  }

  readonly info = (message: string): void => {
    this.#logger.info(message)
  }

  /** Reports warnings (and the pending ones) through `report` (a compilation's warnings). */
  attach(report: (message: string) => void): void {
    this.#report = report
    for (const message of this.#pending.splice(0)) report(message)
  }

  /** Ends the current compilation: later warnings wait for the next one. */
  detach(): void {
    this.#report = undefined
  }

  /** Prints the warnings no compilation took (the plugin is closing). */
  flush(): void {
    for (const message of this.#pending.splice(0)) this.#logger.warn(message)
  }
}

/** The allow-list of `experiments.buildHttp` as a matcher (`undefined` when it is not set). */
export function buildHttpMatcher(buildHttp: unknown): ((url: string) => boolean) | undefined {
  if (buildHttp === undefined || buildHttp === null || buildHttp === false) return undefined
  const allowed: unknown = Array.isArray(buildHttp)
    ? buildHttp
    : typeof buildHttp === 'object'
      ? Reflect.get(buildHttp, 'allowedUris')
      : undefined
  const list = Array.isArray(allowed) ? (allowed as unknown[]) : []
  return (url) =>
    list.some((item) => {
      if (typeof item === 'string') return url.startsWith(item)
      if (item instanceof RegExp) {
        item.lastIndex = 0
        return item.test(url)
      }
      return typeof item === 'function' && (item as (uri: string) => unknown)(url) === true
    })
}

export type { ExternalResult }
