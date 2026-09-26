/**
 * Modules the Rspack adapter synthesises (docs/architecture.md §5.5, §6.6): import-attribute
 * markers and the plugin's virtual ids. Rspack types `NormalModule.getCompilationHooks().
 * readResource` but never calls it (rspack#12210), so each synthesised module is an empty file of
 * Rspack's native `experiments.VirtualModulesPlugin` under `node_modules/.virtual/unplugin-deno/`
 * (unplugin's own layout), whose code comes from unplugin's Rspack `load` loader calling
 * `state.load`. The loader registers the marker's target as a dependency, so edits of the target
 * rebuild the module in watch mode (rewriting the virtual file would not); a `.js` path keeps the
 * user's rules for the target's extension (CSS, text loaders) away from it.
 *
 * @module
 */
import { basename, join, normalize } from 'node:path'
import type { RspackCompiler } from 'unplugin'
import { readDenoType, splitQuery } from '../../core/id.js'
import type { PluginState } from '../../core/state.js'
import { shortHash } from '../../utils/hash.js'
import type { LoaderUse } from '../webpack/requests.js'
import { loadLoader, toHostError } from '../webpack/requests.js'
import { syntheticPath } from '../webpack/synthetic.js'

/** The `module.rules` entry of the synthesised modules. */
export interface VirtualModulesRule {
  include: (path: string) => boolean
  type: 'javascript/esm'
  use: LoaderUse[]
}

/** The synthesised modules of one Rspack compiler. */
export class VirtualModules {
  readonly #state: PluginState
  readonly #context: string
  readonly #dir: string
  readonly #plugin: InstanceType<RspackCompiler['rspack']['experiments']['VirtualModulesPlugin']>
  /** Virtual path (normalised) → core id. */
  readonly #ids = new Map<string, string>()

  /** Applies a `VirtualModulesPlugin` to `compiler` (from `rspack(compiler)` or Rsbuild). */
  constructor(state: PluginState, compiler: RspackCompiler) {
    this.#state = state
    this.#context = compiler.context
    this.#dir = join(compiler.context, 'node_modules', '.virtual', 'unplugin-deno')
    this.#plugin = new compiler.rspack.experiments.VirtualModulesPlugin()
    this.#plugin.apply(compiler)
  }

  /**
   * The request of the module for the core id `id` (a marker or one of the plugin's ids): a
   * stable path (a hash of the id relative to the compiler context, then the target's name, the
   * marker type and `.js`), written empty the first time.
   */
  request(id: string): string {
    const display = syntheticPath(this.#context, id)
    const marker = readDenoType(id)
    const name =
      marker === null
        ? basename(display)
        : `${basename(splitQuery(marker.base).base)}.${marker.type}`
    const path = normalize(join(this.#dir, shortHash(display), `${name}.js`))
    if (!this.#ids.has(path)) {
      this.#ids.set(path, id)
      this.#plugin.writeModule(path, '')
    }
    return path
  }

  /** Whether `path` is one of the synthesised modules (the rule's condition). */
  has(path: string): boolean {
    return this.#ids.has(normalize(path))
  }

  /** The rule that loads the synthesised modules: `javascript/esm` through unplugin's loader. */
  rule(): VirtualModulesRule {
    const state = this.#state
    const ids = this.#ids
    return {
      include: (path) => this.has(path),
      type: 'javascript/esm',
      use: [
        loadLoader('rspack', async function load(path) {
          const id = ids.get(normalize(path))
          if (id === undefined) return null
          const loaded = await state.load(id).catch((error: unknown) => {
            throw toHostError(error)
          })
          if (loaded === null) return null
          const marker = readDenoType(id)
          if (marker !== null) this.addWatchFile(splitQuery(marker.base).base)
          return { code: loaded.code }
        }),
      ],
    }
  }
}
