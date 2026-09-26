/**
 * The esbuild adapter (docs/architecture.md §6.4). unplugin's generic esbuild adapter registers a
 * catch-all `onResolve` before the `esbuild.setup` escape hatch runs and forces every result into
 * the plugin namespace, so for esbuild the factory returns only `{ name, esbuild: { setup } }` and
 * this module implements the whole plugin against esbuild's own API:
 *
 * - `setup` loads the project (root `absWorkingDir`, platform and conditions from the build
 *   options), so the Go-side `onResolve` filter names the owned schemes, the marker and the
 *   import-map keys, never every import;
 * - owned imports resolve to real files in the `file` namespace (local files, mirror files, npm
 *   files of Deno's global cache) that esbuild loads with its own loaders, reading the mirror's
 *   linked source maps; npm packages under `node_modules` are resolved again by esbuild from
 *   inside the package (`build.resolve`), so `exports`, `browser` and `sideEffects` apply;
 * - `with { type: "text" | "bytes" | "css" }` imports of owned specifiers, and `css` imports of
 *   local `.css` files (which esbuild rejects), become modules synthesised in the `unplugin-deno`
 *   namespace; esbuild loads local `text`/`bytes` imports itself (esbuild ≥ 0.28 / 0.25.11);
 * - externals are `{ external: true }` results; esbuild's own `external` option is left to esbuild
 *   and `packages: 'external'` keeps `npm:`/`jsr:` imports external and pinned;
 * - `setup` applies the `deno.json` JSX settings (unless the build sets JSX) and defines the
 *   inlined `process.env.<KEY>` variables (§5.10, §5.11); the plugin loads `.wasm` module imports
 *   (§5.12) and the mirror files that contain `import.meta.main`, replaced by `false` (esbuild has
 *   no transform hook, so local files keep theirs).
 *
 * @module
 */
import { dirname, resolve } from 'node:path'
import type {
  BuildOptions,
  BuildResult,
  OnEndResult,
  OnLoadArgs,
  OnLoadResult,
  OnResolveArgs,
  OnResolveResult,
  OnStartResult,
  PartialMessage,
  PluginBuild,
} from 'esbuild'
import { isDenoType } from '../../core/attributes.js'
import { inlinesEnv } from '../../core/env.js'
import { readDenoType, splitQuery, withDenoType } from '../../core/id.js'
import type { NpmRedirectOutcome } from '../../core/npm.js'
import { isGlobalCachePath, isNodeModulesPath } from '../../core/npm.js'
import type { ResolvedOptions } from '../../core/options.js'
import type { HostMarkerOutcome, ResolveOutcome } from '../../core/resolve.js'
import { packageJsonDependencyNames, resolveIdFilter } from '../../core/resolve.js'
import { writeSidecar } from '../../core/sidecar.js'
import { parseSpecifier } from '../../core/specifier.js'
import type { PluginState, StateHints } from '../../core/state.js'
import { WASM_MODULE_ID_FILTER } from '../../core/wasm.js'
import { DenoPluginError } from '../../diagnostics/errors.js'
import { externalMatcher } from './external.js'
import { toMessage, WarningBuffer } from './messages.js'
import { loadMirrorModule } from './mirror.js'
import {
  applyJsx,
  buildOptions,
  configuresJsx,
  defineEnv,
  entryList,
  hintsFor,
  settingsKey,
} from './options.js'
import { displayPath, virtualDisplayPath } from './paths.js'
import type { WatchSnapshot } from './snapshot.js'
import { changedFile, takeSnapshot } from './snapshot.js'

/** The esbuild namespace of the plugin's synthesised modules (import-attribute markers). */
export const NAMESPACE = 'unplugin-deno'

/** Bare specifiers, for the imports inside npm packages that the engine resolves. */
const BARE_FILTER = /^[^./]/

