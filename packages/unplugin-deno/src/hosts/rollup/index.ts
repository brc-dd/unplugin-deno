/**
 * Rollup 4 hooks, placed under unplugin's `rollup` escape hatch for native typings
 * (docs/architecture.md §6.3). Rollup passes import attributes to `resolveId`, where they become
 * the `deno-type` marker; `resolveId` has no id filter because imports with attributes (local
 * `./data.txt` included) must reach it. Rollup resolves each specifier once per module, so the
 * generic transform pre-pass stays on (it gives `x` imported as `text` and as `bytes` distinct
 * sources); the `resolveId` path covers code the pre-pass cannot read (JSX). Rollup has no
 * `moduleType`; mirrored code is JavaScript and local TypeScript is the user's TypeScript plugin's
 * job. The `deno.json` JSX settings become Rollup's `jsx` option unless it is set (§5.11): it
 * applies to JSX the TypeScript plugin preserves.
 *
 * @module
 */
import type { Plugin as RollupPlugin } from 'rollup'
import { isDenoType } from '../../core/attributes.js'
import { isOwnedSpecifier, withDenoType } from '../../core/id.js'
import type { PluginState } from '../../core/state.js'
import { rollupJsxOptions, toRollupResult } from '../shared.js'

/** The Rollup-specific hooks of the plugin (merged over the generic ones by unplugin). */
export function rollupHooks(state: PluginState): Partial<RollupPlugin> {
  const loadFilter = { id: state.loadFilter() }
  return {
    async options(inputOptions) {
      state.setLogTarget(this)
      state.setHints({ input: inputOptions.input as never, version: this.meta.rollupVersion })
      if (inputOptions.jsx !== undefined) return null
      await state.prepare()
      const decision = state.jsxTransform('Rollup')
      return decision === null
        ? null
        : { ...inputOptions, jsx: rollupJsxOptions(decision.transform) }
    },
    async resolveId(source, importer, options) {
      state.setLogTarget(this)
      const type = options.attributes?.type
      const id =
        state.options.importAttributes && isDenoType(type) ? withDenoType(source, type) : source
      await state.prepare()
      if (!isOwnedSpecifier(id, state.resolveIdFilter())) return null
      const outcome = await state.resolve(id, importer, { isEntry: options.isEntry })
      return toRollupResult(outcome, importer, (request, from) =>
        this.resolve(request, from, { skipSelf: true }),
      )
    },
    load: {
      // Rollup ≥ 4.40 applies the filter natively; the handler checks the id again for older ones.
      filter: loadFilter,
      async handler(id) {
        state.setLogTarget(this)
        const loaded = await state.load(id)
        return loaded === null ? null : { code: loaded.code, map: loaded.map ?? null }
      },
    },
    async closeBundle() {
      state.setLogTarget(this)
      if (this.meta.watchMode) await state.flush()
      else await state.close()
    },
  }
}
