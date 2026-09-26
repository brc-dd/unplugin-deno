import type { ExternalIdResult, UnpluginFactory, UnpluginOptions } from 'unplugin'
import { createVitePlugin } from 'unplugin'
import { esbuildSetup } from '../hosts/esbuild/index.js'
import { rolldownHooks } from '../hosts/rolldown/index.js'
import { rollupHooks } from '../hosts/rollup/index.js'
import { rsbuildHooks } from '../hosts/rsbuild/index.js'
import { rspackApply } from '../hosts/rspack/index.js'
import { viteHooks } from '../hosts/vite/index.js'
import { webpackApply } from '../hosts/webpack/index.js'
import type { HostResolvedId, TransformHostContext } from '../hosts/shared.js'
import { toRollupResult, transformContext } from '../hosts/shared.js'
import { isDenoType } from './attributes.js'
import { withDenoType } from './id.js'
import type { Options } from './options.js'
import { resolveOptions } from './options.js'
import { PluginState, transformCodeFilter } from './state.js'

/** The plugin name reported to every host. */
export const PLUGIN_NAME = 'unplugin-deno'

/** Hosts whose plugins share Rollup's hook semantics and get the generic hooks. */
const ROLLUP_FAMILY: ReadonlySet<string> = new Set(['rollup', 'rolldown', 'vite'])

/**
 * The factory behind every host entry (docs/architecture.md §6): the generic hooks for the
 * Rollup family, with the Rolldown and Rollup specifics under unplugin's escape hatches. esbuild
 * gets only `esbuild.setup` (unplugin's generic esbuild adapter would register a catch-all
 * `onResolve` first, §6.4); webpack, Rspack and Rsbuild get their adapters' hooks (§6.5, §6.6); Bun,
 * Farm and the Node.js loader are not supported yet and get an inert plugin.
 *
 * @throws {DenoPluginError} `OPTIONS_INVALID` for invalid options.
 */
export const unpluginFactory: UnpluginFactory<Options | undefined, false> = (options, meta) => {
  if (meta.framework === 'esbuild') {
    const state = new PluginState(options, meta.framework)
    return { name: PLUGIN_NAME, esbuild: { setup: esbuildSetup(state) } }
  }
  if (meta.framework === 'webpack') {
    const state = new PluginState(options, meta.framework)
    return { name: PLUGIN_NAME, webpack: webpackApply(state) }
  }
  if (meta.framework === 'rspack') {
    const state = new PluginState(options, meta.framework)
    return { name: PLUGIN_NAME, rspack: rspackApply(state) }
  }
  if (meta.framework === 'rsbuild') {
    const state = new PluginState(options, meta.framework)
    return { name: PLUGIN_NAME, rsbuild: rsbuildHooks(state) }
  }
  if (!ROLLUP_FAMILY.has(meta.framework)) {
    resolveOptions(options, { root: process.cwd(), env: process.env })
    return { name: PLUGIN_NAME }
  }
  const state = new PluginState(options, meta.framework)
  const plugin = genericHooks(state)
  if (meta.framework === 'rolldown') plugin.rolldown = rolldownHooks(state)
  if (meta.framework === 'rollup') plugin.rollup = rollupHooks(state)
  if (meta.framework === 'vite') {
    // Vite bundles workers with `worker.plugins`: a plugin instance of their own (D7, §6.1).
    plugin.vite = viteHooks(state, {
      workerPlugins: () => createVitePlugin(viteWorkerFactory)(options),
    })
  }
  return plugin
}

/**
 * The plugin Vite runs in worker bundles (`worker.plugins`, docs/architecture.md §6.1): the
 * generic and Vite hooks of a separate state, without registering itself for workers again (the
 * main config's `worker.plugins` also serves nested workers).
 */
const viteWorkerFactory: UnpluginFactory<Options | undefined, false> = (options, meta) => {
  const state = new PluginState(options, meta.framework)
  const plugin = genericHooks(state)
  plugin.vite = viteHooks(state)
  return plugin
}

/** The Rollup-family context members the generic hooks use at runtime (untyped by unplugin). */
interface RuntimeContext extends TransformHostContext {
  meta?: {
    watchMode?: boolean
    rollupVersion?: string
    rolldownVersion?: string
    viteVersion?: string
  }
  resolve?: (
    source: string,
    importer: string | undefined,
    options: { skipSelf: boolean; kind?: string },
  ) => Promise<HostResolvedId | null>
  addWatchFile?: (file: string) => void
  warn?: (message: string) => void
  info?: (message: string) => void
}

/**
 * The hooks every Rollup-family host gets (Vite uses them as they are; Rolldown and Rollup
 * override some under their escape hatches).
 */
function genericHooks(state: PluginState): UnpluginOptions {
  const codeFilter = transformCodeFilter(state.options)
  const hooks: UnpluginOptions = {
    name: PLUGIN_NAME,
    enforce: 'pre',
    async buildStart() {
      const context = this as RuntimeContext
      state.setLogTarget(context)
      await state.prepare()
      for (const file of state.watchFiles()) context.addWatchFile?.(file)
      await state.addEntrypoints()
    },
    resolveId: {
      filter: { id: state.resolveIdFilter(true) },
      async handler(source, importer, options) {
        const context = this as RuntimeContext
        state.setLogTarget(context)
        const extra = options as { kind?: string; attributes?: Record<string, string> }
        const type = extra.attributes?.type
        const id =
          state.options.importAttributes && isDenoType(type) ? withDenoType(source, type) : source
        const outcome = await state.resolve(id, importer, {
          kind: extra.kind,
          isEntry: options.isEntry,
        })
        const resolve = context.resolve
        // Rollup-family hosts take the whole result (`external: 'absolute'`, `moduleSideEffects`).
        return (await toRollupResult(
          outcome,
          importer,
          resolve === undefined
            ? undefined
            : (request, from) =>
                resolve.call(context, request, from, { skipSelf: true, kind: extra.kind }),
        )) as ExternalIdResult | null
      },
    },
    load: {
      filter: { id: state.loadFilter() },
      async handler(id) {
        state.setLogTarget(this as RuntimeContext)
        return state.load(id)
      },
    },
    transform: {
      filter: { id: { exclude: [/^\0/] }, code: codeFilter ?? /\bwith\s*\{/ },
      async handler(code, id) {
        const context = this as RuntimeContext
        state.setLogTarget(context)
        return state.transform(code, id, transformContext(context, id))
      },
    },
    watchChange(id) {
      return state.watchChange(id) as unknown as void
    },
    async buildEnd() {
      const context = this as RuntimeContext
      state.setLogTarget(context)
      state.reportDuplicates()
      if (context.meta?.watchMode === true) await state.flush()
      else await state.close()
    },
  }
  // Import attributes, `import.meta.main`, env inlining and the `Deno.*` check all off.
  if (codeFilter === null) delete hooks.transform
  return hooks
}
