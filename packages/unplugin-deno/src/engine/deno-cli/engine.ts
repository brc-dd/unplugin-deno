/**
 * The `deno` engine (docs/architecture.md §4.3): Deno's resolution through the installed Deno CLI
 * (2.8.3+) instead of the vendored loader, for projects that use Deno features the loader lacks.
 *
 * - **Graph.** `deno info --json` builds the module graph. It takes a single module, so the engine
 *   writes a synthetic root module importing every entrypoint (or every pending specifier) into a
 *   private temporary directory; that also keeps long entry lists off the command line (the
 *   Windows argv limit). Import maps, scopes, workspaces, `links`, `catalog:`, lockfile pins and
 *   the minimum dependency age are applied by Deno itself.
 * - **Resolution.** A specifier imported by a module of the graph resolves through that module's
 *   recorded dependency, then `redirects`. Other specifiers are queued for 5 ms and resolved by one
 *   `deno info` per batch (a local importer is queried again in the same run, so an edited file gets
 *   its new imports); runs are serialised, never one per import. `deno info` names npm packages
 *   (`npmPackages[*].localPath`) but not files, so subpaths and imports inside npm packages are
 *   resolved with Node's algorithm in bundle mode (`node-resolver.ts`), with the engine's platform
 *   and conditions.
 * - **Loading.** Remote modules are read from their `DENO_DIR` cache file (the trailing
 *   `// denoCacheMetadata=` line removed); TypeScript and JSX are transpiled with `deno transpile`
 *   (`transpile.ts`), in batches that include the module's not yet transpiled dependencies.
 * - `deno info` has no `--cached-only`: for `cachedOnly` the engine points Deno's HTTP proxy at a
 *   closed local port, so every download fails at once, and Deno's `Download <url>` progress lines
 *   tell which modules were missing from the cache.
 * - Deno gets a private copy of the lockfile: `deno info` adds new entries to the lockfile it is
 *   given, and the plugin never writes `deno.lock` (engines are recreated when it changes).
 *
 * @module
 */
