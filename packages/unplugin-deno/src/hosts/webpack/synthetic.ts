/**
 * Modules the webpack adapter synthesises (docs/architecture.md §5.5, §6.5): import-attribute
 * markers and the plugin's virtual ids. Each is a request in the `unplugin-deno:` scheme: the
 * adapter's `resolveForScheme` hook gives it a JavaScript mimetype, a `module.rules` entry types it
 * `javascript/esm` (after webpack's `with { type }` rules), and webpack's `readResource` hook
 * (`NormalModule.getCompilationHooks`) reads it from `state.load`. Mirror files and local files
 * are real files and need none of this.
 *
 * The resource names the target relative to the compiler context (`unplugin-deno:src/data.txt
 * ?deno-type=text`), so module ids, stats and source maps hold no machine paths.
 *
 * @module
 */
import { posix, win32 } from 'node:path'
import { DENO_VIRTUAL_PREFIX, isDenoVirtualId, splitQuery } from '../../core/id.js'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR } from '../../utils/path.js'

/** The scheme of the synthesised modules. */
export const SCHEME = 'unplugin-deno'

/** The mimetype that makes webpack's default rules parse a scheme resource as JavaScript. */
export const JAVASCRIPT_MIMETYPE = 'text/javascript'

/** The synthesised modules of one compiler: their requests and the core ids behind them. */
export class SyntheticModules {
  readonly #context: string
  readonly #flavor: PathFlavor
  readonly #ids = new Map<string, string>()

  /** `context` is the compiler context the resources are relative to. */
  constructor(context: string, flavor: PathFlavor = HOST_PATH_FLAVOR) {
    this.#context = context
    this.#flavor = flavor
  }

  /** The request of the module for the core id `id` (a marker or one of the plugin's ids). */
  request(id: string): string {
    const request = `${SCHEME}:${syntheticPath(this.#context, id, this.#flavor)}`
    this.#ids.set(request, id)
    return request
  }

  /** The core id of a synthesised module's resource (`undefined` when it is not one of ours). */
  idOf(resource: string): string | undefined {
    return this.#ids.get(resource)
  }
}

/**
 * The resource path of a synthesised module: a marker id's file relative to `context` with
 * `/` separators and its query (`/root/src/data.txt?deno-type=text` → `src/data.txt?deno-type=text`),
 * or `virtual/<name>` for the plugin's virtual ids (`\0deno:empty` → `virtual/empty`).
 */
export function syntheticPath(
  context: string,
  id: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string {
  if (isDenoVirtualId(id)) return `virtual/${id.slice(DENO_VIRTUAL_PREFIX.length)}`
  const syntax = flavor === 'win32' ? win32 : posix
  const { base, query } = splitQuery(id)
  const relative = syntax.relative(context, base)
  return `${flavor === 'win32' ? relative.replaceAll('\\', '/') : relative}${query}`
}
