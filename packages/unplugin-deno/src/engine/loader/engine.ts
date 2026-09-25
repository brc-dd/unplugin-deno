/**
 * The `loader` engine (docs/architecture.md §4.2): Deno's resolution and loading through the
 * vendored `@deno/loader` (`Workspace` + `Loader`, one wasm instance per process).
 *
 * @module
 */
import { existsSync, statSync } from 'node:fs'
import { posix, resolve as resolvePath, win32 } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { DenoPluginError } from '../../diagnostics/errors.js'
import type { Logger } from '../../diagnostics/logger.js'
import { HOST_PATH_FLAVOR, isSubpath, toFileUrl, toPath } from '../../utils/path.js'
import type {
  Loader,
  LoadResponse,
  ModuleLoadResponse,
  VendoredDenoLoader,
  Workspace,
  WorkspaceOptions,
} from '../../vendored-deno-loader.js'
import { loadVendoredDenoLoader } from '../../vendored-deno-loader.js'
import { resolveDenoDir } from '../deno-dir.js'
import { isMediaType, mediaTypeFromPath, mediaTypeFromUrl } from '../media-type.js'
import { canonicalize, NpmPackageLocator, realpathMaybeMissing } from '../npm-package.js'
import {
  isBareSpecifier,
  isPackageRequirement,
  parsePackageSpecifier,
} from '../package-specifier.js'
import type {
  EncodedSourceMap,
  Engine,
  EngineCreateOptions,
  EngineDiagnostic,
  EngineFactory,
  ExternalModule,
  LoadedModule,
  LoadType,
  MediaType,
  ResolutionMode,
  ResolvedModule,
} from '../types.js'
import { HINTS, toDenoPluginError, unresolvedRequirementError } from './errors.js'
import type { HookRegistration } from './hooks.js'
import { attachLoaderHooks } from './hooks.js'

/** Schemes `load()` hands to the loader; other schemes (`node:`, `bun:`, …) are external. */
const LOADABLE_SCHEMES: ReadonlySet<string> = new Set(['file', 'http', 'https', 'data'])
/** How many blocked download URLs a `cachedOnly` diagnostic lists. */
const BLOCKED_URLS_SHOWN = 3

const decoder = new TextDecoder()

/** Creates `loader` engines; see {@link createLoaderEngine}. */
export const loaderEngineFactory: EngineFactory = {
  kind: 'loader',
  create: (options) => createLoaderEngine(options),
}

/**
 * The `Workspace` options for an engine: always `configPath` (or `noConfig` for a project without
 * one; config discovery would otherwise start at `process.cwd()`), `noLock` when the project has
 * no lockfile in use, and transpiled output (`preserveJsx: false`, `noTranspile: false`).
 */
export function loaderWorkspaceOptions(options: EngineCreateOptions): WorkspaceOptions {
  const { project } = options
  return {
    ...(project.configPath === undefined ? { noConfig: true } : { configPath: project.configPath }),
    noLock: project.lockfilePath === undefined,
    platform: options.platform,
    nodeConditions: [...options.conditions],
    cachedOnly: options.cachedOnly,
    ...(options.newestDependencyDate === undefined
      ? {}
      : { newestDependencyDate: options.newestDependencyDate }),
    preserveJsx: false,
    noTranspile: false,
  }
}

/**
 * The options as the wasm side deserialises them: `newestDependencyDate` must be an RFC 3339
 * string (a `Date` fails with "invalid type: JsValue(Date)", although `mod.d.ts` types it `Date`).
 */
export function toWasmWorkspaceOptions(options: WorkspaceOptions): WorkspaceOptions {
  const date = options.newestDependencyDate
  if (date === undefined) return options
  return { ...options, newestDependencyDate: date.toISOString() as unknown as Date }
}

/**
 * Creates a `loader` engine: loads the vendored wasm (once per process), creates the `Workspace`
 * and `Loader`, and attaches the engine to the loader's log and fetch hooks (see `hooks.ts` for
 * the process-wide routing rule).
 *
 * @throws {DenoPluginError} `ENGINE_UNAVAILABLE` when the vendored loader cannot be loaded,
 *   `CONFIG_INVALID` when the loader rejects the project configuration.
 */