import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve as resolvePath, win32 } from 'node:path'
import { DenoPluginError } from '../../diagnostics/errors.js'
import type { Logger } from '../../diagnostics/logger.js'
import { parseJsonc } from '../../utils/fs.js'
import { HOST_PATH_FLAVOR, isSubpath, toFileUrl, toPath } from '../../utils/path.js'
import { normalizeUrl } from '../../utils/url.js'
import { EngineResolveError } from '../errors.js'
import { HINTS, unresolvedRequirementError } from '../loader/errors.js'
import { mediaTypeFromContentType, mediaTypeFromPath, mediaTypeFromUrl } from '../media-type.js'
import { canonicalize, NpmPackageLocator, realpathMaybeMissing } from '../npm-package.js'
import { isBareSpecifier, parsePackageSpecifier } from '../package-specifier.js'
import type {
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
import { InfoGraph } from './graph.js'
import type { DenoInfoDependency, DenoInfoNpmPackage, DenoInfoOutput, DenoStderr } from './info.js'
import {
  DenoInfoFormatError,
  parseDenoInfo,
  parseDenoStderr,
  splitCacheFile,
  toMediaType,
} from './info.js'
import type { NodeResolution } from './node-resolver.js'
import { isNodeResolutionError, NodeResolver } from './node-resolver.js'
import type { DenoCacheDirs, DenoRunResult } from './process.js'
import {
  DEFAULT_DENO_BINARY,
  denoCacheDirs,
  denoEnv,
  DenoSpawnError,
  requireDeno,
  runDeno,
} from './process.js'
import type { TranspileItem, TranspileOutput } from './transpile.js'
import { needsTranspile, TranspileError, Transpiler } from './transpile.js'

/** Creates `deno` engines; see {@link createDenoCliEngine}. */
export const denoCliEngineFactory: EngineFactory = {
  kind: 'deno',
  create: (options) => createDenoCliEngine(options),
}

/** Timing knobs of the `deno` engine (tests shorten them). */
export interface DenoCliEngineTuning {
  /** Wait before a batch of unresolved specifiers or transpilations runs (default 5 ms). */
  batchDelayMs?: number | undefined
  /** Kills a `deno info` that runs longer (default 10 minutes: cold npm installs are slow). */
  infoTimeoutMs?: number | undefined
  /** Kills a `deno transpile` that runs longer (default 2 minutes). */
  transpileTimeoutMs?: number | undefined
}

const DEFAULT_TUNING: Required<DenoCliEngineTuning> = {
  batchDelayMs: 5,
  infoTimeoutMs: 10 * 60_000,
  transpileTimeoutMs: 2 * 60_000,
}

/** Imports per synthetic root (one `deno info` run). */
const MAX_QUERIES = 2_000
/** Modules transpiled ahead of a load (its not yet transpiled dependencies). */
const MAX_PREFETCH = 1_000
/** Rounds of `deno info` one resolution may need (an npm package of the referrer, then its file). */
const MAX_ROUNDS = 3
/**
 * The proxy of `cachedOnly` runs: nothing listens on port 1 (tcpmux) of the loopback interface,
 * so every download fails at once while cached modules are still served.
 */
const CACHED_ONLY_PROXY = 'http://127.0.0.1:1'
/** How many refused download URLs a `cachedOnly` diagnostic lists. */
const DOWNLOADS_SHOWN = 3
/** Deno's exit code when a module does not match its `deno.lock` integrity (observed, 2.9.7). */
const INTEGRITY_EXIT_CODE = 10
/** Schemes `load()` reads; other schemes (`node:`, `bun:`, …) are external. */
const LOADABLE_SCHEMES: ReadonlySet<string> = new Set(['file', 'http', 'https', 'data'])
const DECLARATION_MEDIA_TYPES: ReadonlySet<MediaType> = new Set(['Dts', 'Dmts', 'Dcts'])
const RELATIVE_OR_ABSOLUTE = /^(?:\.{1,2}(?:\/|$)|\/)/

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Creates a `deno` engine: checks the Deno binary (2.8.3+, once per process) and asks Deno where
 * its caches are. Nothing else runs until the engine is used.
 *
 * @throws {DenoPluginError} `ENGINE_UNAVAILABLE` when the Deno binary is missing, too old or
 *   broken.
 */
export async function createDenoCliEngine(
  options: EngineCreateOptions,
  tuning: DenoCliEngineTuning = {},
): Promise<Engine> {
  const started = performance.now()
  // The environment (DENO_DIR, proxies, auth tokens) is fixed when the engine is created, like
  // the loader's.
  const env = { ...process.env }
  const deno = await requireDeno(options.denoBinary ?? DEFAULT_DENO_BINARY, env)
  const root = resolvePath(options.project.root)
  const dirs = await denoCacheDirs(deno.binary, env, root).catch((): DenoCacheDirs => ({
    denoDir: undefined,
    npmCache: undefined,
  }))
  const engine = new DenoCliEngine({
    options,
    binary: deno.binary,
    version: deno.version,
    env,
    dirs,
    tuning: {
      batchDelayMs: tuning.batchDelayMs ?? DEFAULT_TUNING.batchDelayMs,
      infoTimeoutMs: tuning.infoTimeoutMs ?? DEFAULT_TUNING.infoTimeoutMs,
      transpileTimeoutMs: tuning.transpileTimeoutMs ?? DEFAULT_TUNING.transpileTimeoutMs,
    },
  })
  const { project, platform, conditions, logger } = options
  logger.debug(
    `[engine] deno engine (Deno ${deno.version}, \`${deno.binary}\`) for ` +
      `${project.configPath ?? `${project.root} (no deno.json)`}: platform ${platform}` +
      `${conditions.length > 0 ? ` + ${conditions.join(', ')}` : ''}, ` +
      `nodeModulesDir ${project.nodeModulesDir}, lockfile ${project.lockfilePath ?? 'none'}` +
      `${options.cachedOnly ? ', cachedOnly' : ''}, DENO_DIR ${dirs.denoDir ?? 'unknown'} ` +
      `(${Math.round(performance.now() - started)} ms)`,
  )
  return engine
}

interface EngineParts {
  options: EngineCreateOptions
  binary: string
  version: string
  /** The environment of every Deno subprocess (captured at creation). */
  env: NodeJS.ProcessEnv
  dirs: DenoCacheDirs
  tuning: Required<DenoCliEngineTuning>
}

/** What a synthetic root imports. */
interface Query {
  /** An absolute URL, a `jsr:`/`npm:`/`node:` specifier or a bare specifier. */
  specifier: string
  /** `with { type }` for raw loads, which Deno downloads without parsing them. */
  attribute?: 'bytes' | 'json' | undefined
}

/** The outcome of one `deno info` run. */
interface InfoRun {
  /** Numbers the runs of an engine (see {@link InfoGraph.recordedBy}). */
  id: number
  /** The synthetic root's dependency for each query, by specifier. */
  answers: ReadonlyMap<string, DenoInfoDependency>
  /** Downloads Deno started (all refused with `cachedOnly`). */
  downloads: readonly string[]
  /** Set when the run failed as a whole (non-zero exit, unreadable output, timeout). */
  failure: DenoPluginError | undefined
  /** The URL of the synthetic root, which Deno names in messages. */
  rootUrl: string
}

/** A batch being collected. */
interface OpenBatch {
  queries: Map<string, Query>
  promise: Promise<InfoRun>
  resolve: (run: InfoRun) => void
}

/** The referrer of a resolution. */
interface Referrer {
  /** As given (for messages). */
  raw: string | undefined
  /** Its URL: a module of the graph, or the project root directory. */
  url: string
  /** A `local` file, a file of an `npm` package, a `remote` or `data:` module, or the `root`. */
  kind: 'local' | 'npm' | 'remote' | 'data' | 'root'
  /** OS path of a `local` or `npm` referrer. */
  path?: string | undefined
}

/**
 * One step of a resolution: a result, specifiers Deno must resolve first (`miss`), or (with
 * `nodeModulesDir: "manual"`) a failed bare specifier whose import-map target is needed to tell a
 * missing package from an unmapped name.
 */
type Step =
  | { readonly module: ResolvedModule }
  | { readonly miss: readonly Query[] }
  | { readonly unmapped: string }

/** A global-cache npm package the graph does not know yet: Deno must be asked about it. */
class UnknownPackageError extends Error {
  override readonly name = 'UnknownPackageError'
  readonly requirement: string

  constructor(requirement: string) {
    super(`The npm package ${requirement} is not in the graph.`)
    this.requirement = requirement
  }
}

class DenoCliEngine implements Engine {
  readonly kind = 'deno'
  readonly #options: EngineCreateOptions
  readonly #logger: Logger
  readonly #binary: string
  readonly #version: string
  readonly #baseEnv: NodeJS.ProcessEnv
  readonly #tuning: Required<DenoCliEngineTuning>
  readonly #mode: 'auto' | 'manual' | 'none'
  readonly #root: string
  /** The project root as a directory URL: the referrer when none is given. */
  readonly #rootUrl: string
  readonly #graph = new InfoGraph()
  /** Root-level answers for specifiers a module does not import itself (`referrer\0specifier`). */
  readonly #answers = new Map<string, string>()
  readonly #npm: NpmPackageLocator
  readonly #resolver: NodeResolver
  /** `DENO_DIR/npm`, literally and canonicalised. */
  readonly #npmCacheRoots: readonly string[]
  /** `DENO_DIR/remote`, literally and canonicalised. */
  readonly #remoteCacheRoots: readonly string[]
  readonly #transpiler: Transpiler
  readonly #prefetching = new Set<string>()
  /** npm package directories known to exist (packages do not disappear while an engine lives). */
  readonly #present = new Set<string>()
  /** Resolved npm subpaths by `id\0subpath\0mode` (see {@link DenoCliEngine.#npmFile}). */
  readonly #npmFiles = new Map<string, ResolvedModule>()
  readonly #pending = new Set<Promise<unknown>>()
  #open: OpenBatch | undefined
  /** Serialises `deno info` runs. */
  #chain: Promise<unknown> = Promise.resolve()
  #runs = 0
  #workDir: Promise<string> | undefined
  #lockfile: Promise<string | undefined> | undefined
  #compilerOptions: Promise<Record<string, unknown> | undefined> | undefined
  #disposal: Promise<void> | undefined

  constructor(parts: EngineParts) {
    const { options } = parts
    this.#options = options
    this.#logger = options.logger
    this.#binary = parts.binary
    this.#version = parts.version
    this.#baseEnv = parts.env
    this.#tuning = parts.tuning
    this.#mode = options.project.nodeModulesDir
    this.#root = resolvePath(options.project.root)
    const rootUrl = toFileUrl(this.#root)
    this.#rootUrl = rootUrl.endsWith('/') ? rootUrl : `${rootUrl}/`
    const syntax = HOST_PATH_FLAVOR === 'win32' ? win32 : posix
    this.#npmCacheRoots = withRealpath(parts.dirs.npmCache)
    this.#remoteCacheRoots = withRealpath(
      parts.dirs.denoDir === undefined ? undefined : syntax.join(parts.dirs.denoDir, 'remote'),
    )
    this.#npm = new NpmPackageLocator(() => this.#npmCacheRoots)
    this.#resolver = new NodeResolver({
      platform: options.platform,
      conditions: options.conditions,
      host: { packageFolder: (name, referrer) => this.#packageFolder(name, referrer) },
    })
    this.#transpiler = new Transpiler({
      binary: this.#binary,
      env: () => this.#baseEnv,
      workDir: () => this.#work(),
      compilerOptions: () => this.#rootCompilerOptions(),
      logger: this.#logger,
      batchDelayMs: this.#tuning.batchDelayMs,
      timeoutMs: this.#tuning.transpileTimeoutMs,
    })
  }

  // -- Engine -------------------------------------------------------------------------------------

  async addEntrypoints(entrypoints: readonly string[]): Promise<EngineDiagnostic[]> {
    this.#assertLive('add entrypoints')
    const specifiers = [...new Set(entrypoints.map((entry) => this.#entrypointSpecifier(entry)))]
    if (specifiers.length === 0) return []
    return this.#track(async () => {
      const diagnostics: EngineDiagnostic[] = []
      for (let start = 0; start < specifiers.length; start += MAX_QUERIES) {
        diagnostics.push(...(await this.#addChunk(specifiers.slice(start, start + MAX_QUERIES))))
      }
      return diagnostics
    })
  }

  resolveSync(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): ResolvedModule | undefined {
    this.#assertLive('resolve')
    const step = this.#step(specifier, this.#referrer(specifier, referrer), mode, undefined)
    return 'module' in step ? step.module : undefined
  }

  async resolve(
    specifier: string,
    referrer: string | undefined,
    mode: ResolutionMode,
  ): Promise<ResolvedModule> {
    this.#assertLive('resolve')
    const from = this.#referrer(specifier, referrer)
    const first = this.#step(specifier, from, mode, undefined)
    if ('module' in first) return first.module
    return this.#track(async () => {
      let step: Step = first
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if ('module' in step) return step.module
        if ('unmapped' in step) throw await this.#manualFailure(specifier, from, step.unmapped)
        step = this.#step(specifier, from, mode, await this.#ask(step.miss))
      }
      if ('module' in step) return step.module
      if ('unmapped' in step) throw await this.#manualFailure(specifier, from, step.unmapped)
      throw this.#noAnswer(specifier, from)
    })
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
      if (scheme === 'http' || scheme === 'https') return this.#loadRemote(url, type)
      if (scheme === 'data') return this.#loadData(url, type)
      return this.#loadFile(url, type)
    })
  }

  graph(): unknown {
    this.#assertLive('read the graph')
    return this.#graph.toJSON()
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#release()
    return this.#disposal
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  async #release(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled(this.#pending)
    await this.#transpiler.idle()
    await this.#chain
    const work = this.#workDir
    if (work !== undefined) {
      await rm(await work, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    }
  }

  #assertLive(operation: string): void {
    if (this.#disposal !== undefined) {
      throw new DenoPluginError(
        'ENGINE_UNAVAILABLE',
        `Cannot ${operation}: the deno engine has been disposed.`,
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

  // -- entrypoints --------------------------------------------------------------------------------

  /** An entrypoint as the synthetic root imports it (URLs; paths relative to the project root). */
  #entrypointSpecifier(entry: string): string {
    if (isAbsoluteHostPath(entry)) return toFileUrl(entry)
    if (schemeOf(entry) !== undefined) return entry
    if (/^\.{1,2}(?:[\\/]|$)/.test(entry)) {
      return new URL(entry.replaceAll('\\', '/'), this.#rootUrl).href
    }
    const candidate = resolvePath(this.#root, entry)
    if (isFile(candidate)) return toFileUrl(candidate)
    // A mapped bare specifier: Deno applies the import map.
    return entry
  }

  async #addChunk(specifiers: readonly string[]): Promise<EngineDiagnostic[]> {
    const run = await this.#serial(() =>
      this.#runInfo(specifiers.map((specifier) => ({ specifier }))),
    )
    if (run.failure !== undefined) {
      if (specifiers.length > 1) {
        // One entrypoint can fail the whole run (an integrity error): add them one by one.
        const diagnostics: EngineDiagnostic[] = []
        for (const specifier of specifiers) diagnostics.push(...(await this.#addChunk([specifier])))
        return diagnostics
      }
      const { code } = run.failure
      const coded =
        code === 'CACHED_ONLY_MISS' ||
        code === 'INTEGRITY_MISMATCH' ||
        code === 'ENGINE_UNAVAILABLE'
      return [
        {
          message: `Cannot add entrypoint "${specifiers[0]}": ${run.failure.message}`,
          ...(coded ? { code } : {}),
        },
      ]
    }
    const diagnostics: EngineDiagnostic[] = []
    const roots: string[] = []
    for (const specifier of specifiers) {
      const code = run.answers.get(specifier)?.code
      if (code?.specifier !== undefined) {
        roots.push(code.specifier)
        this.#graph.roots.add(this.#graph.redirect(code.specifier))
      } else if (code?.error !== undefined) {
        diagnostics.push({
          message: `Cannot add entrypoint "${specifier}": ${clean(code.error, run, '<entrypoints>')}`,
        })
      }
    }
    // Like the loader: static imports only, each error located at the import that led to it.
    const reachable = this.#graph.reachable(roots, false)
    const importers = new Map<string, readonly [string, DenoInfoDependency]>()
    for (const url of reachable) {
      for (const dependency of this.#graph.module(url)?.dependencies ?? []) {
        const target = dependency.code?.specifier
        if (target === undefined || dependency.isDynamic === true) continue
        const resolved = this.#graph.redirect(target)
        if (!importers.has(resolved)) importers.set(resolved, [url, dependency])
      }
    }
    const failedPackages: string[] = []
    for (const url of reachable) {
      const module = this.#graph.module(url)
      if (module === undefined) continue
      if (module.error !== undefined) {
        const [importer, dependency] = importers.get(url) ?? []
        diagnostics.push({
          message: located(clean(module.error, run, '<entrypoints>'), importer, dependency),
        })
      }
      for (const dependency of module.dependencies) {
        const error = dependency.code?.error
        if (error === undefined || dependency.isDynamic === true) continue
        diagnostics.push({ message: located(clean(error, run, url), url, dependency) })
        if (this.#mode === 'manual' && isPackageSpecifier(dependency.specifier)) {
          failedPackages.push(dependency.specifier)
        }
      }
    }
    if (failedPackages.length > 0) {
      diagnostics.push(...(await this.#missingPackageDiagnostics(failedPackages)))
    }
    if (this.#options.cachedOnly && run.downloads.length > 0) {
      diagnostics.push({
        code: 'CACHED_ONLY_MISS',
        message:
          `${run.downloads.length} download(s) were refused because \`cachedOnly\` is set ` +
          `(${sample(run.downloads)}). ${HINTS.cachedOnly}`,
      })
    }
    return diagnostics
  }

  /**
   * With `nodeModulesDir: "manual"`, one diagnostic with a code per npm package the graph imports
   * but `node_modules` lacks, named by its import-map target (like the `loader` engine).
   */
  async #missingPackageDiagnostics(specifiers: readonly string[]): Promise<EngineDiagnostic[]> {
    const unique = [...new Set(specifiers)]
    const targets = await this.#importMapTargets(unique)
    const missing = new Set<string>()
    for (const specifier of unique) {
      const requirement = targets.get(specifier) ?? this.#declaredRequirement(specifier, this.#root)
      if (requirement !== undefined) missing.add(withoutSubpath(requirement))
    }
    return [...missing].map((requirement) => ({
      code: 'RESOLVE_NOT_FOUND',
      message: `${requirement} is not installed. ${HINTS.notInstalled}`,
    }))
  }

  // -- resolution ---------------------------------------------------------------------------------

  /**
   * The referrer of a resolution. `undefined` means the project root. A relative specifier needs a
   * `file:` or `http(s):` referrer; other referrers resolve non-relative specifiers from the project
   * root (a `data:` module's own imports first).
   */
  #referrer(specifier: string, referrer: string | undefined): Referrer {
    if (referrer === undefined || referrer === '') {
      return { raw: undefined, url: this.#rootUrl, kind: 'root' }
    }
    let url = referrer
    if (isAbsoluteHostPath(referrer)) url = toFileUrl(referrer)
    else if (schemeOf(referrer) === undefined) url = toFileUrl(resolvePath(this.#root, referrer))
    const scheme = schemeOf(url)
    if (scheme === 'file') {
      const path = toPath(url)
      return { raw: referrer, url, kind: this.#npm.contains(path) ? 'npm' : 'local', path }
    }
    if (scheme === 'http' || scheme === 'https') return { raw: referrer, url, kind: 'remote' }
    if (RELATIVE_OR_ABSOLUTE.test(specifier)) {
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot resolve "${specifier}" from "${referrer}": relative specifiers need a file: or http(s): importer.`,
        { hint: HINTS.relativeFromNonHierarchical, specifier, importer: referrer },
      )
    }
    if (scheme === 'data') return { raw: referrer, url, kind: 'data' }
    return { raw: referrer, url: this.#rootUrl, kind: 'root' }
  }

  /**
   * Resolves as far as the graph allows. `run` is the `deno info` run made for the previous
   * step's misses: a specifier it answered either resolves or throws, and errors it recorded are
   * current (without it, recorded errors may be stale and are asked again).
   */
  #step(specifier: string, from: Referrer, mode: ResolutionMode, run: InfoRun | undefined): Step {
    switch (schemeOf(specifier)) {
      case 'node':
        return done({ kind: 'node', url: specifier, mediaType: 'Unknown' })
      case 'data':
        return done({ kind: 'data', url: specifier, mediaType: mediaTypeFromUrl(specifier) })
      case 'http':
      case 'https':
        return done(this.#remote(specifier))
      // A `jsr:`/`npm:` requirement usually resolves through `redirects`; a linked package (or
      // `nodeModulesDir: "manual"`) resolves straight to a file, recorded as the dependency.
      case 'jsr':
        if (this.#graph.hasRedirect(specifier)) {
          return this.#jsr(specifier, specifier, from, mode, run)
        }
        return this.#fromGraph(specifier, specifier, from, mode, run)
      case 'npm':
        if (this.#mode !== 'manual' && this.#knownNpmPackage(specifier) !== undefined) {
          return this.#npmRequirement(specifier, specifier, from, mode, run)
        }
        return this.#fromGraph(specifier, specifier, from, mode, run)
      case 'file':
        return this.#fromGraph(specifier, specifier, from, mode, run)
      case undefined:
        break
      default:
        return done({ kind: 'external', url: specifier, mediaType: 'Unknown' })
    }
    if (from.kind === 'npm') return this.#fromNode(specifier, from, mode, run)
    if (RELATIVE_OR_ABSOLUTE.test(specifier)) {
      const url = normalizeUrl(new URL(specifier, from.url)) ?? specifier
      if (from.kind === 'remote') return done(this.#remote(url))
      return this.#fromGraph(specifier, url, from, mode, run)
    }
    return this.#fromGraph(specifier, specifier, from, mode, run)
  }

  /**
   * Resolves `specifier` through the graph: the referrer's own import (exact Deno semantics, import
   * map scopes included), an earlier root-level answer, then the answer of `run`. A miss asks Deno
   * for `query` (the specifier, or its absolute URL) and queries a local referrer again.
   */
  #fromGraph(
    specifier: string,
    query: string,
    from: Referrer,
    mode: ResolutionMode,
    run: InfoRun | undefined,
  ): Step {
    const own = from.kind === 'root' ? undefined : this.#graph.dependency(from.url, specifier)?.code
    if (own?.specifier !== undefined) return this.#target(own.specifier, specifier, from, mode, run)
    if (own?.error !== undefined && this.#fresh(this.#graph.redirect(from.url), run)) {
      return this.#failure(specifier, from, own.error, run)
    }
    const key = `${from.url}\0${specifier}`
    const known = this.#answers.get(key)
    if (known !== undefined) return this.#target(known, specifier, from, mode, run)
    const answer = run?.answers.get(query)?.code
    if (answer?.specifier !== undefined) {
      this.#answers.set(key, answer.specifier)
      return this.#target(answer.specifier, specifier, from, mode, run)
    }
    if (answer?.error !== undefined) return this.#failure(specifier, from, answer.error, run)
    // An existing file needs no Deno (sloppy imports only map missing files).
    if (query.startsWith('file:')) {
      const path = toPath(query)
      if (isFile(path)) return done(this.#fileTarget(path, specifier, query, mode))
    }
    if (run !== undefined && (run.failure !== undefined || run.answers.has(query))) {
      throw this.#noAnswer(specifier, from, run)
    }
    const queries: Query[] = [{ specifier: query }]
    // Bare, relative and `#` imports depend on the importer (scopes, package.json): query it too.
    const scheme = schemeOf(specifier)
    const importerDependent = scheme === undefined || scheme === 'file'
    if (importerDependent && from.kind === 'local' && !/[?#]/.test(from.url)) {
      queries.push({ specifier: from.url })
    }
    return { miss: queries }
  }

  /** Continues with what Deno resolved `specifier` to. */
  #target(
    target: string,
    specifier: string,
    from: Referrer,
    mode: ResolutionMode,
    run: InfoRun | undefined,
  ): Step {
    switch (schemeOf(target)) {
      case 'jsr':
        return this.#jsr(target, specifier, from, mode, run)
      case 'npm':
        return this.#npmRequirement(target, specifier, from, mode, run)
      case 'http':
      case 'https':
        return done(this.#remote(target))
      case 'file':
        return done(this.#fileTarget(toPath(target), specifier, target, mode))
      case 'node':
        return done({ kind: 'node', url: target, mediaType: 'Unknown' })
      case 'data':
        return done({ kind: 'data', url: target, mediaType: mediaTypeFromUrl(target) })
      default:
        return done({ kind: 'external', url: target, mediaType: 'Unknown' })
    }
  }

  /** A `jsr:` requirement: its redirect (to `https://jsr.io/…`, or a linked package's files). */
  #jsr(
    requirement: string,
    specifier: string,
    from: Referrer,
    mode: ResolutionMode,
    run: InfoRun | undefined,
  ): Step {
    if (this.#graph.hasRedirect(requirement)) {
      const target = this.#graph.redirect(requirement)
      if (schemeOf(target) !== 'jsr') return this.#target(target, specifier, from, mode, run)
    }
    const recorded = this.#graph.module(requirement)?.error
    const error =
      (recorded !== undefined && this.#fresh(requirement, run) ? recorded : undefined) ??
      run?.answers.get(requirement)?.code?.error
    if (error !== undefined) throw this.#requirementError(requirement, specifier, from, error, run)
    if (run !== undefined && (run.failure !== undefined || run.answers.has(requirement))) {
      throw this.#noAnswer(specifier, from, run)
    }
    return { miss: [{ specifier: requirement }] }
  }

  /**
   * An `npm:` requirement (`nodeModulesDir` `none` or `auto`): its package, then Node rules. A
   * package Deno knows (from the lockfile) but did not download or install is asked about again
   * once, then reported.
   */
  #npmRequirement(
    requirement: string,
    specifier: string,
    from: Referrer,
    mode: ResolutionMode,
    run: InfoRun | undefined,
  ): Step {
    const known = this.#knownNpmPackage(requirement)
    if (known !== undefined && !this.#isAbsent(known.npmPackage)) {
      return done(this.#npmFile(known.npmPackage, known.subpath, specifier, from, mode))
    }
    const target = this.#graph.redirect(requirement)
    const recordedAt = this.#graph.module(target) === undefined ? requirement : target
    const recorded = this.#graph.module(recordedAt)?.error
    const error =
      (recorded !== undefined && this.#fresh(recordedAt, run) ? recorded : undefined) ??
      run?.answers.get(requirement)?.code?.error
    if (error !== undefined) throw this.#requirementError(requirement, specifier, from, error, run)
    if (run !== undefined && (run.failure !== undefined || run.answers.has(requirement))) {
      if (known === undefined || run.failure !== undefined)
        throw this.#noAnswer(specifier, from, run)
      throw this.#absentPackageError(known.npmPackage, requirement, specifier, from, run)
    }
    return { miss: [{ specifier: requirement }] }
  }

  /** Whether Deno reported a directory for `npmPackage` that does not exist (not downloaded). */
  #isAbsent(npmPackage: DenoInfoNpmPackage): boolean {
    const { localPath } = npmPackage
    if (localPath === undefined || this.#present.has(localPath)) return false
    if (!existsSync(localPath)) return true
    this.#present.add(localPath)
    return false
  }

  /** The error for an npm package Deno knows but did not download or install. */
  #absentPackageError(
    npmPackage: DenoInfoNpmPackage,
    requirement: string,
    specifier: string,
    from: Referrer,
    run: InfoRun,
  ): DenoPluginError {
    const where = from.raw === undefined ? '' : ` from "${from.raw}"`
    const options = { specifier, importer: from.raw }
    if (this.#options.cachedOnly && refusedFor(requirement, run)) {
      return new DenoPluginError(
        'CACHED_ONLY_MISS',
        `Cannot resolve "${specifier}"${where}: npm package ${npmPackage.id} is not in the Deno cache and \`cachedOnly\` is set.`,
        { ...options, hint: HINTS.cachedOnly },
      )
    }
    return new DenoPluginError(
      'RESOLVE_FAILED',
      `Cannot resolve "${specifier}"${where}: Deno did not download npm package ${npmPackage.id} (${npmPackage.localPath ?? 'no path'} does not exist).`,
      {
        ...options,
        hint: 'Check the network connection; `deno install` reports the same problem.',
      },
    )
  }

  /**
   * The package of an `npm:` requirement if the graph knows it: through its redirect
   * (`npm:kleur@^4/colors` → `npm:/kleur@4.1.5/colors`), the redirect of the requirement without
   * subpath (the version does not depend on the subpath), or an exact version in the graph.
   */
  #knownNpmPackage(
    requirement: string,
  ): { npmPackage: DenoInfoNpmPackage; subpath: string } | undefined {
    const parsed = parsePackageSpecifier(requirement)
    if (parsed?.scheme !== 'npm') return undefined
    const base = `${parsed.name}${parsed.version === undefined ? '' : `@${parsed.version}`}`
    const candidates: ReadonlyArray<readonly [string, string | undefined]> = [
      [requirement, undefined],
      [`npm:${base}`, parsed.subpath],
      [`npm:/${base}`, parsed.subpath],
    ]
    for (const [from, subpath] of candidates) {
      if (!this.#graph.hasRedirect(from)) continue
      const target = this.#graph.redirect(from)
      const resolved = parsePackageSpecifier(target)
      if (resolved?.scheme !== 'npm' || resolved.version === undefined) continue
      const id = this.#graph.module(target)?.npmPackage
      const npmPackage =
        (id === undefined ? undefined : this.#graph.npmPackage(id)) ??
        this.#graph.npmPackagesByVersion(resolved.name, resolved.version)[0]
      if (npmPackage !== undefined) return { npmPackage, subpath: subpath ?? resolved.subpath }
    }
    if (parsed.version !== undefined && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(parsed.version)) {
      const [npmPackage] = this.#graph.npmPackagesByVersion(parsed.name, parsed.version)
      if (npmPackage !== undefined) return { npmPackage, subpath: parsed.subpath }
    }
    return undefined
  }

  /**
   * The file for `subpath` of an npm package (Node rules with the engine's conditions), memoised:
   * installed packages do not change while an engine lives.
   */
  #npmFile(
    npmPackage: DenoInfoNpmPackage,
    subpath: string,
    specifier: string,
    from: Referrer,
    mode: ResolutionMode,
  ): ResolvedModule {
    const key = `${npmPackage.id}\0${subpath}\0${mode}`
    const cached = this.#npmFiles.get(key)
    if (cached !== undefined) return cached
    const { localPath } = npmPackage
    if (localPath === undefined) {
      throw new DenoPluginError(
        'ENGINE_UNAVAILABLE',
        `Deno ${this.#version} did not report where the npm package ${npmPackage.id} is (\`npmPackages[*].localPath\` of \`deno info --json\`).`,
        { hint: "Use Deno 2.8.3 or later, or `engine: 'loader'`.", specifier },
      )
    }
    let path: string
    try {
      path = this.#resolver.resolvePackage(localPath, subpath, mode)
    } catch (error) {
      throw this.#nodeError(error, specifier, from, undefined)
    }
    const module = this.#classifyFile(
      path,
      `npm:${npmPackage.name}@${npmPackage.version}${subpath}`,
    )
    this.#npmFiles.set(key, module)
    return module
  }

  /**
   * A file Deno resolved to. With `nodeModulesDir: "manual"` Deno resolves npm packages in
   * `node_modules` itself, with its runtime conditions; when the specifier names the package, the
   * engine resolves its subpath again with its own platform and conditions.
   */
  #fileTarget(
    path: string,
    specifier: string,
    target: string,
    mode: ResolutionMode,
  ): ResolvedModule {
    const named = schemeOf(specifier) === undefined || schemeOf(specifier) === 'npm'
    if (this.#mode === 'manual' && named && this.#npm.contains(path) && !this.#inNpmCache(path)) {
      const requested = parsePackageSpecifier(specifier)
      if (requested !== undefined && requested.scheme !== 'jsr') {
        const found = this.#npm.find(canonicalize(path).path, requested.name)
        if (found !== undefined && found.name === requested.name) {
          try {
            return this.#classifyFile(
              this.#resolver.resolvePackage(found.dir, requested.subpath, mode),
              specifier,
            )
          } catch {
            // Keep Deno's answer.
          }
        }
      }
    }
    return this.#classifyFile(path, named ? specifier : target)
  }

  /** A specifier imported by a file of an npm package: Node rules. */
  #fromNode(
    specifier: string,
    from: Referrer,
    mode: ResolutionMode,
    run: InfoRun | undefined,
  ): Step {
    const path = from.path ?? ''
    let resolution: NodeResolution
    try {
      resolution = this.#resolver.resolve(specifier, path, mode)
    } catch (error) {
      if (!(error instanceof UnknownPackageError))
        throw this.#nodeError(error, specifier, from, path)
      if (run !== undefined && (run.failure !== undefined || run.answers.has(error.requirement))) {
        throw this.#noAnswer(specifier, from, run)
      }
      return { miss: [{ specifier: error.requirement }] }
    }
    switch (resolution.kind) {
      case 'builtin':
        return done({ kind: 'node', url: resolution.specifier, mediaType: 'Unknown' })
      case 'url':
        return done({
          kind: 'data',
          url: resolution.url,
          mediaType: mediaTypeFromUrl(resolution.url),
        })
      default:
        return done(this.#classifyFile(resolution.path, specifier))
    }
  }

  /**
   * The directory of package `name` for a bare import in `referrerPath` (the Node resolver's
   * host). Global-cache packages are flat, so dependencies come from the graph's `npmPackages`: the
   * package's dependencies (by name, or by an `npm:` alias in its `package.json`), itself, then any
   * version of that name (Deno's fallback for undeclared dependencies). Elsewhere `node_modules`
   * directories are searched upwards.
   *
   * @throws {UnknownPackageError} When a global-cache referrer's package is not in the graph.
   */
  #packageFolder(name: string, referrerPath: string): string | undefined {
    if (this.#inNpmCache(referrerPath)) {
      const owner = this.#graph.npmPackageContaining(referrerPath)
      if (owner !== undefined) return this.#dependencyFolder(owner, name)
      const requirement = this.#cachePackageRequirement(referrerPath)
      if (requirement !== undefined) throw new UnknownPackageError(requirement)
      return undefined
    }
    const syntax = HOST_PATH_FLAVOR === 'win32' ? win32 : posix
    let dir = syntax.dirname(referrerPath)
    for (;;) {
      if (syntax.basename(dir) !== 'node_modules') {
        const candidate = syntax.join(dir, 'node_modules', ...name.split('/'))
        if (isDirectory(candidate)) return realpathMaybeMissing(candidate)
      }
      const parent = syntax.dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
  }

  /** The folder of the dependency `name` of a global-cache package (see {@link #packageFolder}). */
  #dependencyFolder(owner: DenoInfoNpmPackage, name: string): string | undefined {
    const dependencies = owner.dependencies
      .map((id) => this.#graph.npmPackage(id))
      .filter((dependency) => dependency !== undefined)
    const direct = dependencies.find((dependency) => dependency.name === name)
    if (direct?.localPath !== undefined) return direct.localPath
    const manifest =
      owner.localPath === undefined ? undefined : this.#resolver.packageJson(owner.localPath)
    const declared =
      manifest?.dependencies[name] ??
      manifest?.optionalDependencies[name] ??
      manifest?.peerDependencies[name]
    const alias = declared === undefined ? undefined : parsePackageSpecifier(declared)
    if (alias?.scheme === 'npm') {
      const aliased = dependencies.find((dependency) => dependency.name === alias.name)
      if (aliased?.localPath !== undefined) return aliased.localPath
    }
    if (owner.name === name && owner.localPath !== undefined) return owner.localPath
    return this.#graph
      .npmPackagesNamed(name)
      .find((npmPackage) => npmPackage.localPath !== undefined)?.localPath
  }

  /** `npm:<name>@<version>` of a global-cache path (`<registry>/<name>/<version>[_n]/…`). */
  #cachePackageRequirement(path: string): string | undefined {
    const syntax = HOST_PATH_FLAVOR === 'win32' ? win32 : posix
    for (const root of this.#npmCacheRoots) {
      if (!isSubpath(root, path)) continue
      const segments = syntax.relative(root, path).split(syntax.sep)
      const scoped = segments[1]?.startsWith('@') === true
      const name = scoped ? `${segments[1]}/${segments[2]}` : segments[1]
      const version = (scoped ? segments[3] : segments[2])?.replace(/_\d+$/, '')
      if (name !== undefined && version !== undefined) return `npm:${name}@${version}`
    }
    return undefined
  }

  #inNpmCache(path: string): boolean {
    return this.#npmCacheRoots.some((root) => isSubpath(root, path))
  }

  /** Whether the graph entry of `specifier` comes from `run` (so its errors are current). */
  #fresh(specifier: string, run: InfoRun | undefined): boolean {
    return run !== undefined && this.#graph.recordedBy(specifier) === run.id
  }

  #remote(url: string): ResolvedModule {
    const final = this.#graph.redirect(url)
    return { kind: 'remote', url: final, mediaType: mediaTypeFromUrl(final) }
  }

  /** A resolved file: `local`, or `npm` with its package (as in the `loader` engine). */
  #classifyFile(path: string, specifier: string): ResolvedModule {
    if (!this.#npm.contains(path)) {
      return { kind: 'local', url: toFileUrl(path), path, mediaType: mediaTypeFromPath(path) }
    }
    const real = canonicalize(path).path
    const requested = parsePackageSpecifier(specifier)
    const expected = requested?.scheme === 'jsr' ? undefined : requested
    const found = this.#npm.find(real, expected?.name)
    const module: ResolvedModule = {
      kind: 'npm',
      url: toFileUrl(real),
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

  // -- errors -------------------------------------------------------------------------------------

  /**
   * A specifier Deno could not resolve (`detail` is its explanation). These are resolution errors
   * of the import itself (import map, `package.json`, `node_modules`), never download failures,
   * which Deno records on the module of the `jsr:`/`npm:` requirement instead.
   */
  #failure(specifier: string, from: Referrer, detail: string, run: InfoRun | undefined): Step {
    const message = clean(detail, run, this.#referrerName(from))
    if (this.#mode === 'manual' && isBareSpecifier(specifier)) return { unmapped: message }
    throw unresolvedRequirementError(specifier, {
      specifier,
      referrer: from.raw,
      detail: message,
      userInstalledNpm: this.#mode === 'manual',
    })
  }

  /** A `jsr:`/`npm:` requirement Deno could not resolve (no version, unknown package or export). */
  #requirementError(
    requirement: string,
    specifier: string,
    from: Referrer,
    detail: string,
    run: InfoRun | undefined,
  ): DenoPluginError {
    return unresolvedRequirementError(requirement, {
      specifier,
      referrer: from.raw,
      detail: clean(detail, run, this.#referrerName(from)),
      cachedOnlyMiss: this.#options.cachedOnly && refusedFor(requirement, run),
      userInstalledNpm: this.#mode === 'manual',
    })
  }

  /** Deno gave no answer for `specifier`: the run failed, or its output lacks it. */
  #noAnswer(specifier: string, from: Referrer, run?: InfoRun): DenoPluginError {
    if (run?.failure !== undefined) return run.failure
    const where = from.raw === undefined ? '' : ` from "${from.raw}"`
    return new DenoPluginError(
      'RESOLVE_FAILED',
      `Cannot resolve "${specifier}"${where}: \`deno info\` did not report it.`,
      {
        specifier,
        importer: from.raw,
        hint: 'Run `deno info` on the importing module to see why.',
      },
    )
  }

  /**
   * The error for a bare specifier that failed with `nodeModulesDir: "manual"`: a missing package
   * when its import-map target is an `npm:` requirement or `package.json` declares it, otherwise
   * an unmapped bare specifier.
   */
  async #manualFailure(
    specifier: string,
    from: Referrer,
    detail: string,
  ): Promise<DenoPluginError> {
    const dir = from.path === undefined ? this.#root : dirnameOf(from.path)
    const requirement =
      (await this.#importMapTargets([specifier])).get(specifier) ??
      this.#declaredRequirement(specifier, dir)
    return unresolvedRequirementError(requirement ?? specifier, {
      specifier,
      referrer: from.raw,
      detail:
        requirement === undefined
          ? detail
          : `${withoutSubpath(requirement)} is not installed (${detail})`,
      userInstalledNpm: true,
    })
  }

  /**
   * The `npm:` requirements the import map gives `specifiers`: a `deno info --no-npm` run, which
   * stops at the import map (used only after failures with `nodeModulesDir: "manual"`).
   */
  async #importMapTargets(specifiers: readonly string[]): Promise<Map<string, string>> {
    const targets = new Map<string, string>()
    const bare: string[] = []
    for (const specifier of specifiers) {
      if (parsePackageSpecifier(specifier)?.scheme === 'npm') targets.set(specifier, specifier)
      else if (isBareSpecifier(specifier)) bare.push(specifier)
    }
    if (bare.length === 0) return targets
    const run = await this.#serial(() =>
      this.#runInfo(
        bare.map((specifier) => ({ specifier })),
        { noNpm: true, record: false },
      ),
    )
    for (const specifier of bare) {
      const target = run.answers.get(specifier)?.code?.specifier
      if (target !== undefined && parsePackageSpecifier(target)?.scheme === 'npm') {
        targets.set(specifier, target)
      }
    }
    return targets
  }

  /** `npm:<name>@<range>` when the `package.json` closest to `dir` declares the bare `specifier`. */
  #declaredRequirement(specifier: string, dir: string): string | undefined {
    const parsed = parsePackageSpecifier(specifier)
    if (parsed?.scheme !== 'bare') return undefined
    const manifest = this.#resolver.closestPackageJson(dir)
    const range =
      manifest?.dependencies[parsed.name] ??
      manifest?.optionalDependencies[parsed.name] ??
      manifest?.peerDependencies[parsed.name]
    return range === undefined ? undefined : `npm:${parsed.name}@${range}${parsed.subpath}`
  }

  /** Maps a Node resolution failure (inside or of an npm package) to a {@link DenoPluginError}. */
  #nodeError(
    error: unknown,
    specifier: string,
    from: Referrer,
    referrerPath: string | undefined,
  ): DenoPluginError {
    if (error instanceof DenoPluginError) return error
    const where = from.raw === undefined ? '' : ` from "${from.raw}"`
    const detail = error instanceof Error ? error.message : String(error)
    const message = `Cannot resolve "${specifier}"${where}: ${detail}`
    const options = { specifier, importer: from.raw, cause: error }
    if (!isNodeResolutionError(error))
      return new DenoPluginError('RESOLVE_FAILED', message, options)
    switch (error.code) {
      case 'ERR_MODULE_NOT_FOUND': {
        if (
          this.#options.cachedOnly &&
          error.path !== undefined &&
          this.#isUndownloaded(error.path)
        ) {
          return new DenoPluginError(
            'CACHED_ONLY_MISS',
            `Cannot resolve "${specifier}"${where}: its npm package is not in the Deno cache and \`cachedOnly\` is set.`,
            { ...options, hint: HINTS.cachedOnly },
          )
        }
        const optional =
          error.packageName !== undefined &&
          referrerPath !== undefined &&
          this.#isOptionalDependency(error.packageName, referrerPath)
        return new EngineResolveError('RESOLVE_NOT_FOUND', message, {
          ...options,
          hint: optional ? HINTS.optionalDependency : HINTS.notFound,
          isOptionalDependency: optional,
        })
      }
      case 'ERR_PACKAGE_PATH_NOT_EXPORTED':
        return new DenoPluginError('RESOLVE_NOT_EXPORTED', message, {
          ...options,
          hint: HINTS.notExported,
        })
      default:
        return new DenoPluginError('RESOLVE_FAILED', message, options)
    }
  }

  /**
   * Whether `path` is a missing file in a package location Deno manages (the global npm cache, or
   * `node_modules/.deno/` for `nodeModulesDir: "auto"`), i.e. a package it did not download.
   */
  #isUndownloaded(path: string): boolean {
    const managed = this.#inNpmCache(path) || /(?:^|[\\/])node_modules[\\/]\.deno[\\/]/.test(path)
    return managed && !existsSync(path)
  }

  /** Whether the package of `referrerPath` declares `name` as an optional (peer) dependency. */
  #isOptionalDependency(name: string, referrerPath: string): boolean {
    const manifest = this.#resolver.closestPackageJson(dirnameOf(referrerPath))
    return (
      manifest !== undefined &&
      (Object.hasOwn(manifest.optionalDependencies, name) || manifest.optionalPeers.has(name))
    )
  }

  /** How messages name the referrer where Deno named the synthetic root. */
  #referrerName(from: Referrer): string {
    return from.kind === 'root' ? this.#rootUrl : from.url
  }

  // -- loading ------------------------------------------------------------------------------------

  async #loadRemote(url: string, type: LoadType): Promise<LoadedModule> {
    let final = this.#graph.redirect(url)
    let module = this.#graph.module(final)
    let run: InfoRun | undefined
    if (module?.local === undefined) {
      // Not downloaded yet: as a module, or raw (`bytes` also fetches files Deno cannot parse).
      const attributes: ReadonlyArray<Query['attribute']> =
        type === 'default' ? [undefined, 'bytes'] : [type === 'json' ? 'json' : 'bytes']
      for (const attribute of attributes) {
        run = await this.#ask([{ specifier: url, attribute }])
        final = this.#graph.redirect(url)
        module = this.#graph.module(final)
        if (module?.local !== undefined) break
        // A refused download fails the same way as raw bytes.
        if (this.#options.cachedOnly && run.downloads.includes(url)) break
      }
    }
    const local = module?.local
    if (local === undefined) {
      const refused = run?.downloads.some((download) => download === url || download === final)
      if (this.#options.cachedOnly && refused === true) {
        throw new DenoPluginError(
          'CACHED_ONLY_MISS',
          `Cannot load "${url}": it is not in the Deno cache and \`cachedOnly\` is set.`,
          { hint: HINTS.cachedOnly, specifier: url },
        )
      }
      const detail = module?.error ?? run?.answers.get(url)?.code?.error
      if (detail === undefined && run?.failure !== undefined) throw run.failure
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot load "${url}": ${detail === undefined ? 'Deno did not download it.' : clean(detail, run, url)}`,
        { specifier: url, hint: 'Check the URL; `deno info <url>` reports the same problem.' },
      )
    }
    let content: Uint8Array
    let contentType: string | undefined
    try {
      const bytes = await readFile(local)
      const cached = splitCacheFile(bytes)
      if (cached === undefined && this.#inRemoteCache(local)) {
        throw new Error('the cache entry has no `denoCacheMetadata` line')
      }
      content = cached?.content ?? bytes
      contentType = cached?.headers['content-type']
    } catch (error) {
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot load "${final}" from the Deno cache (${local}): ${error instanceof Error ? error.message : String(error)}`,
        { specifier: url, hint: `Run \`deno cache --reload ${final}\`.`, cause: error },
      )
    }
    const mediaType =
      toMediaType(module?.mediaType) ??
      (contentType === undefined
        ? mediaTypeFromUrl(final)
        : mediaTypeFromContentType(contentType, final))
    if (transpiles(mediaType, type) && !this.#transpiler.has(final)) await this.#prefetch(final)
    return this.#loaded(final, mediaType, content, type)
  }

  async #loadData(url: string, type: LoadType): Promise<LoadedModule> {
    const content = decodeDataUrl(url)
    if (content === undefined) {
      throw new DenoPluginError('RESOLVE_FAILED', `Cannot load "${url}": invalid data: URL.`, {
        specifier: url,
      })
    }
    return this.#loaded(url, mediaTypeFromUrl(url), content, type)
  }

  async #loadFile(url: string, type: LoadType): Promise<LoadedModule> {
    const path = schemeOf(url) === 'file' ? toPath(url) : resolvePath(this.#root, url)
    let content: Uint8Array
    try {
      content = await readFile(path)
    } catch (error) {
      throw new DenoPluginError(
        'RESOLVE_FAILED',
        `Cannot load "${url}": ${error instanceof Error ? error.message : String(error)}`,
        { specifier: url, hint: 'Check that the module exists at that path or URL.', cause: error },
      )
    }
    return this.#loaded(toFileUrl(path), mediaTypeFromPath(path), content, type)
  }

  /** A loaded module: TypeScript and JSX transpiled (`default`/`json`), everything else as is. */
  async #loaded(
    url: string,
    mediaType: MediaType,
    content: Uint8Array,
    type: LoadType,
  ): Promise<LoadedModule> {
    if (transpiles(mediaType, type)) {
      let output: TranspileOutput
      try {
        output = await this.#transpiler.transpile({ url, mediaType, source: content })
      } catch (error) {
        throw new DenoPluginError(
          'RESOLVE_FAILED',
          `Cannot load "${url}": ${error instanceof TranspileError ? error.message : String(error)}`,
          { specifier: url, cause: error },
        )
      }
      return {
        kind: 'module',
        url,
        mediaType,
        code: output.code,
        bytes: encoder.encode(output.code),
        map: output.map,
      }
    }
    if ((type === 'default' || type === 'json') && DECLARATION_MEDIA_TYPES.has(mediaType)) {
      // Declaration files have no runtime code.
      return { kind: 'module', url, mediaType, code: '', bytes: new Uint8Array() }
    }
    return { kind: 'module', url, mediaType, code: decoder.decode(content), bytes: content }
  }

  /**
   * Queues the not yet transpiled TypeScript/JSX modules `url` imports (transitively) for the same
   * `deno transpile` run: a module is loaded to be mirrored, and mirroring loads its dependencies.
   */
  async #prefetch(url: string): Promise<void> {
    const reads: Array<Promise<TranspileItem | undefined>> = []
    const claimed: string[] = []
    for (const dependency of this.#graph.reachable([url], true)) {
      if (reads.length >= MAX_PREFETCH) break
      if (dependency === url || this.#transpiler.has(dependency)) continue
      if (this.#prefetching.has(dependency)) continue
      const scheme = schemeOf(dependency)
      if (scheme !== 'http' && scheme !== 'https') continue
      const module = this.#graph.module(dependency)
      const mediaType = toMediaType(module?.mediaType)
      const local = module?.local
      if (local === undefined || mediaType === undefined || !needsTranspile(mediaType)) continue
      this.#prefetching.add(dependency)
      claimed.push(dependency)
      reads.push(
        readFile(local).then(
          (bytes) => {
            const cached = splitCacheFile(bytes)
            return cached === undefined
              ? undefined
              : { url: dependency, mediaType, source: cached.content }
          },
          () => undefined,
        ),
      )
    }
    const items = (await Promise.all(reads)).filter((item) => item !== undefined)
    this.#transpiler.queue(items)
    for (const dependency of claimed) this.#prefetching.delete(dependency)
  }

  #inRemoteCache(path: string): boolean {
    return this.#remoteCacheRoots.some((root) => isSubpath(root, path))
  }

  // -- deno info ----------------------------------------------------------------------------------

  /**
   * Resolves `queries` in the next batch: requests made within
   * {@link DenoCliEngineTuning.batchDelayMs} share one `deno info` run.
   */
  #ask(queries: readonly Query[]): Promise<InfoRun> {
    const open = this.#open
    if (open !== undefined && queries.some((query) => conflicts(open, query))) {
      // The same specifier with another import attribute: ask in the next batch.
      return open.promise.then(() => this.#ask(queries))
    }
    const batch = open ?? this.#openBatch()
    for (const query of queries) batch.queries.set(query.specifier, query)
    if (batch.queries.size >= MAX_QUERIES) this.#flush(batch)
    return batch.promise
  }

  #openBatch(): OpenBatch {
    let resolve!: (run: InfoRun) => void
    const promise = new Promise<InfoRun>((settle) => {
      resolve = settle
    })
    const batch: OpenBatch = { queries: new Map(), promise, resolve }
    this.#open = batch
    // Not unref'd: a pending resolution must keep the process alive.
    setTimeout(() => this.#flush(batch), this.#tuning.batchDelayMs)
    return batch
  }

  #flush(batch: OpenBatch): void {
    if (this.#open !== batch) return
    this.#open = undefined
    this.#serial(() => this.#runInfo([...batch.queries.values()])).then(batch.resolve, (error) =>
      batch.resolve(this.#failedRun(this.#unexpected(error), '')),
    )
  }

  /** Runs `task` after the previous `deno info` run finished. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(task, task)
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #failedRun(
    failure: DenoPluginError,
    rootUrl: string,
    downloads: readonly string[] = [],
  ): InfoRun {
    return { id: 0, answers: new Map(), downloads, failure, rootUrl }
  }

  #unexpected(error: unknown): DenoPluginError {
    return new DenoPluginError(
      'RESOLVE_FAILED',
      `\`deno info\` failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  /**
   * One `deno info --json` run over a synthetic root importing `queries`; the output is merged into
   * the graph (unless `record` is false). Never rejects: failures are in {@link InfoRun.failure}.
   */
  async #runInfo(
    queries: readonly Query[],
    { noNpm = false, record = true }: { noNpm?: boolean; record?: boolean } = {},
  ): Promise<InfoRun> {
    const started = performance.now()
    const id = ++this.#runs
    let rootPath: string
    try {
      rootPath = join(await this.#work(), `root-${id}.mjs`)
      await writeFile(rootPath, `${queries.map(importLine).join('\n')}\n`)
    } catch (error) {
      return this.#failedRun(
        new DenoPluginError(
          'ENGINE_UNAVAILABLE',
          `The deno engine cannot write its temporary files: ${error instanceof Error ? error.message : String(error)}`,
          { hint: 'Check that the OS temporary directory is writable.', cause: error },
        ),
        '',
      )
    }
    const rootUrl = toFileUrl(rootPath)
    const args = ['info', '--json', '--allow-import', ...(await this.#graphArgs())]
    if (noNpm) args.push('--no-npm')
    args.push(rootPath)
    let result: DenoRunResult
    try {
      result = await runDeno(this.#binary, args, {
        cwd: this.#root,
        env: this.#env(),
        timeoutMs: this.#tuning.infoTimeoutMs,
      })
    } catch (error) {
      const missing = error instanceof DenoSpawnError && error.code === 'ENOENT'
      return this.#failedRun(
        new DenoPluginError(
          'ENGINE_UNAVAILABLE',
          missing
            ? `The Deno CLI (\`${this.#binary}\`) is no longer available.`
            : `Cannot run \`${this.#binary} info\`: ${error instanceof Error ? error.message : String(error)}`,
          { hint: "Check the Deno installation, or use `engine: 'loader'`.", cause: error },
        ),
        rootUrl,
      )
    } finally {
      await rm(rootPath, { force: true }).catch(() => {})
    }
    const stderr = parseDenoStderr(result.stderr)
    for (const url of stderr.downloads) this.#logger.downloading(url)
    for (const installed of stderr.installed) this.#logger.debug(`[engine] Installed ${installed}`)
    for (const warning of stderr.warnings) this.#logger.debug(`[engine] ${warning}`)
    this.#logger.debug(
      `[engine] deno info: ${queries.length} import(s) in ${Math.round(performance.now() - started)} ms` +
        `${result.exitCode === 0 ? '' : ` (exit code ${String(result.exitCode)})`}`,
    )
    if (result.exitCode !== 0) {
      return this.#failedRun(this.#runFailure(result, stderr, rootUrl), rootUrl, stderr.downloads)
    }
    let output: DenoInfoOutput
    try {
      output = parseDenoInfo(result.stdout.toString('utf8'))
    } catch (error) {
      const detail = error instanceof DenoInfoFormatError ? error.message : String(error)
      return this.#failedRun(
        new DenoPluginError(
          'ENGINE_UNAVAILABLE',
          `Deno ${this.#version} printed \`deno info --json\` output the deno engine does not understand: ${detail}.`,
          {
            hint: "Use `engine: 'loader'` (and report the Deno version), or another Deno version.",
            cause: error,
          },
        ),
        rootUrl,
        stderr.downloads,
      )
    }
    // The root as Deno spells it (its only root; a Windows drive letter may differ in case).
    const reportedRoot = output.roots.length === 1 ? (output.roots[0] ?? rootUrl) : rootUrl
    if (record) this.#graph.merge(output, id, new Set([rootUrl, reportedRoot]))
    const root = output.modules.find((module) => module.specifier === reportedRoot)
    return {
      id,
      answers: new Map(
        (root?.dependencies ?? []).map((dependency) => [dependency.specifier, dependency]),
      ),
      downloads: stderr.downloads,
      failure: undefined,
      rootUrl: reportedRoot,
    }
  }

  /** The error of a `deno info` run that did not exit with code 0. */
  #runFailure(result: DenoRunResult, stderr: DenoStderr, rootUrl: string): DenoPluginError {
    const [specifier] = stderr.specifiers
    const detail = (stderr.error || `exit code ${String(result.exitCode)}`).replaceAll(
      rootUrl,
      '<entrypoints>',
    )
    if (result.timedOut) {
      return new DenoPluginError(
        'RESOLVE_FAILED',
        `\`deno info\` did not finish within ${Math.round(this.#tuning.infoTimeoutMs / 1000)} s and was stopped.`,
        { hint: 'Check the network connection and proxy settings.' },
      )
    }
    if (result.exitCode === INTEGRITY_EXIT_CODE) {
      return new DenoPluginError('INTEGRITY_MISMATCH', `Deno refused a module: ${detail}`, {
        specifier,
        hint: 'The remote module changed. Check the source, then update deno.lock (`deno cache --reload` or `deno install`).',
      })
    }
    if (this.#options.cachedOnly && stderr.downloads.length > 0) {
      return new DenoPluginError(
        'CACHED_ONLY_MISS',
        `A module is not in the Deno cache and \`cachedOnly\` is set (${sample(stderr.downloads)}): ${detail}`,
        { specifier, hint: HINTS.cachedOnly },
      )
    }
    return new DenoPluginError('RESOLVE_FAILED', `\`deno info\` failed: ${detail}`, {
      specifier,
      hint: 'Run `deno info` on the entrypoint to see the problem; check deno.json and deno.lock.',
    })
  }

  /** `--config`, `--lock`, `--node-modules-dir` and the unstable flags of every `deno info`. */
  async #graphArgs(): Promise<string[]> {
    const { project } = this.#options
    const lockfile = await this.#lockfileCopy()
    return [
      ...(project.configPath === undefined ? ['--no-config'] : ['--config', project.configPath]),
      ...(lockfile === undefined ? ['--no-lock'] : ['--lock', lockfile]),
      `--node-modules-dir=${this.#mode}`,
      // Like the loader: extensionless local imports, and text/bytes/css imports in the graph.
      '--unstable-sloppy-imports',
      '--unstable-raw-imports',
    ]
  }

  /** The environment of `deno info` runs; with `cachedOnly`, a proxy that refuses every download. */
  #env(): NodeJS.ProcessEnv {
    const env = denoEnv(this.#baseEnv)
    if (this.#options.cachedOnly) {
      for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
        env[name] = CACHED_ONLY_PROXY
        env[name.toLowerCase()] = CACHED_ONLY_PROXY
      }
      delete env.NO_PROXY
      delete env.no_proxy
    }
    return env
  }

  /** The engine's private temporary directory (created on first use, removed on dispose). */
  #work(): Promise<string> {
    this.#workDir ??= mkdtemp(join(tmpdir(), 'unplugin-deno-')).then((dir) => realpath(dir))
    return this.#workDir
  }

  /** A private copy of the lockfile, which `deno info` may add to (see the module comment). */
  #lockfileCopy(): Promise<string | undefined> {
    const source = this.#options.project.lockfilePath
    this.#lockfile ??=
      source === undefined
        ? Promise.resolve(undefined)
        : this.#work().then(async (dir) => {
            const copy = join(dir, 'deno.lock')
            try {
              await copyFile(source, copy)
              return copy
            } catch (error) {
              this.#logger.debug(
                `[engine] Cannot copy ${source}, resolving without a lockfile: ${error instanceof Error ? error.message : String(error)}`,
              )
              return undefined
            }
          })
    return this.#lockfile
  }

  /**
   * The `compilerOptions` of the workspace root's config (Deno applies them to remote modules), for
   * `deno transpile`; `undefined` when there is none or it cannot be read.
   */
  #rootCompilerOptions(): Promise<Record<string, unknown> | undefined> {
    this.#compilerOptions ??= this.#readCompilerOptions()
    return this.#compilerOptions
  }

  async #readCompilerOptions(): Promise<Record<string, unknown> | undefined> {
    const { project } = this.#options
    if (project.configPath === undefined) return undefined
    const file = [
      join(project.workspaceRoot, 'deno.json'),
      join(project.workspaceRoot, 'deno.jsonc'),
      project.configPath,
    ].find((candidate) => existsSync(candidate))
    if (file === undefined) return undefined
    try {
      const config = parseJsonc(await readFile(file, 'utf8'), file)
      const options = isRecord(config) ? config.compilerOptions : undefined
      return isRecord(options) ? options : undefined
    } catch (error) {
      this.#logger.debug(
        `[engine] Cannot read compilerOptions from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

function done(module: ResolvedModule): Step {
  return { module }
}

/** Whether a load of `type` transpiles modules of `mediaType`. */
function transpiles(mediaType: MediaType, type: LoadType): boolean {
  return (type === 'default' || type === 'json') && needsTranspile(mediaType)
}

/** The import statement of a query in a synthetic root. */
function importLine(query: Query): string {
  const attribute =
    query.attribute === undefined ? '' : ` with { type: ${JSON.stringify(query.attribute)} }`
  return `import ${JSON.stringify(query.specifier)}${attribute};`
}

/** Whether `query` names a specifier the batch already imports with another attribute. */
function conflicts(batch: OpenBatch, query: Query): boolean {
  const existing = batch.queries.get(query.specifier)
  return existing !== undefined && existing.attribute !== query.attribute
}

/**
 * `message` with the location of the import that caused it (`at <module>:<line>:<column>`,
 * one-based, as in the loader's diagnostics). Entrypoints (imported by the synthetic root, which
 * the graph does not record) have none.
 */
function located(
  message: string,
  importer: string | undefined,
  dependency: DenoInfoDependency | undefined,
): string {
  const start = dependency?.code?.span?.start
  if (importer === undefined || start === undefined) return message
  return `${message}\n    at ${importer}:${start.line + 1}:${start.character + 1}`
}

/** Deno's message, trimmed, with the synthetic root's URL replaced by `replacement`. */
function clean(message: string, run: InfoRun | undefined, replacement: string): string {
  const text = message.trim()
  return run === undefined || run.rootUrl === '' ? text : text.replaceAll(run.rootUrl, replacement)
}

/**
 * Whether `run` tried to download something of the package of `requirement` (with `cachedOnly`
 * every download fails): JSR metadata and files live under `/<@scope/name>/`, npm packuments at
 * `/<name>` and tarballs under `/<name>/-/`.
 */
function refusedFor(requirement: string, run: InfoRun | undefined): boolean {
  const name = parsePackageSpecifier(requirement)?.name
  if (run === undefined || name === undefined) return false
  return run.downloads.some((download) => {
    const pathname = URL.parse(download)?.pathname
    if (pathname === undefined) return false
    let path = pathname
    try {
      path = decodeURIComponent(pathname)
    } catch {
      // keep it encoded
    }
    return path === `/${name}` || path.startsWith(`/${name}/`)
  })
}

/** The first download URLs, for messages. */
function sample(urls: readonly string[]): string {
  const shown = urls.slice(0, DOWNLOADS_SHOWN)
  return `${shown.join(', ')}${urls.length > shown.length ? ', …' : ''}`
}

/** `npm:name@range` without its subpath. */
function withoutSubpath(requirement: string): string {
  const parsed = parsePackageSpecifier(requirement)
  if (parsed === undefined || parsed.subpath === '') return requirement
  return requirement.slice(0, requirement.length - parsed.subpath.length)
}

/** Whether a specifier names a package (`npm:` requirement or bare name). */
function isPackageSpecifier(specifier: string): boolean {
  return isBareSpecifier(specifier) || parsePackageSpecifier(specifier)?.scheme === 'npm'
}

/** `path` and its canonical form (both spellings appear in Deno's output). */
function withRealpath(path: string | undefined): readonly string[] {
  if (path === undefined) return []
  const real = realpathMaybeMissing(path)
  return real === path ? [path] : [path, real]
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

function dirnameOf(path: string): string {
  return (HOST_PATH_FLAVOR === 'win32' ? win32 : posix).dirname(path)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The bytes of a `data:` URL (`;base64` or percent-encoded), or `undefined` when it is malformed.
 * The fragment is not part of the data, as in the URL standard.
 */
export function decodeDataUrl(url: string): Uint8Array | undefined {
  const hash = url.indexOf('#')
  const text = hash === -1 ? url : url.slice(0, hash)
  const comma = text.indexOf(',')
  if (!/^data:/i.test(text) || comma === -1) return undefined
  const header = text.slice('data:'.length, comma)
  const bytes = percentDecodeBytes(text.slice(comma + 1))
  if (!/;\s*base64\s*$/i.test(header)) return bytes
  const base64 = decoder.decode(bytes).replace(/[\t\n\f\r ]/g, '')
  if (!/^[A-Za-z\d+/]*={0,2}$/.test(base64)) return undefined
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function percentDecodeBytes(text: string): Uint8Array {
  const bytes: number[] = []
  const encoded = encoder.encode(text)
  for (let index = 0; index < encoded.length; index++) {
    const byte = encoded[index] ?? 0
    if (byte === 0x25 && index + 2 < encoded.length) {
      const hex = String.fromCharCode(encoded[index + 1] ?? 0, encoded[index + 2] ?? 0)
      if (/^[\da-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    bytes.push(byte)
  }
  return new Uint8Array(bytes)
}
