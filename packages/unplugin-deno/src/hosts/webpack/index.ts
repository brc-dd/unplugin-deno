/**
 * The webpack adapter (docs/architecture.md §6.5), through unplugin's `webpack(compiler)` escape
 * hatch: unplugin's generic `resolveId` never sees scheme requests on webpack (`jsr:`, `npm:` and
 * `https:` take the `resolveForScheme` path, or a preset keeps them external first) and its
 * `external: true` is ignored, so the adapter uses webpack's own hooks:
 *
 * - an externals function, applied before the config's externals and presets, resolves the
 *   requests the plugin owns (in `factorize`, where the dependency type is known; the attribute
 *   type comes from `beforeResolve`) and keeps external outcomes as native externals (pinned
 *   `npm:`/`jsr:` specifiers on the Deno platform, `node:` builtins);
 * - `normalModuleFactory.hooks.resolve` rewrites the request to the file (local, npm and mirror
 *   files are real files, loaded with the user's rules) or, for npm packages under
 *   `node_modules`, to `name + subpath` resolved from the package directory (§5.4);
 * - import-attribute markers are `unplugin-deno:` scheme modules read through
 *   `NormalModule.getCompilationHooks(compilation).readResource` (`synthetic.ts`);
 * - `externalsPresets.web` and `.deno` (`target: 'deno'`) are turned off in the `environment`
 *   hook unless set explicitly, and applied by the adapter to the requests the plugin leaves to
 *   webpack (`presets.ts`); `experiments.buildHttp` keeps the URLs it allows;
 * - once the project is loaded (`beforeRun`/`watchRun`, before webpack compiles `module.rules`),
 *   rules run the source transforms on local script modules, load mirror files through unplugin's
 *   `load` loader (`state.load`: the code without its `sourceMappingURL` comment, and the source
 *   map, so output source maps hold the remote sources, named next to the mirror file) and load
 *   `.wasm` module imports (`transforms.ts`), and the `deno.json` JSX settings go to the
 *   esbuild-loader and swc-loader rules that do not configure JSX (`jsx.ts`);
 * - npm packages bundled in several versions are reported when a compilation has built its
 *   modules (`finishModules`); browser-safety warnings come from the resolutions;
 * - the platform hint is `compiler.platform` (`deno` for `target: 'deno'`), the root
 *   `compiler.context`, the entry points `compiler.options.entry`; config files are watched
 *   (`fileDependencies`, or `missingDependencies` for a lockfile not created yet; `watchRun`)
 *   and invalidate the persistent cache (`buildDependencies`).
 *
 * @module
 */
import type { WebpackCompiler } from 'unplugin'
import { readDenoType, splitQuery } from '../../core/id.js'
import { writeSidecar } from '../../core/sidecar.js'
import type { PluginState, StateHints } from '../../core/state.js'
import { configureJsx } from './jsx.js'
import type { ExplicitPresets } from './presets.js'
import { presetMessages, takeOverPresets } from './presets.js'
import type { RouterHost } from './requests.js'
import {
  buildHttpMatcher,
  CompilationLog,
  ConfigReloader,
  conditionNames,
  entryInput,
  platformHint,
  Router,
  TAP_NAME,
  toHostError,
  WatchedFiles,
} from './requests.js'
import { JAVASCRIPT_MIMETYPE, SCHEME, SyntheticModules } from './synthetic.js'
import { SourceTransforms } from './transforms.js'

/** Builds the `webpack(compiler)` hook of the plugin. */
export function webpackApply(state: PluginState): (compiler: WebpackCompiler) => void {
  return (compiler) => applyWebpack(state, compiler)
}