export async function createLoaderEngine(options: EngineCreateOptions): Promise<Engine> {
  const started = performance.now()
  const mod = await loadVendoredDenoLoader()
  const denoDir = resolveDenoDir()
  const blocked = new BlockedDownloads()
  const hooks = attachLoaderHooks({
    logger: options.logger,
    fetch: options.fetch,
    cachedOnly: options.cachedOnly,
    onBlockedDownload: (url) => blocked.add(url),
  })
  const end = hooks.begin()
  let workspace: Workspace | undefined
  let loader: Loader
  try {
    workspace = new mod.Workspace(toWasmWorkspaceOptions(loaderWorkspaceOptions(options)))
    loader = await workspace.createLoader()
  } catch (error) {
    try {
      if (workspace !== undefined) disposeNative(workspace)
    } finally {
      hooks.detach()
    }
    const config = options.project.configPath ?? 'the project'
    throw new DenoPluginError(
      'CONFIG_INVALID',
      `The Deno loader cannot load ${config}: ${errorMessage(error)}`,
      {
        hint: 'Check deno.json, deno.lock and package.json; `deno install` reports the same problem.',
        cause: error,
      },
    )
  } finally {
    end()
  }
  const engine = new LoaderEngine({ mod, workspace, loader, hooks, options, denoDir, blocked })
  const { project, platform, conditions, logger } = options
  logger.debug(
    `[engine] loader engine for ${project.configPath ?? `${project.root} (no deno.json)`}: ` +
      `platform ${platform}${conditions.length > 0 ? ` + ${conditions.join(', ')}` : ''}, ` +
      `nodeModulesDir ${project.nodeModulesDir}, lockfile ${project.lockfilePath ?? 'none'}` +
      `${options.cachedOnly ? ', cachedOnly' : ''}, DENO_DIR ${denoDir ?? 'unknown'} ` +
      `(${Math.round(performance.now() - started)} ms)`,
  )
  return engine
}

/** Downloads refused because of `cachedOnly`. */
class BlockedDownloads {
  /** Refusals so far (a URL refused twice counts twice). */
  count = 0
  readonly #urls = new Set<string>()

  add(url: string): void {
    this.count++
    this.#urls.add(url)
  }

  has(url: string): boolean {
    return this.#urls.has(url)
  }

  /** Whether a refused download belonged to the JSR package `name` (`<registry>/@scope/name/…`). */
  hasJsrPackage(name: string): boolean {
    const prefix = `/${name}/`
    for (const url of this.#urls) {
      if (URL.parse(url)?.pathname.startsWith(prefix) === true) return true
    }
    return false
  }

  /** The first refused URLs, for messages. */
  sample(): string {
    const urls = [...this.#urls].slice(0, BLOCKED_URLS_SHOWN)
    return `${urls.join(', ')}${this.#urls.size > urls.length ? ', …' : ''}`
  }
}

/** What is known about a failure, to decide whether `cachedOnly` caused it. */
interface FailureFacts {
  /** The URL that failed to load. */
  url?: string | undefined
  /** The `jsr:`/`npm:` requirement that failed to resolve. */
  requirement?: string | undefined
  /** The `ResolveError` code, if any. */
  code?: string | undefined
  /** The file an `ERR_MODULE_NOT_FOUND` error could not find. */
  missing?: string | undefined
}

/** What the asynchronous half of a resolution knows from what came before it. */
interface AsyncResolveContext {
  /** The `jsr:`/`npm:` requirement the synchronous half produced, if any. */
  mapped: string | undefined
  /** `BlockedDownloads.count` when the resolution started. */
  blockedBefore: number
  /** Why the requirement could not be installed, when that was tried first. */
  detail?: string | undefined
}

interface LoaderEngineParts {
  mod: VendoredDenoLoader
  workspace: Workspace
  loader: Loader
  hooks: HookRegistration
  options: EngineCreateOptions
  denoDir: string | undefined
  blocked: BlockedDownloads
}

/** The synchronous half of a resolution: a result, or the need to continue asynchronously. */
type SyncOutcome =
  | { readonly module: ResolvedModule }
  | { readonly module?: undefined; readonly mapped: string | undefined }

/**
 * The npm packages of a project (docs/architecture.md §4.4):
 *
 * - The loader downloads (`nodeModulesDir: "none"`) or installs (`"auto"`) npm packages while it
 *   adds modules to its graph, and its first installation covers every package of the lockfile.
 *   With `"manual"` it never installs: the project's `node_modules` is used as it is.
 * - The loader's Node.js resolution cache (file types and canonical paths, per wasm instance)
 *   also records misses and is only emptied when a `Loader` is freed. Looking up a file of a
 *   package that the lockfile names but that is not installed yet therefore leaves a miss that
 *   outlives the installation: `resolveSync` before the installation made every later resolution
 *   of that file fail with `ERR_MODULE_NOT_FOUND`, on every engine of the process.
 *
 * So until an engine has installed npm packages once, an `npm:` requirement is added to the graph
 * before any of its files is looked up (concurrent additions of one requirement are shared, and a
 * failed one is tried again by the next resolution). Afterwards the synchronous path answers:
 * lockfile packages are installed, and other requirements fail it before reading any file (the
 * asynchronous path installs them). A "not found" answer that may come from the cache (a bare
 * specifier the loader maps to a package it has not installed yet, a package the user installed
 * meanwhile) is retried once with an empty cache. `jsr:` requirements need none of this: the
 * synchronous path returns them unchanged, reading no file, until the asynchronous one has added
 * them to the graph.
 */
type NpmInstallation = 'loader' | 'user'

class LoaderEngine implements Engine {
  readonly kind = 'loader'
  readonly #mod: VendoredDenoLoader
  readonly #workspace: Workspace
  readonly #loader: Loader
  readonly #hooks: HookRegistration
  readonly #logger: Logger
  readonly #cachedOnly: boolean
  /** Who installs npm packages; see {@link NpmInstallation}. */
  readonly #npmInstallation: NpmInstallation
  readonly #root: string
  /** The project root as a directory URL: the referrer when none is given. */
  readonly #rootUrl: string
  readonly #denoDirNpm: string | undefined
  readonly #npm: NpmPackageLocator
  readonly #blocked: BlockedDownloads
  readonly #pending = new Set<Promise<unknown>>()
  /**
   * Canonical paths of existing npm files. Installed packages do not change while an engine lives
   * (like the `package.json` cache of {@link NpmPackageLocator}); engines are recreated when the
   * lockfile or config changes.
   */
  readonly #canonicalNpmPaths = new Map<string, string>()
  /** Additions of `npm:` requirements in flight (see {@link NpmInstallation}), by requirement. */
  readonly #installing = new Map<string, Promise<string | undefined>>()
  /** Whether the loader has installed npm packages for this engine (see {@link NpmInstallation}). */
  #npmInstalled = false
  #cacheRoots: readonly string[] | undefined
  #disposal: Promise<void> | undefined

