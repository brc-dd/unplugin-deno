/**
 * Import-attribute markers in Vite (docs/architecture.md §5.5, §6.1). The core marker id
 * `<file>?deno-type=<type>` keeps the target's extension in front of a query, and Vite's own
 * plugins claim ids by that extension whatever follows (`vite:css` matches `.css?…`, `vite:json`
 * matches `.json?…`, framework plugins match `.vue?…`) and would transform the synthesised
 * JavaScript as CSS or JSON. In Vite a marker therefore resolves to a virtual id that hides the
 * extension: `\0deno:<type>:<file>.js`, with `/` separators so dev-server URLs round-trip.
 *
 * @module
 */
import type { DenoType } from '../../core/id.js'
import { DENO_VIRTUAL_PREFIX, readDenoType, splitQuery, withDenoType } from '../../core/id.js'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR } from '../../utils/path.js'

/** Matches the virtual ids of {@link viteMarkerId} (for `load` filters). */
export const VITE_MARKER_ID_FILTER: RegExp = /^\0deno:(?:text|bytes|css):/

const VITE_MARKER_ID = /^\0deno:(text|bytes|css):(.+)\.js$/

/** A marker module in Vite: the file it reads and the attribute type. */
export interface ViteMarker {
  /** The target file (a local file or a mirror file), `/`-separated on Windows too. */
  path: string
  type: DenoType
}

/**
 * The Vite id of a marker module for `file` imported `with { type }`: `\0deno:<type>:<file>.js`.
 * A query on `file` is dropped: the module is the file's content either way.
 */
export function viteMarkerId(
  file: string,
  type: DenoType,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string {
  const { base } = splitQuery(file)
  const path = flavor === 'win32' ? base.replaceAll('\\', '/') : base
  return `${DENO_VIRTUAL_PREFIX}${type}:${path}.js`
}

/**
 * The Vite id for a core marker id (`<file>?deno-type=<type>`, possibly with other query
 * parameters), or `null` when `id` carries no marker.
 */
export function viteMarkerIdFor(id: string, flavor: PathFlavor = HOST_PATH_FLAVOR): string | null {
  const marker = readDenoType(id)
  return marker === null ? null : viteMarkerId(marker.base, marker.type, flavor)
}

/** Parses a {@link viteMarkerId}; `null` for any other id. */
export function parseViteMarkerId(id: string): ViteMarker | null {
  const match = VITE_MARKER_ID.exec(splitQuery(id).base)
  if (match === null) return null
  return { type: match[1] as DenoType, path: match[2] ?? '' }
}

/** The core marker id (`<file>?deno-type=<type>`) of a Vite marker, for `PluginState.load`. */
export function coreMarkerId(marker: ViteMarker): string {
  return withDenoType(marker.path, marker.type)
}
