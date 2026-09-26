/**
 * The Rspack plugin shared by the Rspack adapter (`rspack(compiler)`) and the Rsbuild adapter
 * (one per Rsbuild environment; docs/architecture.md §6.6). Rspack runs `beforeResolve`,
 * `factorize` (externals) and `resolve` hooks like webpack and passes scheme requests to them with
 * their import attributes, so the flow is the webpack adapter's (`../webpack/requests.ts`):
 *
 * - the externals function, applied before the config's externals and presets, resolves owned
 *   requests and keeps external outcomes as native externals;
 * - `normalModuleFactory.hooks.resolve` rewrites the request to the file (mirror files are real
 *   files) or to `name + subpath` from the package directory for npm redirects;
 * - synthesised modules (import-attribute markers) are virtual files loaded through unplugin's
 *   Rspack loader (`synthetic.ts`); Rspack has no `resolveInScheme` and never calls
 *   `readResource`, and needs neither;
 * - `externalsPresets.web` (`http(s):`, `//` and `std:` imports) is turned off unless set
 *   explicitly and applied to the requests the plugin leaves to Rspack; `experiments.buildHttp`
 *   keeps the URLs it allows;
 * - once the project is loaded (`beforeRun`/`watchRun`; Rspack reads `module.rules` when it
 *   creates its native compiler, at the first build), rules run the source transforms on local
 *   script modules, load mirror files through unplugin's `load` loader (code and source map) and
 *   load `.wasm` module imports (`../webpack/transforms.ts`), and the `deno.json` JSX settings go
 *   to the `builtin:swc-loader` (and esbuild-loader, swc-loader) rules that do not configure JSX
 *   (`../webpack/jsx.ts`);
 * - npm packages bundled in several versions are reported when a compilation has built its
 *   modules (`finishModules`), for the compiler's platform.
 *
 * TypeScript in local files is the user's `builtin:swc-loader` rule; synthesised modules and
 * mirror files are JavaScript.
 *
 * @module
 */
import type { RspackCompiler } from 'unplugin'
import type { ResolveTarget } from '../../core/resolve.js'
import { writeSidecar } from '../../core/sidecar.js'
import type { PluginState, StateHints } from '../../core/state.js'
import { configureJsx } from '../webpack/jsx.js'
import type { ExplicitPresets } from '../webpack/presets.js'
import { presetMessages, takeOverPresets } from '../webpack/presets.js'
import type { RouterHost } from '../webpack/requests.js'
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
} from '../webpack/requests.js'
import { SourceTransforms } from '../webpack/transforms.js'
import { VirtualModules } from './synthetic.js'

/** Options of {@link applyRspack}. */
export interface RspackAdapterOptions {
  /** The resolve target of an Rsbuild environment; the build's own platform when omitted. */
  target?: ResolveTarget | undefined
  /**
   * Plain Rspack (`true`): the compiler is the whole build, so it sets the host hints and closes
   * the plugin state when done. Rsbuild environments share a state that Rsbuild's hooks set up
   * and close.
   */
  standalone: boolean
  /** Shared by the compilers of one state (Rsbuild environments); a new one otherwise. */
  reloader?: ConfigReloader | undefined
}

/** The Rspack version of a compiler (`rspackVersion`; `version` is webpack's compatible one). */
export function rspackVersion(compiler: RspackCompiler): string {
  return compiler.rspack.rspackVersion
}