  constructor(parts: LoaderEngineParts) {
    this.#mod = parts.mod
    this.#workspace = parts.workspace
    this.#loader = parts.loader
    this.#hooks = parts.hooks
    this.#logger = parts.options.logger
    this.#cachedOnly = parts.options.cachedOnly
    this.#npmInstallation = parts.options.project.nodeModulesDir === 'manual' ? 'user' : 'loader'
    this.#root = resolvePath(parts.options.project.root)
    const rootUrl = toFileUrl(this.#root)
    this.#rootUrl = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`
    const path = HOST_PATH_FLAVOR === 'win32' ? win32 : posix
    this.#denoDirNpm = parts.denoDir === undefined ? undefined : path.join(parts.denoDir, 'npm')
    this.#npm = new NpmPackageLocator(() => this.#npmCacheRoots())
    this.#blocked = parts.blocked
  }

  async addEntrypoints(entrypoints: readonly string[]): Promise<EngineDiagnostic[]> {
    this.#assertLive('add entrypoints')
    if (entrypoints.length === 0) return []
    return this.#track(async () => {
      const end = this.#hooks.begin()
      const blockedBefore = this.#blocked.count
      try {
        const urls = entrypoints.map((entry) => this.#entrypointUrl(entry))
        const diagnostics: EngineDiagnostic[] = (await this.#addAll(urls)).map((message) => ({
          message: cleanMessage(message),
        }))
        if (diagnostics.length > 0 && this.#npmInstallation === 'user') {
          diagnostics.push(...this.#missingPackageDiagnostics())
        }
        const blocked = this.#blocked.count - blockedBefore
        if (blocked > 0) {
          diagnostics.push({
            code: 'CACHED_ONLY_MISS',
            message:
              `${blocked} download(s) were refused because \`cachedOnly\` is set ` +
              `(${this.#blocked.sample()}). ${HINTS.cachedOnly}`,
          })
        }
        return diagnostics
      } finally {
        end()
      }
    })
  }

