/**
 * The `resolveId` algorithm (docs/architecture.md §5.2): which ids the plugin owns, and what each
 * owned id resolves to, as a host-independent {@link ResolveOutcome} the host adapters turn into
 * their own results.
 *
 * @module
 */
import { stat } from 'node:fs/promises'
import { posix, resolve as resolvePath, win32 } from 'node:path'
import type { ImportMapMatch, Project } from '../config/project.js'
import { packageJsonDependencies } from '../config/package-json.js'
import { DenoPluginError, isDenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import { isOptionalDependencyError } from '../engine/errors.js'
import type { Engine, ResolutionMode, ResolvedModule } from '../engine/types.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR, toFileUrl, toPath } from '../utils/path.js'
import type { ImportAllowList } from './allow-import.js'
import { cachedOnlyHint, displayModule, nativeAddonMessage, nodeBuiltinMessage } from './checks.js'
import type { DenoType } from './id.js'
import {
  EMPTY_MODULE_ID,
  isDenoVirtualId,
  isForeignId,
  isVirtualId,
  readDenoType,
  splitQuery,
  withDenoType,
} from './id.js'
import type { JsrRoute } from './jsr-npm.js'
import { jsrToNpmSpecifier } from './jsr-npm.js'
import type { LockfilePolicy } from './lockfile-policy.js'
import type { Mirror } from './mirror.js'
import type { NpmRedirectOutcome, NpmStrategy, PathOutcome } from './npm.js'
import { isGlobalCachePath, isNodeModulesPath, npmOutcome, npmStrategyFor } from './npm.js'
import type { Pattern, Platform, ResolvedOptions, ResolveHookContext } from './options.js'
import { pinExternalsFor } from './options.js'
import type { ExternalOutcome } from './platform.js'
import { externalOutcomeFor, isExternal, matchPattern } from './platform.js'
import type { ExternalRecord } from './sidecar.js'
import type { ParsedSpecifier } from './specifier.js'
import { parseNpmSpecifier, parseSpecifier } from './specifier.js'

/** A file in the mirror that the plugin loads (code and source map). */
export interface MirrorOutcome {
  type: 'mirror'
  /** Absolute path of the mirror file, with the original query appended. */
  path: string
  /** The URL it mirrors. */
  url: string
}

/** A `?deno-type=` marker module (§5.5) the plugin synthesises in `load`. */
export interface MarkerOutcome {
  type: 'marker'
  /** The marker id: the target file's path with `?deno-type=<type>`. */
  path: string
  denoType: DenoType
  /** The URL of the target (`file:`, `https:`, `data:`), for messages. */
  sourceUrl: string
}

/**
 * A marker on an import the host resolves (local relative paths, `node_modules` packages): the
 * adapter resolves {@link HostMarkerOutcome.request} with the host and adds the marker to the id.
 */
export interface HostMarkerOutcome {
  type: 'host-marker'
  request: string
  denoType: DenoType
}

/** One of the plugin's own virtual modules (`\0deno:empty`). */
export interface VirtualOutcome {
  type: 'virtual'
  id: string
}

/** What the core hands back to a host adapter for one `resolveId` call (§2); `null` = not ours. */
export type ResolveOutcome =
  | PathOutcome
  | MirrorOutcome
  | NpmRedirectOutcome
  | MarkerOutcome
  | HostMarkerOutcome
  | ExternalOutcome
  | VirtualOutcome
  | null

/** Details of a `resolveId` call. */
export interface ResolveRequest {
  /**
   * The host's import kind (Rolldown `kind`, esbuild `kind`): `require-call` resolves with the
   * `require` conditions, everything else as an import.
   */
  kind?: string | undefined
  isEntry?: boolean | undefined
  /** Vite's dependency scan (`opts.scan`); reserved for the Vite adapter. */
  scan?: boolean | undefined
  /**
   * The platform of the importing environment when a host builds several at once (Vite: a
   * browser client and server environments); the build's own platform when omitted.
   */
  target?: ResolveTarget | undefined
}

/**
 * The platform an import is resolved for (§5.6) when it differs from the build's: the plugin
 * state keeps an engine, a mirror generation and a resolver per target.
 */
export interface ResolveTarget {
  platform: Platform
  /** The host's export conditions for the engine (instead of `StateHints.conditions`). */
  conditions?: readonly string[] | undefined
  /**
   * `bundle` patterns added to the option's for this target, e.g. `npm:*` and `jsr:*` for
   * server code that Vite's dev server runs in-process, where `platform: 'deno'` externals
   * cannot be loaded.
   */
  bundle?: readonly Pattern[] | undefined
}

/** What the resolver reads from the plugin state. */
export interface ResolverState {
  readonly options: ResolvedOptions
  readonly project: Project
  readonly platform: Platform
  readonly npmStrategy: NpmStrategy
  /** `DENO_DIR` spellings (literal and real path), to recognise global-cache npm files. */
  readonly denoDirs: readonly string[]
  readonly mirror: Mirror
  readonly logger: Logger
  /** The host (`meta.framework`), passed to the `resolve` option hook. */
  readonly framework: ResolveHookContext['host']
  /** The engine for the build's platform (created on first use). */
  engine(): Promise<Engine>
  readonly flavor?: PathFlavor
  /** Logs a warning once per `key` (browser-safety checks, §5.10). */
  warnOnce?(key: string, message: string): void
  /** Records an npm package bundled for `platform` (the duplicate-version check, X4). */
  recordNpmPackage?(platform: Platform, name: string, version: string): void
  /** The remote-import allow-list (R15); every host is allowed without one. */
  readonly allowImport?: ImportAllowList
  /** Compares resolutions with `deno.lock` (R5, X5); nothing is checked without one. */
  readonly lockfilePolicy?: LockfilePolicy
  /** Where `jsr:` packages come from (R11); `mirror` when unset. */
  readonly jsrRoute?: JsrRoute
  /** Records an import kept external for `platform` (the sidecar deno.lock, S3). */
  recordExternal?(platform: Platform, record: ExternalRecord): void
  /** The command that fills Deno's cache for the build (`deno cache src/main.ts`), for hints. */
  cacheCommand?(): string
}

/** Resolves owned ids; see {@link createResolver}. */
export interface Resolver {
  /**
   * Resolves `rawId` imported by `importer` (§5.2). Returns `null` for ids the plugin does not own
   * and never throws for them; failures of owned ids throw {@link DenoPluginError}s with a hint.
   */
  resolveOwned(
    rawId: string,
    importer: string | undefined,
    request?: ResolveRequest,
  ): Promise<ResolveOutcome>
}

/** The Deno schemes the plugin owns (§5.2). */
const OWNED_SCHEMES = '^(?:jsr|npm|https?|data|node|bun|cloudflare|file):'
const MARKER = '[?&]deno-type='
/** Bare specifiers (for imports inside global-cache npm packages). */
const BARE = '^[^./\\0]'

/**
 * The `resolveId` filter when the project is not known yet (and in watch mode, where import-map
 * keys can change): owned schemes, markers and every bare specifier.
 */
export const BROAD_RESOLVE_ID_FILTER: RegExp = new RegExp(`${OWNED_SCHEMES}|${MARKER}|${BARE}`)

/**
 * The `resolveId` filter (§5.2): the owned schemes, the escaped import-map keys and workspace
 * package names (`^(?:@std/path|react)(?:[/?]|$)`), the `deno-type` marker, `package.json`
 * dependencies for the Deno platform (they are pinned as externals), and every bare specifier when
 * npm packages come from Deno's global cache (their imports must go through the engine).
 */
export function resolveIdFilter(
  project: Pick<Project, 'importMap' | 'rootFolder' | 'members' | 'nodeModules'>,
  options: Pick<ResolvedOptions, 'npm'>,
  platform: Platform = 'browser',
): RegExp {
  const alternatives = [OWNED_SCHEMES, MARKER]
  if (npmStrategyFor(options.npm, project.nodeModules.mode) === 'deno-cache') {
    alternatives.push(BARE)
  } else {
    const keys = new Set(project.importMap.ownedKeys())
    if (platform === 'deno') {
      for (const name of packageJsonDependencyNames(project)) keys.add(name)
    }
    if (keys.size > 0) {
      const escaped = [...keys].toSorted().map((key) => key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
      alternatives.push(`^(?:${escaped.join('|')})(?:[/?]|$)`)
    }
  }
  return new RegExp(alternatives.join('|'))
}

/** The dependency names of the workspace's `package.json` files. */
export function packageJsonDependencyNames(
  project: Pick<Project, 'rootFolder' | 'members'>,
): string[] {
  const names = new Set<string>()
  for (const folder of [project.rootFolder, ...project.members]) {
    const json = folder?.packageJson?.json
    if (json === undefined) continue
    for (const [name] of packageJsonDependencies(json)) names.add(name)
  }
  return [...names].toSorted()
}

/** Where an import comes from. */
type ImporterContext =
  | { kind: 'none' }
  | { kind: 'virtual' }
  | { kind: 'url'; url: string }
  | { kind: 'mirror'; path: string }
  /** A file of an npm package whose imports the engine resolves (global cache, `deno-cache`). */
  | { kind: 'npm-engine'; path: string }
  /** A file of an npm package in `node_modules` whose imports the host resolves. */
  | { kind: 'npm-host'; path: string }
  | { kind: 'local'; path: string }

/** Creates the resolver of one build (see {@link Resolver}). */
export function createResolver(state: ResolverState): Resolver {
  return {
    resolveOwned: (rawId, importer, request = {}) => resolveOwned(state, rawId, importer, request),
  }
}

async function resolveOwned(
  state: ResolverState,
  rawId: string,
  importer: string | undefined,
  request: ResolveRequest,
): Promise<ResolveOutcome> {
  if (isDenoVirtualId(rawId))
    return rawId === EMPTY_MODULE_ID ? { type: 'virtual', id: rawId } : null
  if (isForeignId(rawId)) return null
  const { options } = state
  if (matchPattern(options.exclude, splitQuery(rawId).base)) return null
  if (importer !== undefined && !importerAllowed(options, importer)) return null
  const marker = readDenoType(rawId)
  const denoType = marker?.type
  let id = marker?.base ?? rawId
  if (options.resolve !== undefined) {
    const hooked = await options.resolve(id, importer, {
      host: state.framework,
      platform: state.platform,
    })
    if (hooked === false) return null
    if (typeof hooked === 'string') id = hooked
  }
  const context = importerContext(state, importer)
  const referrer = await referrerFor(state, context)
  const mode: ResolutionMode = request.kind === 'require-call' ? 'require' : 'import'
  const step = { state, context, referrer, mode, denoType, importer }
  try {
    return await resolveSpecifier(step, id)
  } catch (error) {
    throw withCachedOnlyHint(state, withImporter(error, id, importer))
  }
}

interface Step {
  state: ResolverState
  context: ImporterContext
  referrer: string | undefined
  mode: ResolutionMode
  denoType: DenoType | undefined
  importer: string | undefined
}

/** §5.2 steps 1–4 for one (marker-free) id. */
async function resolveSpecifier(step: Step, id: string): Promise<ResolveOutcome> {
  const { state, context, denoType } = step
  let spec = parseSpecifier(id)
  const spellings: string[] = []
  // The query of a remote URL is part of the resource; other queries (`?raw`) belong to the host.
  const query = isRemote(spec) ? '' : spec.query
  let base = isRemote(spec) ? id : spec.base

  // 1. The import map is authoritative for its keys, except inside npm packages (Deno applies
  //    Node resolution there).
  if (spec.kind === 'bare') {
    if (context.kind === 'npm-engine')
      return outcomeOf(step, await engineResolve(step, base), base, query)
    if (context.kind === 'npm-host') return hostMarker(id, denoType)
    const match = importMapResolve(state, base, step.referrer)
    if (match === null) return hostMarker(id, denoType)
    if (match.kind === 'package-json-dependency')
      return packageJsonDependency(step, base, match, query)
    if (match.kind === 'workspace-member' && match.packageName !== undefined) {
      return outcomeOf(step, await engineResolve(step, base), base, query)
    }
    spellings.push(base)
    base = match.mapped
    spec = parseSpecifier(base)
  }
  switch (spec.kind) {
    case 'relative':
    case 'absolute':
      return relativeImport(step, spec, query)
    case 'file':
      return localOutcome(step, toPath(spec.base, state.flavor), spec.base, query)
    case 'bare':
    case 'unknown-scheme':
      return null
    default:
      break
  }

  // 2. Externals policy, before the engine (§5.6).
  if (spec.kind === 'node' && state.platform === 'browser') {
    reportNodeBuiltin(step, spec.base)
    return null
  }
  if (isExternal(spec, state.options, state.platform, spellings)) {
    const pin =
      (spec.kind === 'npm' || spec.kind === 'jsr') && pinExternalsFor(state.options, state.platform)
    const resolved = pin ? await engineResolve(step, base) : undefined
    return recordExternal(
      state,
      externalOutcomeFor(
        { ...spec, base },
        resolved === 'optional' ? undefined : resolved,
        state.options,
        state.platform,
        state.project.lockfile,
        spellings,
      ),
      resolved,
    )
  }

  // 3. The engine: remote URLs only from allowed hosts (R15), before anything is downloaded;
  //    `jsr:` packages through node_modules/@jsr when the project installs them there (R11).
  if (spec.kind === 'https' || spec.kind === 'http') {
    state.allowImport?.check(base, { importer: step.importer })
  }
  if (spec.kind === 'jsr' && state.jsrRoute === 'node_modules') {
    const npmSpecifier = jsrToNpmSpecifier(base)
    if (npmSpecifier !== undefined) {
      state.logger.debug(`[resolve] ${base} → ${npmSpecifier} (node_modules/@jsr)`)
      return outcomeOf(step, await engineResolve(step, npmSpecifier), npmSpecifier, query)
    }
  }
  return outcomeOf(
    step,
    await engineResolve(step, base, markerFallback(spec, base, step)),
    base,
    query,
  )
}

/**
 * Records an external outcome for the sidecar lockfile (S3), with the engine's resolution when
 * the specifier was pinned; returns the outcome.
 */
function recordExternal(
  state: ResolverState,
  outcome: ExternalOutcome | null,
  resolved: ResolvedModule | 'optional' | undefined,
): ExternalOutcome | null {
  if (outcome !== null) {
    state.recordExternal?.(state.platform, {
      id: outcome.id,
      resolved: resolved === 'optional' ? undefined : resolved,
    })
  }
  return outcome
}

/**
 * For a marker whose target is a URL, the URL itself when the engine cannot resolve it: the
 * loader's graph records `css` (and, without `unstable: ["raw-imports"]`, `text`/`bytes`) imports
 * as errors, but the mirror loads the target as raw bytes, following redirects.
 */
function markerFallback(
  spec: ParsedSpecifier,
  base: string,
  step: Step,
): ResolvedModule | undefined {
  if (step.denoType === undefined) return undefined
  if (spec.kind === 'https' || spec.kind === 'http') {
    return { kind: 'remote', url: base, mediaType: 'Unknown' }
  }
  return spec.kind === 'data' ? { kind: 'data', url: base, mediaType: 'Unknown' } : undefined
}

function isRemote(spec: ParsedSpecifier): boolean {
  return spec.kind === 'https' || spec.kind === 'http'
}

/**
 * A bare `package.json` dependency is the host's (it resolves it from `node_modules`), except on
 * the Deno platform, where it is kept external and pinned like an `npm:` specifier (§5.6).
 */
async function packageJsonDependency(
  step: Step,
  base: string,
  match: ImportMapMatch,
  query: string,
): Promise<ResolveOutcome> {
  const { state } = step
  const spec = parseSpecifier(match.mapped)
  if (state.platform !== 'deno' || !isExternal(spec, state.options, state.platform, [base])) {
    return hostMarker(`${base}${query}`, step.denoType)
  }
  const resolved = pinExternalsFor(state.options, state.platform)
    ? await engineResolve(step, base, undefined, match.mapped)
    : undefined
  return recordExternal(
    state,
    externalOutcomeFor(
      spec,
      resolved === 'optional' ? undefined : resolved,
      state.options,
      state.platform,
      state.project.lockfile,
      [base],
    ),
    resolved,
  )
}

/** Relative and absolute specifiers: the host's, unless they come from a mirror or npm file. */
async function relativeImport(
  step: Step,
  spec: ParsedSpecifier,
  query: string,
): Promise<ResolveOutcome> {
  const { state, context } = step
  if (context.kind === 'mirror') {
    // Rewritten specifiers in mirror files are paths relative to the mirror file (§5.3).
    const flavor = state.flavor ?? HOST_PATH_FLAVOR
    const syntax = flavor === 'win32' ? win32 : posix
    const target =
      spec.kind === 'absolute' ? spec.base : syntax.resolve(syntax.dirname(context.path), spec.base)
    if (await isFile(target)) {
      const url = (await state.mirror.urlForMirrorPath(target)) ?? toFileUrl(target, flavor)
      return step.denoType === undefined
        ? { type: 'path', path: `${target}${query}` }
        : markerOutcome(`${target}${query}`, step.denoType, url)
    }
    return outcomeOf(step, await engineResolve(step, spec.base), spec.base, query)
  }
  if (context.kind === 'npm-engine') {
    return outcomeOf(step, await engineResolve(step, spec.base), spec.base, query)
  }
  return hostMarker(`${spec.base}${query}`, step.denoType)
}

/**
 * Warns (once per import) that a local or remote module of a browser bundle imports a `node:`
 * builtin, naming the importer (X3). Imports inside npm packages are the package's business.
 */
function reportNodeBuiltin(step: Step, specifier: string): void {
  const { state, context } = step
  if (!state.options.checks.browserSafety || state.warnOnce === undefined) return
  if (context.kind !== 'local' && context.kind !== 'mirror') return
  const importer =
    context.kind === 'mirror'
      ? (step.referrer ?? context.path)
      : displayModule(context.path, state.options.cwd)
  state.warnOnce(`node-builtin\0${importer}\0${specifier}`, nodeBuiltinMessage(importer, specifier))
}

/** `null`, or the host-resolved marker when the import carries a `deno-type`. */
function hostMarker(request: string, denoType: DenoType | undefined): ResolveOutcome {
  return denoType === undefined ? null : { type: 'host-marker', request, denoType }
}

function markerOutcome(path: string, denoType: DenoType, sourceUrl: string): MarkerOutcome {
  return { type: 'marker', path: withDenoType(path, denoType), denoType, sourceUrl }
}

function localOutcome(step: Step, path: string, url: string, query: string): ResolveOutcome {
  return step.denoType === undefined
    ? { type: 'path', path: `${path}${query}` }
    : markerOutcome(`${path}${query}`, step.denoType, url)
}

/** §5.2 step 3: the outcome for what the engine resolved. */
async function outcomeOf(
  step: Step,
  resolved: ResolvedModule | 'optional',
  specifier: string,
  query: string,
): Promise<ResolveOutcome> {
  const { state, denoType } = step
  if (resolved === 'optional') return { type: 'external', id: specifier }
  switch (resolved.kind) {
    case 'local':
      return localOutcome(
        step,
        resolved.path ?? toPath(resolved.url, state.flavor),
        resolved.url,
        query,
      )
    case 'npm': {
      if (denoType !== undefined) {
        return markerOutcome(
          `${resolved.path ?? toPath(resolved.url, state.flavor)}${query}`,
          denoType,
          resolved.url,
        )
      }
      const file = resolved.path ?? resolved.url
      if (/\.node$/i.test(file)) {
        // A native addon cannot be bundled: keep the import for the runtime to load (S5).
        if (state.options.checks.browserSafety) {
          state.warnOnce?.(`native-addon\0${file}`, nativeAddonMessage(specifier, file))
        }
        return { type: 'external', id: specifier }
      }
      if (resolved.npm !== undefined) {
        state.recordNpmPackage?.(state.platform, resolved.npm.name, resolved.npm.version)
      }
      return npmOutcome(resolved, specifier, {
        strategy: state.npmStrategy,
        denoDirs: state.denoDirs,
        query,
        ...(state.flavor === undefined ? {} : { flavor: state.flavor }),
      })
    }
    case 'remote':
    case 'data': {
      // The engine may know a redirect of the URL (or map `jsr:` to a registry URL).
      if (resolved.kind === 'remote') {
        state.allowImport?.check(resolved.url, {
          importer: step.importer,
          redirectedFrom:
            /^https?:/.test(specifier) && specifier !== resolved.url ? specifier : undefined,
        })
      }
      const file = await state.mirror.ensureMirrored(
        resolved.url,
        denoType === undefined ? 'module' : 'asset',
      )
      if (denoType !== undefined) return markerOutcome(`${file.path}${query}`, denoType, file.url)
      return { type: 'mirror', path: `${file.path}${query}`, url: file.url }
    }
    case 'node':
    case 'external':
      return { type: 'external', id: resolved.url }
  }
}

/**
 * Resolves through the engine; a missing optional dependency of an npm package becomes
 * `'optional'` (kept external, so a guarded `require` fails at runtime as it would under Deno).
 * The result is compared with `deno.lock` (`requirement`: the `npm:`/`jsr:` requirement that
 * `specifier` stands for, when it is a bare `package.json` dependency), and failures of
 * requirements the lockfile lacks are explained (R5, X5).
 */
async function engineResolve(
  step: Step,
  specifier: string,
  fallback?: ResolvedModule,
  requirement: string = specifier,
): Promise<ResolvedModule | 'optional'> {
  const { state } = step
  const engine = await state.engine()
  let resolved: ResolvedModule
  try {
    resolved = await engine.resolve(specifier, step.referrer, step.mode)
  } catch (error) {
    if (isOptionalDependencyError(error)) {
      state.logger.debug(
        `[resolve] optional dependency ${specifier} is not installed; kept external`,
      )
      return 'optional'
    }
    if (fallback !== undefined && isDenoPluginError(error)) return fallback
    const explained = state.lockfilePolicy?.explainFailure(error, requirement) ?? error
    throw withInstallHint(state, specifier, explained)
  }
  // Deno locks code and JSON imports of remote URLs, not `text`/`bytes`/`css` ones.
  if (step.denoType === undefined || resolved.kind !== 'remote') {
    state.lockfilePolicy?.check(
      { specifier: requirement, resolved, transitive: step.context.kind === 'npm-engine' },
      step.importer,
    )
  }
  return resolved
}

/**
 * The hint of a `CACHED_ONLY_MISS`: the import that missed the cache and the command that fills
 * it for this build (R13).
 */
function withCachedOnlyHint(state: ResolverState, error: unknown): unknown {
  if (!isDenoPluginError(error) || error.code !== 'CACHED_ONLY_MISS') return error
  const command = state.cacheCommand?.() ?? 'deno install'
  return new DenoPluginError(error.code, error.message, {
    hint: cachedOnlyHint(error.specifier, command),
    specifier: error.specifier,
    importer: error.importer,
    cause: error.cause ?? error,
  })
}

/**
 * With `nodeModulesDir: "manual"` the project installs npm packages itself: an `npm:` specifier
 * whose package is not a `package.json` dependency can only be found after adding it there (or
 * moving it to Deno-managed npm resolution), which the hint says instead of the engine's
 * "install it" hint.
 */
function withInstallHint(state: ResolverState, specifier: string, error: unknown): unknown {
  if (!isDenoPluginError(error) || error.code !== 'RESOLVE_NOT_FOUND') return error
  if (state.project.nodeModules.mode !== 'manual') return error
  const npm = parseNpmSpecifier(specifier)
  if (npm === null || packageJsonDependencyNames(state.project).includes(npm.name)) return error
  return new DenoPluginError(error.code, error.message, {
    hint: `${npm.name} is not a dependency in package.json, and with "nodeModulesDir": "manual" Deno installs no npm packages: add it to package.json and run your package manager, or move it to deno.json \`imports\` with "nodeModulesDir": "auto" or "none".`,
    specifier: error.specifier ?? specifier,
    importer: error.importer,
    cause: error,
  })
}

function importMapResolve(
  state: ResolverState,
  specifier: string,
  referrer: string | undefined,
): ImportMapMatch | null {
  if (state.project.disabled) return null
  return state.project.importMap.resolve(specifier, referrer)
}

function importerContext(state: ResolverState, importer: string | undefined): ImporterContext {
  if (importer === undefined) return { kind: 'none' }
  if (isVirtualId(importer) || isForeignId(importer)) return { kind: 'virtual' }
  const { base } = splitQuery(importer)
  const flavor = state.flavor ?? HOST_PATH_FLAVOR
  const absolute = flavor === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(base) : base.startsWith('/')
  if (!absolute) {
    return /^[a-zA-Z][a-zA-Z\d+.-]+:/.test(base) ? { kind: 'url', url: base } : { kind: 'virtual' }
  }
  if (state.mirror.isMirrorPath(base)) return { kind: 'mirror', path: base }
  if (isGlobalCachePath(base, state.denoDirs, flavor)) return { kind: 'npm-engine', path: base }
  if (isNodeModulesPath(base, flavor)) {
    return state.npmStrategy === 'deno-cache'
      ? { kind: 'npm-engine', path: base }
      : { kind: 'npm-host', path: base }
  }
  return { kind: 'local', path: base }
}

/** The engine referrer: a mirror file's source URL, a file's URL, or the project root. */
async function referrerFor(
  state: ResolverState,
  context: ImporterContext,
): Promise<string | undefined> {
  switch (context.kind) {
    case 'none':
    case 'virtual':
      return undefined
    case 'url':
      return context.url
    case 'mirror':
      return (
        (await state.mirror.urlForMirrorPath(context.path)) ?? toFileUrl(context.path, state.flavor)
      )
    default:
      return toFileUrl(context.path, state.flavor)
  }
}

function importerAllowed(options: ResolvedOptions, importer: string): boolean {
  const { include, exclude } = options.importers
  if (
    include.length > 0 &&
    !include.some((pattern) => matchesImporter(pattern, importer, options.cwd))
  ) {
    return false
  }
  return !exclude.some((pattern) => matchesImporter(pattern, importer, options.cwd))
}

function matchesImporter(pattern: Pattern, importer: string, cwd: string): boolean {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0
    return pattern.test(importer)
  }
  const prefix = /^\.{1,2}(?:[\\/]|$)/.test(pattern) ? resolvePath(cwd, pattern) : pattern
  return importer === prefix || importer.startsWith(prefix)
}

/** Adds the importer to errors of owned ids so hosts can show where the import is. */
function withImporter(error: unknown, specifier: string, importer: string | undefined): unknown {
  if (!isDenoPluginError(error) || importer === undefined || error.importer !== undefined)
    return error
  return new DenoPluginError(error.code, error.message, {
    hint: error.hint,
    specifier: error.specifier ?? specifier,
    importer,
    cause: error.cause ?? error,
  })
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