/** Imports of `.css` files, for local `with { type: "css" }` imports (esbuild rejects them). */
const CSS_FILTER = /\.css(?:[?#]|$)/i

/** CSS import kinds; esbuild keeps remote URLs in CSS as they are and inlines `data:` URLs. */
const CSS_KINDS: ReadonlySet<string> = new Set(['import-rule', 'composes-from', 'url-token'])

/** The `pluginData` key carrying the core id of a synthesised module. */
const ID_KEY = 'unpluginDenoId'

/** What the builds and contexts of one plugin instance (one `PluginState`) share. */
interface Shared {
  /** Builds and contexts between `setup` and `onDispose`; the last one disposes the engines. */
  active: number
  /** Builds between `onStart` and `onEnd` (and setups loading the project). */
  running: number
  /** {@link settingsKey} of the running builds. */
  runningSettings: string | undefined
  /** {@link settingsKey} of the build options the project was loaded for. */
  settings: string | undefined
  /** Set when a reload failed: the next build loads the project again. */
  stale: boolean
  /** The core's resolution of the user options at the last project load. */
  baseOptions: ResolvedOptions | undefined
  /** The watched files' contents at the last project load. */
  snapshot: WatchSnapshot | undefined
  /** Entry points added to the current engines. */
  seeded: Set<string>
  /** Disposal of the engines after the last build; the next `setup` waits for it. */
  closing: Promise<void> | undefined
  /** The last {@link configure} call; calls run one after the other. */
  configuring: Promise<unknown>
  warnings: WarningBuffer
}

/** One esbuild build or context. */
interface BuildContext {
  state: PluginState
  shared: Shared
  build: PluginBuild
  /** `absWorkingDir`. */
  root: string
  hints: StateHints
  settings: string
  packagesExternal: boolean
  entries: string[]
  /** Mirror files resolved as entry points (they keep `import.meta.main`). */
  entryPaths: Set<string>
  /** Between this build's `onStart` and `onEnd`. */
  running: boolean
  /** `onStart` reported an error: owned imports are left alone until the build ends. */
  failed: boolean
}

/** The `onResolve` filters a `setup` registered. */
interface Filters {
  /** Owned schemes, the marker and the import-map keys; every bare specifier when `broad`. */
  main: RegExp
  /** Whether the handler for bare imports inside engine-resolved npm packages is registered. */
  bare: boolean
  /** The project was not loaded at `setup`, so `main` is the broad filter. */
  broad: boolean
}

/**
 * Builds the `setup` function of the esbuild plugin. One plugin instance may serve several builds
 * and contexts: one after the other with any options (the project is loaded again for other
 * `absWorkingDir`, `platform`, `conditions` or `packages` settings), and at the same time when
 * they agree on those; the engines are disposed with the last of them.
 *
 * The returned function throws `ENGINE_UNAVAILABLE` synchronously when the host is not esbuild
 * (Bun's esbuild-like plugin builder has no `initialOptions` or `resolve`).
 */
export function esbuildSetup(state: PluginState): (build: PluginBuild) => Promise<void> {
  // esbuild passes the attributes of every import to `onResolve` (`args.with`).
  state.nativeAttributes = true
  const shared: Shared = {
    active: 0,
    running: 0,
    runningSettings: undefined,
    settings: undefined,
    stale: false,
    baseOptions: undefined,
    snapshot: undefined,
    seeded: new Set(),
    closing: undefined,
    configuring: Promise.resolve(),
    warnings: new WarningBuffer(),
  }
  return (build) => {
    assertEsbuild(build)
    return setup(state, shared, build)
  }
}

function assertEsbuild(build: PluginBuild): void {
  const candidate = build as Partial<PluginBuild> | null | undefined
  if (
    typeof candidate?.initialOptions === 'object' &&
    candidate.initialOptions !== null &&
    typeof candidate.resolve === 'function' &&
    typeof candidate.onDispose === 'function'
  ) {
    return
  }
  throw new DenoPluginError(
    'ENGINE_UNAVAILABLE',
    'unplugin-deno/esbuild needs the esbuild plugin API (build.initialOptions, build.resolve, onStart, onEnd, onDispose), which this host does not provide.',
    { hint: 'Use unplugin-deno/esbuild with esbuild; other hosts have their own entries.' },
  )
}

async function setup(state: PluginState, shared: Shared, build: PluginBuild): Promise<void> {
  const options = build.initialOptions
  shared.active++
  build.onDispose(() => release(state, shared))
  await shared.closing
  state.setLogTarget(shared.warnings)
  const context: BuildContext = {
    state,
    shared,
    build,
    root: options.absWorkingDir ?? process.cwd(),
    hints: hintsFor(options, build.esbuild.version),
    settings: settingsKey(options),
    packagesExternal: options.packages === 'external',
    entries: entryList(options.entryPoints),
    entryPaths: new Set(),
    running: false,
    failed: false,
  }
  // Load the project now, so the filters can name the import-map keys. When that fails (or a
  // build with other settings is running) the filters are broad and `onStart` loads it (a context
  // works again once a broken config is fixed).
  let loaded = false
  if (acquire(shared, context.settings)) {
    try {
      await configure(context)
      loaded = true
    } catch {
      // Reported by `onStart`.
    } finally {
      releaseRun(shared)
    }
  }
  const filters = filtersFor(state, loaded)
  if (loaded) await configureBuild(context)
  const isExternal = externalMatcher(options.external)
  const resolveOwned = (args: OnResolveArgs): Promise<OnResolveResult | undefined> =>
    onResolve(context, args, isExternal)

  build.onStart(() => onStart(context, filters))
  build.onResolve({ filter: filters.main }, resolveOwned)
  if (filters.bare) {
    build.onResolve({ filter: BARE_FILTER }, async (args) =>
      isEngineImporter(state, args.importer) ? resolveOwned(args) : undefined,
    )
  }
  if (state.options.importAttributes) {
    build.onResolve({ filter: CSS_FILTER }, async (args) =>
      args.with.type === 'css' ? resolveOwned(args) : undefined,
    )
  }
  build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => onLoad(context, args))
  // `.wasm` module imports, unless the build gives `.wasm` a loader of its own (§5.12).
  if (state.options.wasm && options.loader?.['.wasm'] === undefined) {
    build.onLoad({ filter: WASM_MODULE_ID_FILTER }, (args) => onLoadWasm(context, args))
  }
  if (loaded && state.options.importMetaMain) {
    const [mirror] = state.loadFilter()
    if (mirror !== undefined) {
      build.onLoad({ filter: mirror }, async (args) =>
        args.namespace === 'file' && !context.entryPaths.has(args.path)
          ? loadMirrorModule(args.path)
          : undefined,
      )
    }
  }
  build.onEnd((result) => onEnd(context, result))
}

/**
 * The build options the project implies, set while esbuild still reads them (in `setup`): the
 * `deno.json` JSX settings unless the build configures JSX (§5.11), and the inlined environment
 * variables as `process.env.<KEY>` definitions (§5.10). A context keeps them for its rebuilds.
 */
async function configureBuild(context: BuildContext): Promise<void> {
  const { state, build } = context
  const options = build.initialOptions
  if (!configuresJsx(options)) {
    const decision = state.jsxTransform('esbuild')
    if (decision !== null) applyJsx(options, decision.transform)
  }
  if (inlinesEnv(state.options, state.platform)) {
    const env = await state.envInlining()
    if (env !== null) defineEnv(options, env.entries())
  }
}

/**
 * The filters for the loaded project: the import-map keys (and `package.json` dependencies for
 * the Deno platform) even when npm packages come from Deno's global cache, whose bare imports get
 * a handler of their own; the broad filter when the project was not loaded.
 */
function filtersFor(state: PluginState, loaded: boolean): Filters {
  if (!loaded || !state.ready) {
    return { main: state.resolveIdFilter(true), bare: false, broad: true }
  }
  return {
    main: resolveIdFilter(state.project, { npm: 'node_modules' }, state.platform),
    bare: state.npmStrategy === 'deno-cache',
    broad: false,
  }
}

// -- lifecycle ------------------------------------------------------------------------------------

/**
 * Marks a build of `settings` as running, unless builds with other settings are running (they
 * need the loaded project as it is).
 */
function acquire(shared: Shared, settings: string): boolean {
  if (shared.running > 0 && shared.runningSettings !== settings) return false
  shared.running++
  shared.runningSettings = settings
  return true
}

function releaseRun(shared: Shared): void {
  shared.running--
  if (shared.running === 0) shared.runningSettings = undefined
}

/**
 * Loads the project, or loads it again when the plugin instance was last used with other build
 * settings, a watched file changed since the last load, or the last reload failed; then applies
 * the build's plugin options. Returns whether the project was (re)loaded. Concurrent calls (builds
 * starting together) run one after the other, so a change is reloaded once.
 */
function configure(context: BuildContext): Promise<boolean> {
  const { shared } = context
  const run = shared.configuring.then(
    () => configureNow(context),
    () => configureNow(context),
  )
  shared.configuring = run.catch(() => undefined)
  return run
}

async function configureNow(context: BuildContext): Promise<boolean> {
  const { state, shared } = context
  state.setHints(context.hints)
  let loaded = false
  try {
    if (!state.ready) {
      await state.prepare()
      loaded = true
    } else if (shared.stale || shared.settings !== context.settings) {
      await reload(state)
      loaded = true
    } else {
      const changed = shared.snapshot === undefined ? undefined : await changedFile(shared.snapshot)
      loaded = changed !== undefined && (await state.watchChange(changed))
      if (!loaded) await state.prepare()
    }
  } catch (error) {
    if (state.ready) shared.stale = true
    throw error
  }
  let base = shared.baseOptions
  if (loaded || base === undefined) {
    base = state.options
    shared.baseOptions = base
    shared.settings = context.settings
    shared.stale = false
    shared.snapshot = await takeSnapshot(state.watchFiles())
    shared.seeded.clear()
  }
  state.options = buildOptions(base, context.packagesExternal)
  return loaded
}

/**
 * Loads the project again with the current hints (`PluginState` has no public reset: a watched
 * file stands in for the change when there is one).
 */
async function reload(state: PluginState): Promise<void> {
  const [file] = state.watchFiles()
  if (file !== undefined && (await state.watchChange(file))) return
  await state.flush()
  await state.disposeEngines()
  await state.configure(await state.loadProject())
}

async function onStart(context: BuildContext, filters: Filters): Promise<OnStartResult> {
  const { state, shared } = context
  state.setLogTarget(shared.warnings)
  context.failed = false
  if (!acquire(shared, context.settings)) {
    context.failed = true
    return { errors: [concurrentUseMessage()], warnings: shared.warnings.drain() }
  }
  context.running = true
  try {
    if (await configure(context)) warnAboutStaleFilters(state, filters)
    await seedEntrypoints(context)
  } catch (error) {
    context.failed = true
    return { errors: [toMessage(error)], warnings: shared.warnings.drain() }
  }
  return { warnings: shared.warnings.drain() }
}

function concurrentUseMessage(): PartialMessage {
  return toMessage(
    new DenoPluginError(
      'OPTIONS_INVALID',
      'This unplugin-deno plugin is used by another running esbuild build with a different absWorkingDir, platform, conditions or packages setting.',
      { hint: 'Create one plugin per esbuild build or context: `plugins: [deno()]` in each call.' },
    ),
  )
}

/** Adds the build's entry points to the engine, unless the current engines already have them. */
async function seedEntrypoints(context: BuildContext): Promise<void> {
  const { state, shared, entries } = context
  if (entries.every((entry) => shared.seeded.has(entry))) return
  state.setHints({ input: context.hints.input })
  await state.addEntrypoints()
  for (const entry of entries) shared.seeded.add(entry)
}

/**
 * esbuild takes filters once, at `setup`: import-map keys added while a context runs (and a
 * switch to Deno's global npm cache) are only seen by a new context.
 */
function warnAboutStaleFilters(state: PluginState, filters: Filters): void {
  if (filters.broad) return
  const keys = new Set(state.project.importMap.ownedKeys())
  if (state.platform === 'deno') {
    for (const name of packageJsonDependencyNames(state.project)) keys.add(name)
  }
  const unseen = [...keys]
    .filter((key) => !filters.main.test(key))
    .toSorted()
    .map((key) => `\`${key}\``)
  if (state.npmStrategy === 'deno-cache' && !filters.bare) {
    unseen.push("the imports inside npm packages of Deno's global cache")
  }
  if (unseen.length === 0) return
  state.logger.warn(
    `The project changed after this esbuild context was created: ${unseen.join(', ')} will only be resolved by unplugin-deno in a new context (esbuild reads plugin filters once).`,
  )
}

async function onEnd(context: BuildContext, result: BuildResult): Promise<OnEndResult> {
  const { state, shared } = context
  if (context.running) {
    context.running = false
    releaseRun(shared)
  }
  try {
    await state.flush()
  } catch (error) {
    state.logger.warn(`Cannot write the mirror manifest: ${String(toMessage(error).text)}`)
  }
  state.reportDuplicates()
  const errors: PartialMessage[] = []
  // The sidecar deno.json and deno.lock of Deno platform output (S3), next to the entry output.
  const dir = result.errors.length === 0 ? entryDirectory(context, result) : undefined
  if (dir !== undefined && !context.failed) {
    try {
      await writeSidecar(state, dir)
    } catch (error) {
      errors.push(toMessage(error))
    }
  }
  return { errors, warnings: shared.warnings.drain() }
}

/**
 * The directory of the first entry point's output (from the metafile when there is one), else
 * `outdir` or the directory of `outfile`; `undefined` when esbuild writes nothing (`write: false`)
 * or the plugin writes no sidecar.
 */
function entryDirectory(context: BuildContext, result: BuildResult): string | undefined {
  const { state, root } = context
  if (state.options.emitDenoConfig === false || !state.ready) return undefined
  const options: BuildOptions = context.build.initialOptions
  if (options.write === false) {
    state.logger.debug('[sidecar] esbuild writes no files (`write: false`); no deno.json/deno.lock')
    return undefined
  }
  const outputs = Object.entries(result.metafile?.outputs ?? {})
  const entry = outputs.find(
    ([file, output]) => output.entryPoint !== undefined && /\.m?js$/.test(file),
  )
  if (entry !== undefined) return dirname(resolve(root, entry[0]))
  if (options.outdir !== undefined) return resolve(root, options.outdir)
  if (options.outfile !== undefined) return dirname(resolve(root, options.outfile))
  return undefined
}

/** `onDispose`: the last build or context of the plugin instance disposes the engines. */
function release(state: PluginState, shared: Shared): void {
  shared.active--
  if (shared.active > 0) return
  shared.seeded.clear()
  // Nothing drains the buffer any more: later messages go to stderr.
  state.setLogTarget(undefined)
  const closing: Promise<void> = state
    .close()
    .catch((error: unknown) => state.logger.warn(`Cannot dispose the engines: ${String(error)}`))
    .then(() => {
      if (shared.closing === closing) shared.closing = undefined
    })
  shared.closing = closing
}

// -- resolution -----------------------------------------------------------------------------------

/**
 * Whether the imports of `importer` are resolved through the engine: mirror files and npm
 * packages of Deno's global cache (or of `node_modules` with `npm: 'deno-cache'`).
 */
function isEngineImporter(state: PluginState, importer: string): boolean {
  if (importer === '' || !state.ready) return false
  return (
    state.mirror.isMirrorPath(importer) ||
    isGlobalCachePath(importer, state.denoDirs, state.flavor) ||
    (state.npmStrategy === 'deno-cache' && isNodeModulesPath(importer, state.flavor))
  )
}

async function onResolve(
  context: BuildContext,
  args: OnResolveArgs,
  isExternal: ReturnType<typeof externalMatcher>,
): Promise<OnResolveResult | undefined> {
  const { state } = context
  // esbuild checks its own `external` option only when no plugin resolved the import.
  if (isExternal(args.path, args.kind)) return undefined
  if (CSS_KINDS.has(args.kind) && isUrl(args.path)) return undefined
  // `onStart` failed and esbuild goes on resolving: keep the build to that one error by marking
  // the owned imports external. Paths are never ours (the broad filter used before the project is
  // loaded matches Windows absolute paths such as `C:\…`, including the entry points).
  if (context.failed) return isPathLike(args.path) ? undefined : { path: args.path, external: true }
  const type = args.with.type
  const id =
    state.options.importAttributes && isDenoType(type) ? withDenoType(args.path, type) : args.path
  try {
    const outcome = await state.resolve(id, args.importer === '' ? undefined : args.importer, {
      kind: args.kind,
      isEntry: args.kind === 'entry-point',
    })
    if (args.kind === 'entry-point' && outcome?.type === 'mirror') {
      context.entryPaths.add(splitQuery(outcome.path).base)
    }
    return await toResult(context, outcome, args)
  } catch (error) {
    return { errors: [toMessage(error)] }
  }
}

function isUrl(specifier: string): boolean {
  const { kind } = parseSpecifier(specifier)
  return kind === 'https' || kind === 'http' || kind === 'data'
}

function isPathLike(specifier: string): boolean {
  const { kind } = parseSpecifier(specifier)
  return kind === 'absolute' || kind === 'relative'
}

/** Turns a core outcome into an esbuild `onResolve` result (§5.4, §5.5). */
async function toResult(
  context: BuildContext,
  outcome: ResolveOutcome,
  args: OnResolveArgs,
): Promise<OnResolveResult | undefined> {
  if (outcome === null) return undefined
  // esbuild watches these (config files, import maps, lockfile) in watch mode.
  const watchFiles = context.state.watchFiles()
  switch (outcome.type) {
    case 'path':
      return {
        ...filePath(outcome.path),
        ...(outcome.sideEffects === false ? { sideEffects: false } : {}),
        watchFiles,
      }
    case 'mirror':
      return { ...filePath(outcome.path), watchFiles }
    case 'marker':
      return {
        ...syntheticModule(outcome.path, displayPath(context.root, outcome.path)),
        watchFiles,
      }
    case 'virtual':
      return { ...syntheticModule(outcome.id, virtualDisplayPath(outcome.id)), watchFiles }
    case 'external':
      return { path: outcome.id, external: true, watchFiles }
    case 'npm-redirect':
      return redirect(context, outcome, args, watchFiles)
    case 'host-marker':
      return hostMarker(context, outcome, args, watchFiles)
  }
}

/** A file esbuild loads itself; a query (`?raw`) becomes esbuild's `suffix`. */
function filePath(path: string): { path: string; suffix?: string } {
  const { base, query } = splitQuery(path)
  return query === '' ? { path: base } : { path: base, suffix: query }
}

/**
 * A module the plugin synthesises (`onLoad` in its namespace). Its esbuild path is relative to
 * `absWorkingDir`, so output comments, source maps and the metafile hold no machine-specific
 * paths; the core id travels in `pluginData`.
 */
function syntheticModule(id: string, path: string): OnResolveResult {
  return { path, namespace: NAMESPACE, pluginData: { [ID_KEY]: id } }
}

/**
 * An npm package under `node_modules` (§5.4): esbuild resolves `name + subpath` from inside the
 * package, so it applies `exports` conditions, the `browser` field and `sideEffects`. The
 * importer is the package's `package.json`, as on Rollup: the plugin leaves bare imports from
 * `node_modules` to esbuild, so the request does not come back to it. When esbuild cannot resolve
 * it, the file the engine resolved is used.
 */
async function redirect(
  context: BuildContext,
  outcome: NpmRedirectOutcome,
  args: OnResolveArgs,
  watchFiles: string[],
): Promise<OnResolveResult> {
  const { state, build } = context
  const resolved = await build.resolve(outcome.request, {
    kind: args.kind,
    resolveDir: outcome.resolveDir,
    importer: outcome.packageJsonPath,
    namespace: 'file',
    with: args.with,
    pluginData: args.pluginData,
  })
  if (resolved.errors.length > 0 || resolved.path === '') {
    state.logger.debug(
      `[esbuild] ${outcome.request} does not resolve from ${outcome.resolveDir}; using ${outcome.fallbackPath}`,
    )
    return {
      ...filePath(`${outcome.fallbackPath}${outcome.query}`),
      ...(outcome.sideEffects === false ? { sideEffects: false } : {}),
      warnings: resolved.warnings,
      watchFiles,
    }
  }
  if (resolved.external) {
    return { path: resolved.path, external: true, warnings: resolved.warnings, watchFiles }
  }
  const suffix = outcome.query === '' ? resolved.suffix : outcome.query
  return {
    path: resolved.path,
    namespace: resolved.namespace,
    sideEffects: resolved.sideEffects,
    ...(suffix === '' ? {} : { suffix }),
    pluginData: resolved.pluginData,
    warnings: resolved.warnings,
    watchFiles,
  }
}

/**
 * An import-attribute marker on an import esbuild resolves (a local file, a package from
 * `node_modules`): esbuild resolves the import without the attribute (so no handler sees it as a
 * marker again), and the plugin synthesises the module from the file.
 */
async function hostMarker(
  context: BuildContext,
  outcome: HostMarkerOutcome,
  args: OnResolveArgs,
  watchFiles: string[],
): Promise<OnResolveResult | undefined> {
  const resolved = await context.build.resolve(outcome.request, {
    kind: args.kind,
    resolveDir: args.resolveDir,
    importer: args.importer,
    namespace: args.namespace,
    pluginData: args.pluginData,
  })
  if (resolved.errors.length > 0) return { errors: resolved.errors, warnings: resolved.warnings }
  if (resolved.external) {
    return { path: resolved.path, external: true, warnings: resolved.warnings, watchFiles }
  }
  // Another plugin's module: leave the import (with its attribute) to that plugin.
  if (resolved.namespace !== 'file') return undefined
  const id = withDenoType(`${resolved.path}${resolved.suffix}`, outcome.denoType)
  return {
    ...syntheticModule(id, displayPath(context.root, id)),
    warnings: resolved.warnings,
    watchFiles,
  }
}

// -- loading --------------------------------------------------------------------------------------

/** The core id of a synthesised module (from `pluginData`, else its path). */
function syntheticId(args: OnLoadArgs): string {
  const data: unknown = args.pluginData
  if (typeof data === 'object' && data !== null) {
    const id: unknown = Reflect.get(data, ID_KEY)
    if (typeof id === 'string') return id
  }
  return args.path
}

/**
 * A `.wasm` module import in the `file` namespace (not one with an import attribute or a suffix,
 * which esbuild's loaders handle) as the synthesised JavaScript module.
 */
async function onLoadWasm(
  context: BuildContext,
  args: OnLoadArgs,
): Promise<OnLoadResult | undefined> {
  if (args.namespace !== 'file' || args.suffix !== '' || Object.keys(args.with).length > 0) {
    return undefined
  }
  try {
    const loaded = await context.state.load(args.path)
    if (loaded === null) return undefined
    return { contents: loaded.code, loader: 'js', resolveDir: dirname(args.path) }
  } catch (error) {
    return { errors: [toMessage(error)] }
  }
}

/** Synthesises a marker module (`text`, `bytes`, `css`) or one of the plugin's virtual modules. */
async function onLoad(context: BuildContext, args: OnLoadArgs): Promise<OnLoadResult> {
  const { state } = context
  const id = syntheticId(args)
  try {
    const loaded = await state.load(id)
    if (loaded === null) {
      return { errors: [{ text: `unplugin-deno has no module ${args.path}.` }] }
    }
    const marker = readDenoType(id)
    if (marker === null) return { contents: loaded.code, loader: 'js', resolveDir: context.root }
    const target = splitQuery(marker.base).base
    return {
      contents: loaded.code,
      loader: 'js',
      resolveDir: dirname(target),
      watchFiles: [target],
    }
  } catch (error) {
    return { errors: [toMessage(error)] }
  }
}