/** Applies the plugin to an Rspack compiler (see the module documentation). */
export function applyRspack(
  state: PluginState,
  compiler: RspackCompiler,
  options: RspackAdapterOptions,
): void {
  const { target, standalone } = options
  const log = new CompilationLog(compiler.getInfrastructureLogger(TAP_NAME))
  state.setLogTarget(log)
  // The host resolves every import with its attributes (the transform pre-pass is not needed).
  state.nativeAttributes = true
  const router = new Router(state, 'rspack', target)
  const reloader = options.reloader ?? new ConfigReloader(state)
  const virtual = new VirtualModules(state, compiler)
  const watched = new WatchedFiles()
  const transforms = new SourceTransforms(state, {
    host: 'rspack',
    platform: () => router.platform,
    log,
  })
  // Before Rspack applies its defaults: what the user set.
  const explicit: ExplicitPresets = {
    web: compiler.options.externalsPresets.web,
    webAsync: compiler.options.externalsPresets.webAsync,
  }
  const conditions = conditionNames(compiler.options.resolve)
  /** Host facts, read once Rspack has applied its defaults (`compiler.platform`). */
  const hints = (): StateHints => ({
    root: compiler.context,
    platform: platformHint(compiler.platform, compiler.options.target),
    conditions,
    input: entryInput(compiler.options.entry, compiler.context),
    version: rspackVersion(compiler),
    command: 'build',
  })
  let seeded = false
  let setup: Promise<void> | undefined
  /**
   * Loads the project (standalone compilers) and adds what depends on it to the config, once,
   * before Rspack reads `module.rules` (`beforeRun`, `watchRun`, or `beforeCompile` for hosts that
   * compile directly). A failure is retried by the next build.
   */
  const configure = (): Promise<void> => {
    setup ??= (async () => {
      state.setLogTarget(log)
      if (standalone && !state.ready) state.setHints(hints())
      await state.prepare()
      const { rules } = compiler.options.module
      const added = await transforms.rules()
      configureJsx(state, rules, 'rspack')
      rules.push(...added)
    })()
    const current = setup
    current.catch(() => {
      if (setup === current) setup = undefined
    })
    return current
  }

  // Applied now, so it runs before the externals and presets Rspack applies from the options.
  new compiler.rspack.ExternalsPlugin('module-import', (data, callback) => {
    const info = {
      request: data.request ?? '',
      context: data.context ?? '',
      issuer: data.contextInfo?.issuer ?? '',
    }
    router.external(info, data.dependencyType ?? '').then(
      (external) =>
        external === undefined ? callback() : callback(undefined, external.request, external.type),
      (error: unknown) => callback(toHostError(error)),
    )
  }).apply(compiler)

  // After Rspack's `with { type }` rules, which would make markers assets.
  compiler.options.module.rules.push(virtual.rule())

  // After Rspack applied its defaults and before it applies the presets.
  compiler.hooks.environment.tap(TAP_NAME, () => {
    const { options: config } = compiler
    const decision = takeOverPresets(config.externalsPresets, explicit, 'rspack', true)
    const buildHttp = buildHttpMatcher(config.experiments.buildHttp)
    router.settings = {
      presets: decision.taken,
      buildHttp,
      outputModule: config.output.module === true,
    }
    if (standalone) state.setHints(hints())
    for (const message of presetMessages(decision, 'rspack', buildHttp !== undefined)) {
      state.logger.info(message)
    }
  })

  compiler.hooks.beforeRun.tapPromise(TAP_NAME, configure)

  compiler.hooks.beforeCompile.tapPromise(TAP_NAME, async () => {
    state.setLogTarget(log)
    await configure()
    if (!seeded) {
      seeded = true
      await state.addEntrypoints(target, entryInput(compiler.options.entry, compiler.context))
    }
  })

  let generation = reloader.generation
  compiler.hooks.watchRun.tapPromise(TAP_NAME, async (watching) => {
    state.setLogTarget(log)
    await configure()
    const changed = [...(watching.modifiedFiles ?? []), ...(watching.removedFiles ?? [])]
    await reloader.reload(changed)
    if (reloader.generation === generation) return
    // The project was reloaded (here or by another environment's compiler).
    generation = reloader.generation
    seeded = false
    // Rspack keeps the module graph between rebuilds and resolves again only the imports of the
    // modules it rebuilds (it reads `modifiedFiles` after this hook): rebuild the importers of
    // the plugin's requests, so they resolve with the reloaded import map and lockfile.
    watching.modifiedFiles = new Set([...(watching.modifiedFiles ?? []), ...router.importers])
  })

  compiler.hooks.thisCompilation.tap(TAP_NAME, (compilation) => {
    router.clear()
    log.attach((message) => {
      compilation.warnings.push(new compiler.rspack.WebpackError(message))
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
  compiler.hooks.compilation.tap(TAP_NAME, (_compilation, { normalModuleFactory }) => {
    // Entry modules keep `import.meta.main` (the source transforms, §5.10).
    normalModuleFactory.hooks.afterResolve.tap(TAP_NAME, (data) => {
      transforms.entries.note(data.contextInfo.issuer, data.createData?.resource)
    })
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
            const resolver = normalModuleFactory.getResolver('normal', { dependencyType: 'esm' })
            resolver.resolve({}, context, request, {}, (error, result) => {
              if (error) reject(error)
              else resolve(typeof result === 'string' ? result : false)
            })
          }),
        synthetic: async (id) => virtual.request(id),
        dependOn: (files) => {
          for (const file of files) {
            if (watched.isMissing(file)) data.missingDependencies.push(file)
            else data.fileDependencies.push(file)
          }
        },
      }
      await router.apply(data, data.contextInfo.issuer, data.attributes, host)
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
      if (standalone && !compiler.watchMode) await state.close()
      else await state.flush()
    } catch (error) {
      log.warn(`Cannot write the mirror manifest: ${String(error)}`)
      log.flush()
    }
  })
  if (standalone) {
    compiler.hooks.watchClose.tap(TAP_NAME, () => {
      log.flush()
      state.close().catch(() => undefined)
    })
    compiler.hooks.shutdown.tapPromise(TAP_NAME, async () => {
      log.flush()
      await state.close()
    })
  }
}