function applyWebpack(state: PluginState, compiler: WebpackCompiler): void {
  const log = new CompilationLog(compiler.getInfrastructureLogger(TAP_NAME))
  state.setLogTarget(log)
  // The host resolves every import with its attributes (the transform pre-pass is not needed).
  state.nativeAttributes = true
  const router = new Router(state, 'webpack')
  const reloader = new ConfigReloader(state)
  const synthetic = new SyntheticModules(compiler.context)
  const watched = new WatchedFiles()
  const transforms = new SourceTransforms(state, {
    host: 'webpack',
    platform: () => router.platform,
    log,
  })
  // Before webpack applies its defaults: what the user set.
  const explicit: ExplicitPresets = {
    web: compiler.options.externalsPresets.web,
    webAsync: compiler.options.externalsPresets.webAsync,
    deno: compiler.options.externalsPresets.deno,
  }
  const conditions = conditionNames(compiler.options.resolve)
  /** Host facts, read once webpack has applied its defaults (`compiler.platform`). */
  const hints = (): StateHints => ({
    root: compiler.context,
    platform: platformHint(compiler.platform, compiler.options.target),
    conditions,
    input: entryInput(compiler.options.entry, compiler.context),
    version: compiler.webpack.version,
    command: 'build',
  })
  let seeded = false
  let setup: Promise<void> | undefined
  /**
   * Loads the project and adds what depends on it to the config, once, before webpack compiles
   * `module.rules` (`beforeRun`, `watchRun`; `beforeCompile` for hosts that compile directly,
   * whose first compilation then misses the rules). A failure is retried by the next build.
   */
  const configure = (): Promise<void> => {
    setup ??= (async () => {
      state.setLogTarget(log)
      if (!state.ready) state.setHints(hints())
      await state.prepare()
      const { rules } = compiler.options.module
      const added = await transforms.rules()
      configureJsx(state, rules, 'webpack')
      rules.push(...added)
    })()
    const current = setup
    current.catch(() => {
      if (setup === current) setup = undefined
    })
    return current
  }

  // Applied now, so it runs before the externals and presets webpack applies from the options.
  new compiler.webpack.ExternalsPlugin('module-import', (data, callback) => {
    const { request, context, contextInfo, dependencyType } = data
    router.external({ request, context, issuer: contextInfo.issuer }, dependencyType).then(
      // `<type> <request>`: webpack reads the external type from the value.
      (external) =>
        external === undefined
          ? callback()
          : callback(null, `${external.type} ${external.request}`),
      (error: unknown) => callback(toHostError(error)),
    )
  }).apply(compiler)

  // After webpack's `with { type }` rules, which would make markers assets.
  compiler.options.module.rules.push({ scheme: SCHEME, type: 'javascript/esm' })

  // After webpack applied its defaults and before it applies the presets and plugins.
  compiler.hooks.environment.tap(TAP_NAME, () => {
    const { options } = compiler
    const decision = takeOverPresets(
      options.externalsPresets,
      explicit,
      'webpack',
      // `"auto"` when webpack enabled CSS itself.
      Boolean(options.experiments.css),
    )
    const buildHttp = buildHttpMatcher(options.experiments.buildHttp)
    router.settings = {
      presets: decision.taken,
      buildHttp,
      outputModule: options.output.module === true,
    }
    state.setHints(hints())
    for (const message of presetMessages(decision, 'webpack', buildHttp !== undefined)) {
      state.logger.info(message)
    }
  })

  compiler.hooks.beforeRun.tapPromise(TAP_NAME, configure)

  compiler.hooks.beforeCompile.tapPromise(TAP_NAME, async () => {
    state.setLogTarget(log)
    await configure()
    if (!seeded) {
      seeded = true
      await state.addEntrypoints()
    }
  })

  // webpack factorizes the imports of every module again in each compilation, so a reloaded
  // project applies without rebuilding modules.
  compiler.hooks.watchRun.tapPromise(TAP_NAME, async (watching) => {
    state.setLogTarget(log)
    await configure()
    const changed = [...(watching.modifiedFiles ?? []), ...(watching.removedFiles ?? [])]
    if (await reloader.reload(changed)) seeded = false
  })

  compiler.hooks.thisCompilation.tap(TAP_NAME, (compilation) => {
    router.clear()
    log.attach((message) => {
      compilation.warnings.push(new compiler.webpack.WebpackError(message))
    })
    // Missing files (a lockfile not created yet) are watched for their creation; all of them
    // invalidate the persistent cache.
    const files = state.watchFiles()
    const { existing, missing } = watched.update(files)
    for (const file of existing) compilation.fileDependencies.add(file)
    for (const file of missing) compilation.missingDependencies.add(file)
    for (const file of files) compilation.buildDependencies.add(file)
    // Every import is resolved once the modules are built: report duplicate npm packages (X4).
    compilation.hooks.finishModules.tap(TAP_NAME, () => {
      state.setLogTarget(log)
      if (state.ready) state.reportDuplicates(router.platform)
    })
  })

  // `compilation` (not `thisCompilation`): child compilations resolve Deno specifiers too.
  compiler.hooks.compilation.tap(TAP_NAME, (compilation, { normalModuleFactory }) => {
    normalModuleFactory.hooks.beforeResolve.tap(TAP_NAME, (data) => {
      router.note(
        { request: data.request, context: data.context, issuer: data.contextInfo.issuer },
        data.attributes,
      )
    })
    normalModuleFactory.hooks.resolve.tapPromise(TAP_NAME, async (data) => {
      const host: RouterHost = {
        resolve: (context, request) =>
          new Promise((resolve, reject) => {
            const resolver = normalModuleFactory.getResolver('normal', {
              ...data.resolveOptions,
              dependencyType: data.dependencyType,
            })
            const resolveContext = {
              fileDependencies: data.fileDependencies,
              missingDependencies: data.missingDependencies,
              contextDependencies: data.contextDependencies,
            }
            resolver.resolve(
              data.contextInfo,
              context,
              request,
              resolveContext,
              (error, result) => {
                if (error) reject(error)
                else resolve(typeof result === 'string' ? result : false)
              },
            )
          }),
        synthetic: async (id) => synthetic.request(id),
        dependOn: (files) => {
          for (const file of files) {
            if (watched.isMissing(file)) data.missingDependencies.add(file)
            else data.fileDependencies.add(file)
          }
        },
      }
      await router.apply(data, data.contextInfo.issuer, data.attributes, host, data.dependencyType)
    })
    // Entry modules keep `import.meta.main` (the source transforms, §5.10).
    normalModuleFactory.hooks.afterResolve.tap(TAP_NAME, (data) => {
      transforms.entries.note(
        data.contextInfo.issuer,
        data.createData.resource,
        data.dependencyType,
      )
    })
    normalModuleFactory.hooks.resolveForScheme.for(SCHEME).tap(TAP_NAME, (resource) => {
      resource.data.mimetype = JAVASCRIPT_MIMETYPE
      return true
    })
    const { readResource } = compiler.webpack.NormalModule.getCompilationHooks(compilation)
    readResource.for(SCHEME).tapPromise(TAP_NAME, async (loaderContext) => {
      const id = synthetic.idOf(loaderContext.resource)
      if (id === undefined)
        throw new Error(`unplugin-deno has no module ${loaderContext.resource}.`)
      const loaded = await state.load(id).catch((error: unknown) => {
        throw toHostError(error)
      })
      if (loaded === null) throw new Error(`unplugin-deno has no module ${loaderContext.resource}.`)
      // Edits of the target rebuild the marker module (watch mode, persistent cache).
      const marker = readDenoType(id)
      if (marker !== null) loaderContext.addDependency(splitQuery(marker.base).base)
      return loaded.code
    })
  })

  compiler.hooks.done.tapPromise(TAP_NAME, async () => {
    log.detach()
    // The Deno-platform sidecar (`emitDenoConfig`, docs/plan.md S3) goes next to the output,
    // before the engines are disposed below.
    try {
      await writeSidecar(state, compiler.outputPath, { platform: router.platform })
    } catch (error) {
      log.warn(`Cannot write the sidecar deno.json/deno.lock: ${String(error)}`)
      log.flush()
    }
    try {
      if (compiler.watchMode) await state.flush()
      else await state.close()
    } catch (error) {
      log.warn(`Cannot write the mirror manifest: ${String(error)}`)
      log.flush()
    }
  })
  compiler.hooks.watchClose.tap(TAP_NAME, () => {
    log.flush()
    state.close().catch(() => undefined)
  })
  compiler.hooks.shutdown.tapPromise(TAP_NAME, async () => {
    log.flush()
    await state.close()
  })
}