  resolveSync(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): ResolvedModule | undefined {
    this.#assertLive('resolve')
    const referrerUrl = this.#referrerUrl(specifier, referrer)
    // Its package may not be installed yet; looking it up now would cache misses.
    if (this.#requirementToInstall(specifier) !== undefined) return undefined
    return this.#syncOutcome(specifier, referrer, referrerUrl, mode).module
  }

  async resolve(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): Promise<ResolvedModule> {
    this.#assertLive('resolve')
    const referrerUrl = this.#referrerUrl(specifier, referrer)
    const requirement = this.#requirementToInstall(specifier)
    if (requirement !== undefined) {
      return this.#track(() =>
        this.#resolveAfterInstall(requirement, specifier, referrer, referrerUrl, mode),
      )
    }
    const outcome = this.#syncOutcome(specifier, referrer, referrerUrl, mode)
    if (outcome.module !== undefined) return outcome.module
    const { mapped } = outcome
    const blockedBefore = this.#blocked.count
    return this.#track(() =>
      this.#resolveAsync(specifier, referrer, referrerUrl, mode, { mapped, blockedBefore }),
    )
  }

  async load(url: string, type: LoadType): Promise<LoadedModule | ExternalModule> {
    this.#assertLive('load')
    const scheme = schemeOf(url)
    if (scheme === 'jsr' || scheme === 'npm') {
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot load "${url}": \`jsr:\` and \`npm:\` specifiers must be resolved first.`,
        { hint: HINTS.resolveFirst, specifier: url },
      )
    }
    if (scheme !== undefined && !LOADABLE_SCHEMES.has(scheme)) return { kind: 'external', url }
    return this.#track(async () => {
      const end = this.#hooks.begin()
      const blockedBefore = this.#blocked.count
      try {
        let response: LoadResponse
        try {
          response = await this.#loader.load(url, this.#requestedModuleType(type))
        } catch (error) {
          throw toDenoPluginError(error, {
            specifier: url,
            operation: 'load',
            resolveErrorClass: this.#mod.ResolveError,
            cachedOnlyMiss: this.#isCacheMiss(blockedBefore, { url }),
          })
        }
        if (response.kind === 'external') return { kind: 'external', url: response.specifier }
        return this.#loadedModule(response, type)
      } finally {
        end()
      }
    })
  }

  graph(): unknown {
    this.#assertLive('read the graph')
    return this.#loader.getGraphUnstable()
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#release()
    return this.#disposal
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  async #release(): Promise<void> {
    await Promise.allSettled(this.#pending)
    try {
      disposeNative(this.#loader)
    } finally {
      try {
        disposeNative(this.#workspace)
      } finally {
        this.#hooks.detach()
      }
    }
  }

  #assertLive(operation: string): void {
    if (this.#disposal !== undefined) {
      throw new DenoPluginError(
        'ENGINE_UNAVAILABLE',
        `Cannot ${operation}: the loader engine has been disposed.`,
        { hint: 'Create a new engine; engines are recreated when the config or lockfile changes.' },
      )
    }
  }

  #track<T>(run: () => Promise<T>): Promise<T> {
    const promise = run()
    this.#pending.add(promise)
    const settle = (): void => {
      this.#pending.delete(promise)
    }
    promise.then(settle, settle)
    return promise
  }

  /** {@link LoaderEngine.#resolveSyncOutcome}, attributing the loader's hooks to this engine. */
  #syncOutcome(
    specifier: string,
    referrer: string | undefined,
    referrerUrl: string,
    mode: ResolutionMode,
  ): SyncOutcome {
    const end = this.#hooks.begin()
    try {
      return this.#resolveSyncOutcome(specifier, referrer, referrerUrl, mode)
    } finally {
      end()
    }
  }

  /**
   * `resolveSync`, falling back (`mapped`) when its result is still a `jsr:`/`npm:` requirement
   * (not in the graph yet), when it throws a `ResolveError` without a code, or when it throws
   * `ERR_MODULE_NOT_FOUND`: the asynchronous path downloads or installs a package that is known
   * (lockfile) but not downloaded or installed yet, and tells a cached miss from a missing file
   * (see {@link NpmInstallation}). A missing optional dependency is reported at once.
   */
  #resolveSyncOutcome(
    specifier: string,
    referrer: string | undefined,
    referrerUrl: string,
    mode: ResolutionMode,
  ): SyncOutcome {
    let url: string
    try {
      url = this.#loader.resolveSync(specifier, referrerUrl, this.#resolutionMode(mode))
    } catch (error) {
      if (this.#needsAsyncResolve(error)) return { mapped: undefined }
      throw toDenoPluginError(error, {
        specifier,
        referrer,
        resolveErrorClass: this.#mod.ResolveError,
      })
    }
    if (isPackageRequirement(url)) return { mapped: url }
    return { module: this.#classify(url, specifier) }
  }

  /**
   * Resolves an `npm:` specifier before the loader has installed npm packages for this engine:
   * its requirement is added to the graph first (see {@link NpmInstallation}).
   */
  async #resolveAfterInstall(
    requirement: string,
    specifier: string,
    referrer: string | undefined,
    referrerUrl: string,
    mode: ResolutionMode,
  ): Promise<ResolvedModule> {
    const blockedBefore = this.#blocked.count
    const failure = await this.#install(requirement)
    if (failure !== undefined) {
      // The asynchronous path tries once more and reports the failure.
      return this.#resolveAsync(specifier, referrer, referrerUrl, mode, {
        mapped: undefined,
        blockedBefore,
        detail: failure,
      })
    }
    const outcome = this.#syncOutcome(specifier, referrer, referrerUrl, mode)
    if (outcome.module !== undefined) return outcome.module
    return this.#resolveAsync(specifier, referrer, referrerUrl, mode, {
      mapped: outcome.mapped,
      blockedBefore,
    })
  }

  /**
   * Adds `requirement` to the graph, which downloads or installs its package (and, the first time,
   * every package of the lockfile). Additions in flight are shared; a failure is not remembered.
   * Resolves to why the addition failed, or `undefined`.
   */
  #install(requirement: string): Promise<string | undefined> {
    const pending = this.#installing.get(requirement)
    if (pending !== undefined) return pending
    const installing = this.#addRequirement(requirement)
    this.#installing.set(requirement, installing)
    const settle = (): void => {
      if (this.#installing.get(requirement) === installing) this.#installing.delete(requirement)
    }
    installing.then(settle, settle)
    return installing
  }

  async #addRequirement(requirement: string): Promise<string | undefined> {
    const end = this.#hooks.begin()
    let failure: string | undefined
    try {
      const [diagnostic] = await this.#loader.addEntrypoints([requirement])
      failure = diagnostic === undefined ? undefined : cleanMessage(diagnostic.message)
    } catch (error) {
      failure = errorMessage(error)
    } finally {
      end()
    }
    if (failure === undefined) {
      this.#npmInstalled = true
      this.#logger.debug(`[engine] Installed ${requirement}`)
    } else {
      this.#logger.debug(`[engine] Cannot install ${requirement}: ${failure}`)
    }
    return failure
  }

  /**
   * The requirement (`npm:name@range`, without subpath) to add to the graph before `specifier` is
   * looked up, or `undefined` when looking it up is safe (see {@link NpmInstallation}).
   */
  #requirementToInstall(specifier: string): string | undefined {
    if (this.#npmInstalled || this.#npmInstallation === 'user') return undefined
    const parsed = parsePackageSpecifier(specifier)
    if (parsed?.scheme !== 'npm') return undefined
    return `npm:${parsed.name}${parsed.version === undefined ? '' : `@${parsed.version}`}`
  }

  async #resolveAsync(
    specifier: string,
    referrer: string | undefined,
    referrerUrl: string,
    mode: ResolutionMode,
    context: AsyncResolveContext,
  ): Promise<ResolvedModule> {
    const { mapped, blockedBefore } = context
    const end = this.#hooks.begin()
    try {
      let url: string
      try {
        url = await this.#loaderResolve(specifier, referrerUrl, mode)
      } catch (error) {
        const fields = resolveErrorFields(error, this.#mod)
        const code = fields?.code
        const requirement = [fields?.specifier, mapped, specifier].find(
          (candidate): candidate is string =>
            candidate !== undefined && isPackageRequirement(candidate),
        )
        throw toDenoPluginError(error, {
          specifier,
          referrer,
          mapped,
          resolveErrorClass: this.#mod.ResolveError,
          userInstalledNpm: this.#npmInstallation === 'user',
          detail:
            code === undefined && requirement !== undefined
              ? (context.detail ?? (await this.#rootDiagnostic(requirement)))
              : undefined,
          cachedOnlyMiss: this.#isCacheMiss(blockedBefore, {
            requirement,
            code,
            missing: fields?.specifier,
          }),
        })
      }
      if (isPackageRequirement(url)) {
        // The loader could not resolve the package; the graph recorded why.
        throw unresolvedRequirementError(url, {
          specifier,
          referrer,
          userInstalledNpm: this.#npmInstallation === 'user',
          detail: context.detail ?? (await this.#rootDiagnostic(url)),
          cachedOnlyMiss: this.#isCacheMiss(blockedBefore, { requirement: url }),
        })
      }
      return this.#classify(url, specifier)
    } finally {
      end()
    }
  }

  /**
   * `loader.resolve`, tried once more with an empty resolution cache when its failure may come
   * from a cached miss (see {@link NpmInstallation}).
   */
  async #loaderResolve(
    specifier: string,
    referrerUrl: string,
    mode: ResolutionMode,
  ): Promise<string> {
    const resolutionMode = this.#resolutionMode(mode)
    try {
      return await this.#loader.resolve(specifier, referrerUrl, resolutionMode)
    } catch (error) {
      if (!this.#mayBeCachedMiss(error) || !(await this.#clearResolutionCache())) throw error
      this.#logger.debug(`[engine] Resolving ${specifier} again with an empty resolution cache`)
      return await this.#loader.resolve(specifier, referrerUrl, resolutionMode)
    }
  }

  /**
   * Whether a failure may come from a miss in the loader's resolution cache: a module that was not
   * found (a missing optional dependency is expected, so it is not retried), or an npm package
   * missing from a `node_modules` the user installs (`nodeModulesDir: "manual"`).
   */
  #mayBeCachedMiss(error: unknown): boolean {
    const fields = resolveErrorFields(error, this.#mod)
    if (fields === undefined) return false
    if (fields.code === 'ERR_MODULE_NOT_FOUND') return !fields.isOptionalDependency
    return (
      fields.code === undefined &&
      this.#npmInstallation === 'user' &&
      fields.specifier !== undefined &&
      parsePackageSpecifier(fields.specifier)?.scheme === 'npm'
    )
  }

  /**
   * Empties the loader's Node.js resolution cache, which the wasm empties whenever it frees a
   * `Loader` (see {@link NpmInstallation}): a throwaway loader of the workspace is created and
   * freed (well under a millisecond). Returns whether that worked.
   */
  async #clearResolutionCache(): Promise<boolean> {
    try {
      disposeNative(await this.#workspace.createLoader())
      return true
    } catch (error) {
      this.#logger.debug(`[engine] Cannot empty the resolution cache: ${errorMessage(error)}`)
      return false
    }
  }

  /**
   * Whether `cachedOnly` explains a failure: a download was refused during the operation, the
   * failing URL was refused before, a refused download belonged to the failing JSR package, an npm
   * requirement failed without a Node.js code (the loader only reads cached npm metadata then), or
   * a known npm package is missing from the cache.
   */
  #isCacheMiss(blockedBefore: number, facts: FailureFacts): boolean {
    if (!this.#cachedOnly) return false
    if (this.#blocked.count > blockedBefore) return true
    if (facts.url !== undefined && this.#blocked.has(facts.url)) return true
    if (facts.code === 'ERR_MODULE_NOT_FOUND') return this.#isUninstalledNpmFile(facts.missing)
    const requirement =
      facts.requirement === undefined ? undefined : parsePackageSpecifier(facts.requirement)
    if (requirement?.scheme === 'jsr') return this.#blocked.hasJsrPackage(requirement.name)
    // Projects that install their own npm packages download none.
    return (
      requirement?.scheme === 'npm' &&
      facts.code === undefined &&
      this.#npmInstallation === 'loader'
    )
  }

  #needsAsyncResolve(error: unknown): boolean {
    const fields = resolveErrorFields(error, this.#mod)
    if (fields === undefined) return false
    if (fields.code === undefined) return true
    if (fields.code !== 'ERR_MODULE_NOT_FOUND') return false
    return !fields.isOptionalDependency || this.#isUninstalledNpmFile(fields.specifier)
  }

  /**
   * Whether `url` is a missing file in a package location the loader manages itself (the global npm
   * cache, or `node_modules/.deno/` for `nodeModulesDir: "auto"`).
   */
  #isUninstalledNpmFile(url: string | undefined): boolean {
    if (url === undefined || schemeOf(url) !== 'file') return false
    let path: string
    try {
      path = toPath(url)
    } catch {
      return false
    }
    const managed = /(?:^|[\\/])node_modules[\\/]\.deno[\\/]/.test(path) || this.#isInNpmCache(path)
    return managed && !existsSync(path)
  }

  /**
   * The graph diagnostic explaining why `requirement` (a failed root) did not resolve. An npm
   * package missing from a `node_modules` the user installs has none (the loader refuses such a
   * root), and the resolution error explains it.
   */
  async #rootDiagnostic(requirement: string): Promise<string | undefined> {
    if (this.#npmInstallation === 'user' && parsePackageSpecifier(requirement)?.scheme === 'npm') {
      return undefined
    }
    try {
      const [first] = await this.#loader.addEntrypoints([requirement])
      return first?.message
    } catch {
      return undefined
    }
  }

  /**
   * With `nodeModulesDir: "manual"`, one diagnostic with a code and a hint per npm package the
   * graph imports but `node_modules` lacks (the loader's diagnostics for them have no code, like
   * those for imports the host resolves, so hosts only log them as debug output). The graph keeps
   * the error of a failed import without the requirement it maps to, so each failed `npm:` or bare
   * import is resolved again from the project root.
   */
  #missingPackageDiagnostics(): EngineDiagnostic[] {
    let graph: unknown
    try {
      graph = this.#loader.getGraphUnstable()
    } catch {
      return []
    }
    const missing = new Set<string>()
    for (const specifier of failedImports(graph)) {
      const requirement = parsePackageSpecifier(this.#npmRequirementOf(specifier) ?? '')
      if (requirement?.scheme !== 'npm') continue
      const version = requirement.version === undefined ? '' : `@${requirement.version}`
      missing.add(`npm:${requirement.name}${version}`)
    }
    return [...missing].map((requirement) => ({
      code: 'RESOLVE_NOT_FOUND',
      message: `${requirement} is not installed. ${HINTS.notInstalled}`,
    }))
  }

  /**
   * The `npm:` requirement an `npm:` or bare `specifier` resolves to when the loader cannot find
   * its package (a `ResolveError` without a code that names the requirement), else `undefined`.
   */
  #npmRequirementOf(specifier: string): string | undefined {
    if (!isBareSpecifier(specifier) && parsePackageSpecifier(specifier)?.scheme !== 'npm') {
      return undefined
    }
    try {
      this.#loader.resolveSync(specifier, this.#rootUrl, this.#mod.ResolutionMode.Import)
      return undefined
    } catch (error) {
      const fields = resolveErrorFields(error, this.#mod)
      return fields?.code === undefined ? fields?.specifier : undefined
    }
  }

  /**
   * Adds entrypoints; the loader rejects the whole batch when one entrypoint cannot be resolved
   * (an unmapped bare specifier), so on failure they are added one at a time.
   */
  async #addAll(urls: readonly string[]): Promise<string[]> {
    try {
      const diagnostics = await this.#loader.addEntrypoints([...urls])
      return diagnostics.map((diagnostic) => diagnostic.message)
    } catch (error) {
      if (urls.length === 1) return [`Cannot add entrypoint "${urls[0]}": ${errorMessage(error)}`]
      const messages: string[] = []
      for (const url of urls) messages.push(...(await this.#addAll([url])))
      return messages
    }
  }

  /** An entrypoint as the loader expects it (URLs; paths relative to the project root). */
  #entrypointUrl(entry: string): string {
    if (isAbsoluteHostPath(entry)) return toFileUrl(entry)
    if (schemeOf(entry) !== undefined) return entry
    if (/^\.{1,2}(?:[\\/]|$)/.test(entry)) {
      return new URL(entry.replaceAll('\\', '/'), this.#rootUrl).href
    }
    const candidate = resolvePath(this.#root, entry)
    if (isFile(candidate)) return toFileUrl(candidate)
    // A mapped bare specifier: resolve it from the project root rather than `process.cwd()`.
    try {
      return this.#loader.resolveSync(entry, this.#rootUrl, this.#mod.ResolutionMode.Import)
    } catch {
      return entry
    }
  }

  /**
   * The referrer URL for the loader. `undefined` means the project root. The loader reads anything
   * but `file:`/`http(s):` URLs as a file path, so other schemes (`data:`, `jsr:`, …) resolve
   * non-relative specifiers from the project root and reject relative ones.
   */
  #referrerUrl(specifier: string, referrer: string | undefined): string {
    if (referrer === undefined || referrer === '') return this.#rootUrl
    if (isAbsoluteHostPath(referrer)) return toFileUrl(referrer)
    const scheme = schemeOf(referrer)
    if (scheme === 'file' || scheme === 'http' || scheme === 'https') return referrer
    if (scheme === undefined) return toFileUrl(resolvePath(this.#root, referrer))
    if (/^(?:\.{1,2}(?:\/|$)|\/)/.test(specifier)) {
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot resolve "${specifier}" from "${referrer}": relative specifiers need a file: or http(s): importer.`,
        { hint: HINTS.relativeFromNonHierarchical, specifier, importer: referrer },
      )
    }
    return this.#rootUrl
  }

  #classify(url: string, specifier: string): ResolvedModule {
    switch (schemeOf(url)) {
      case 'file':
        return this.#classifyFile(url, specifier)
      case 'http':
      case 'https':
        return { kind: 'remote', url, mediaType: mediaTypeFromUrl(url) }
      case 'data':
        return { kind: 'data', url, mediaType: mediaTypeFromUrl(url) }
      case 'node':
        return { kind: 'node', url, mediaType: 'Unknown' }
      default:
        return { kind: 'external', url, mediaType: 'Unknown' }
    }
  }

  #classifyFile(url: string, specifier: string): ResolvedModule {
    const path = toPath(url)
    if (!this.#npm.contains(path)) {
      return { kind: 'local', url, path, mediaType: mediaTypeFromPath(path) }
    }
    const real = this.#canonicalNpmPath(path)
    const requested = parsePackageSpecifier(specifier)
    const expected = requested?.scheme === 'jsr' ? undefined : requested
    const found = this.#npm.find(real, expected?.name)
    const module: ResolvedModule = {
      kind: 'npm',
      url,
      path: real,
      mediaType: mediaTypeFromPath(real),
    }
    if (found === undefined) return module
    const syntax = HOST_PATH_FLAVOR === 'win32' ? win32 : posix
    const subpath =
      expected !== undefined && found.name === expected.name
        ? expected.subpath
        : `/${syntax.relative(found.dir, real).split(syntax.sep).join('/')}`
    return {
      ...module,
      npm: {
        name: found.name,
        version: found.version,
        subpath,
        packageDir: found.dir,
        packageJsonPath: found.packageJsonPath,
      },
      sideEffects: found.sideEffects,
    }
  }

  #canonicalNpmPath(path: string): string {
    const cached = this.#canonicalNpmPaths.get(path)
    if (cached !== undefined) return cached
    const canonical = canonicalize(path)
    if (canonical.exists) this.#canonicalNpmPaths.set(path, canonical.path)
    return canonical.path
  }

  #isInNpmCache(path: string): boolean {
    return this.#npmCacheRoots().some((root) => isSubpath(root, path))
  }

  /** `DENO_DIR/npm`, literally and canonicalised (the loader reports canonical paths). */
  #npmCacheRoots(): readonly string[] {
    if (this.#cacheRoots !== undefined) return this.#cacheRoots
    const literal = this.#denoDirNpm
    if (literal === undefined) {
      this.#cacheRoots = []
      return this.#cacheRoots
    }
    const real = realpathMaybeMissing(literal)
    const roots = real === literal ? [literal] : [literal, real]
    // Until the directory exists, a canonical ancestor may still appear; recompute next time.
    if (existsSync(literal)) this.#cacheRoots = roots
    return roots
  }

  #resolutionMode(mode: ResolutionMode): Parameters<Loader['resolveSync']>[2] {
    const { ResolutionMode } = this.#mod
    return mode === 'require' ? ResolutionMode.Require : ResolutionMode.Import
  }

  #requestedModuleType(type: LoadType): Parameters<Loader['load']>[1] {
    const { RequestedModuleType } = this.#mod
    switch (type) {
      case 'json':
        return RequestedModuleType.Json
      case 'text':
        return RequestedModuleType.Text
      case 'bytes':
        return RequestedModuleType.Bytes
      default:
        return RequestedModuleType.Default
    }
  }

  #loadedModule(response: ModuleLoadResponse, type: LoadType): LoadedModule {
    const bytes = response.code
    let code = decoder.decode(bytes)
    let map: EncodedSourceMap | undefined
    if (response.sourceMap !== undefined && (type === 'default' || type === 'json')) {
      code = stripInlineSourceMap(code)
      map = parseSourceMap(response.sourceMap)
      if (map === undefined) {
        this.#logger.debug(`[engine] Ignoring an invalid source map for ${response.specifier}`)
      }
    }
    const module: LoadedModule = {
      kind: 'module',
      url: response.specifier,
      mediaType: this.#mediaTypeName(response.mediaType),
      code,
      bytes,
    }
    return map === undefined ? module : { ...module, map }
  }

  #mediaTypeName(value: number): MediaType {
    const name: unknown = (this.#mod.MediaType as unknown as Record<number, unknown>)[value]
    return isMediaType(name) ? name : 'Unknown'
  }
}

/**
 * Frees the wasm side of a `Workspace` or `Loader`. Both implement `Disposable`, but the vendored
 * `mod.d.ts` omits the `[Symbol.dispose]` member.
 */
function disposeNative(value: Workspace | Loader): void {
  ;(value as unknown as Disposable)[Symbol.dispose]()
}

/** The scheme of a URL or `scheme:` specifier, lower-cased; `undefined` for paths. */
function schemeOf(value: string): string | undefined {
  if (/^[a-zA-Z]:(?:[\\/]|$)/.test(value)) return undefined
  return /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(value)?.[1]?.toLowerCase()
}

function isAbsoluteHostPath(value: string): boolean {
  return HOST_PATH_FLAVOR === 'win32'
    ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(value)
    : value.startsWith('/')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The specifiers of the imports the loader's serialized graph (`getGraphUnstable()`, deno_graph's
 * JSON: `modules[].dependencies[].code.error`) failed to resolve; unexpected shapes yield none.
 */
function failedImports(graph: unknown): Set<string> {
  const failed = new Set<string>()
  const modules = isRecord(graph) && Array.isArray(graph.modules) ? graph.modules : []
  for (const module of modules) {
    const dependencies = isRecord(module) ? module.dependencies : undefined
    if (!Array.isArray(dependencies)) continue
    for (const dependency of dependencies) {
      if (!isRecord(dependency) || typeof dependency.specifier !== 'string') continue
      const code = dependency.code
      if (isRecord(code) && typeof code.error === 'string') failed.add(dependency.specifier)
    }
  }
  return failed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The fields of a vendored `ResolveError` (see {@link resolveErrorFields}). */
interface ResolveErrorFields {
  code: string | undefined
  specifier: string | undefined
  isOptionalDependency: boolean
}

/** The fields of a vendored `ResolveError`, or `undefined` for other errors. */
function resolveErrorFields(
  error: unknown,
  mod: VendoredDenoLoader,
): ResolveErrorFields | undefined {
  if (!(error instanceof mod.ResolveError)) return undefined
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    specifier: typeof error.specifier === 'string' ? error.specifier : undefined,
    isOptionalDependency: error.isOptionalDependency === true,
  }
}

function errorMessage(error: unknown): string {
  return cleanMessage(error instanceof Error ? error.message : String(error))
}

/** Loader messages carry terminal colors when stderr is a TTY. */
function cleanMessage(message: string): string {
  return stripVTControlCharacters(message).trim()
}

/**
 * Removes the loader's trailing `//# sourceMappingURL=data:…` line (the same map is returned
 * separately); code without one is returned unchanged.
 */
export function stripInlineSourceMap(code: string): string {
  const index = code.lastIndexOf('//# sourceMappingURL=data:')
  if (index === -1 || (index > 0 && code[index - 1] !== '\n')) return code
  if (code.slice(index).trimEnd().includes('\n')) return code
  return code.slice(0, index)
}

/** Parses the loader's source map bytes; `undefined` when they are not a valid encoded map. */
export function parseSourceMap(bytes: Uint8Array): EncodedSourceMap | undefined {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const map = value as Record<string, unknown>
  if (
    map.version !== 3 ||
    typeof map.mappings !== 'string' ||
    !Array.isArray(map.sources) ||
    !Array.isArray(map.names)
  ) {
    return undefined
  }
  return value as EncodedSourceMap
}
