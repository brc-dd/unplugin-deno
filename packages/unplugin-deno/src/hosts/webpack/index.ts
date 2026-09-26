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
 * - mirror files are loaded through unplugin's `load` loader (`state.load`: the code without its
 *   `sourceMappingURL` comment, and the source map), so output source maps hold the remote
 *   sources, named next to the mirror file;
 * - the platform hint is `compiler.platform` (`deno` for `target: 'deno'`), the root
 *   `compiler.context`, the entry points `compiler.options.entry`; config files are watched
 *   (`fileDependencies`, `watchRun`) and invalidate the persistent cache (`buildDependencies`).
 *
 * @module
 */
import type { WebpackCompiler } from 'unplugin'
import { readDenoType, splitQuery } from '../../core/id.js'
import type { PluginState, StateHints } from '../../core/state.js'
import type { ExplicitPresets } from './presets.js'
import { presetMessages, takeOverPresets } from './presets.js'
import type { RouterHost } from './requests.js'
import {
  buildHttpMatcher,
  CompilationLog,
  ConfigReloader,
  conditionNames,
  entryInput,
  loadLoader,
  mirrorLoad,
  platformHint,
  Router,
  TAP_NAME,
  toHostError,
} from './requests.js'
import { JAVASCRIPT_MIMETYPE, SCHEME, SyntheticModules } from './synthetic.js'

/** Code files of the mirror (raw assets have no source maps). */
const CODE_FILE = /\.[cm]?js$/

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

  compiler.options.module.rules.push(
    // After webpack's `with { type }` rules, which would make markers assets.
    { scheme: SCHEME, type: 'javascript/esm' },
    {
      test: CODE_FILE,
      include: (path: string) => state.ready && state.mirror.isMirrorPath(path),
      use: [loadLoader('webpack', mirrorLoad(state))],
    },
  )

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

  compiler.hooks.beforeCompile.tapPromise(TAP_NAME, async () => {
    state.setLogTarget(log)
    if (!state.ready) state.setHints(hints())
    await state.prepare()
    if (!seeded) {
      seeded = true
      await state.addEntrypoints()
    }
  })

  // webpack factorizes the imports of every module again in each compilation, so a reloaded
  // project applies without rebuilding modules.
  compiler.hooks.watchRun.tapPromise(TAP_NAME, async (watching) => {
    state.setLogTarget(log)
    const changed = [...(watching.modifiedFiles ?? []), ...(watching.removedFiles ?? [])]
    if (await reloader.reload(changed)) seeded = false
  })

  compiler.hooks.thisCompilation.tap(TAP_NAME, (compilation) => {
    router.clear()
    log.attach((message) => {
      compilation.warnings.push(new compiler.webpack.WebpackError(message))
    })
    for (const file of state.watchFiles()) {
      compilation.fileDependencies.add(file)
      compilation.buildDependencies.add(file)
    }
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
          for (const file of files) data.fileDependencies.add(file)
        },
      }
      await router.apply(data, data.contextInfo.issuer, data.attributes, host, data.dependencyType)
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
