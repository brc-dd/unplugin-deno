/**
 * Rolldown (and tsdown) hooks, placed under unplugin's `rolldown` escape hatch for native typings
 * (docs/architecture.md §6.2): Rust-side filters, `options` for the platform, root and inputs, npm
 * redirects through `this.resolve` (forwarding `moduleSideEffects`), and `moduleType: 'js'` for
 * mirrored and synthesised modules. Import attributes use the generic transform pre-pass; the
 * `deno.json` JSX settings become `transform.jsx` unless the options set it (§5.11).
 *
 * @module
 */
import type { InputOptions, Plugin as RolldownPlugin } from 'rolldown'
import type { PluginState } from '../../core/state.js'
import { oxcJsxOptions, toRollupResult } from '../shared.js'

/** The Rolldown-specific hooks of the plugin (merged over the generic ones by unplugin). */
export function rolldownHooks(state: PluginState): Partial<RolldownPlugin> {
  const resolveFilter = { id: state.resolveIdFilter(true) }
  const loadFilter = { id: state.loadFilter() }
  return {
    // The filters are read when Rolldown builds its plugin bindings, after this hook: load the
    // project here so they can name the import-map keys and the mirror directory. In watch mode
    // the resolveId filter stays broad, because the import map may change without a restart.
    async options(inputOptions) {
      state.setLogTarget(this)
      state.setHints({
        root: inputOptions.cwd,
        // Rolldown's default for ES module output (`node` only for `cjs`).
        platform: inputOptions.platform ?? 'browser',
        conditions: inputOptions.resolve?.conditionNames,
        input: inputOptions.input,
        version: this.meta.rolldownVersion,
      })
      await state.prepare()
      if (!this.meta.watchMode) resolveFilter.id = state.resolveIdFilter()
      loadFilter.id = state.loadFilter()
      return withJsx(state, inputOptions)
    },
    resolveId: {
      filter: resolveFilter,
      async handler(source, importer, extra) {
        state.setLogTarget(this)
        const outcome = await state.resolve(source, importer, {
          kind: extra.kind,
          isEntry: extra.isEntry,
        })
        return toRollupResult(outcome, importer, (request, from) =>
          this.resolve(request, from, { skipSelf: true, kind: extra.kind }),
        )
      },
    },
    load: {
      filter: loadFilter,
      async handler(id) {
        state.setLogTarget(this)
        const loaded = await state.load(id)
        if (loaded === null) return null
        return { code: loaded.code, map: loaded.map ?? null, moduleType: 'js' }
      },
    },
    async closeBundle() {
      state.setLogTarget(this)
      if (this.meta.watchMode) await state.flush()
      else await state.close()
    },
  }
}

/**
 * The input options with the `deno.json` JSX settings as `transform.jsx`, or `null` (no change)
 * when the options set JSX or the project configures none.
 */
function withJsx(state: PluginState, inputOptions: InputOptions): InputOptions | null {
  if (inputOptions.transform?.jsx !== undefined) return null
  const decision = state.jsxTransform('Rolldown')
  if (decision === null) return null
  return {
    ...inputOptions,
    transform: { ...inputOptions.transform, jsx: oxcJsxOptions(decision.transform) },
  }
}
