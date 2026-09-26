/**
 * Import-attribute markers in Vite (docs/architecture.md §5.5, §6.1). The core marker id
 * `<file>?deno-type=<type>` keeps the target's extension in front of a query, and Vite's own
 * plugins claim ids by that extension whatever follows (`vite:css` matches `.css?…`, `vite:json`
 * matches `.json?…`, framework plugins match `.vue?…`) and would transform the synthesised
 * JavaScript as CSS or JSON. In Vite a marker therefore resolves to a virtual id that hides the
 * extension: `\0deno:<type>:<path>.js`.
 *
 * `<path>` is the target relative to the Vite root, `/`-separated (`src/data.txt`,
 * `node_modules/.unplugin-deno/<generation>/https/…`), so ids, output region comments and chunk
 * names hold no machine paths. Dev-server URLs carry the id (`/@id/__x00__deno:text:src/…`), where
 * a `..` segment would be collapsed by the browser, so each leading `..` is written `~u`
 * (`~u/lib/data.txt` for `<root>/../lib/data.txt`). A target on another Windows drive, or whose
 * relative path starts with `~`, keeps its absolute path behind `~abs/`.
 *
 * @module
 */
import { posix, win32 } from 'node:path'
import type { DenoType } from '../../core/id.js'
import { DENO_VIRTUAL_PREFIX, readDenoType, splitQuery, withDenoType } from '../../core/id.js'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR } from '../../utils/path.js'

/** Matches the virtual ids of {@link viteMarkerId} (for `load` filters). */
export const VITE_MARKER_ID_FILTER: RegExp = /^\0deno:(?:text|bytes|css):/

const VITE_MARKER_ID = /^\0deno:(text|bytes|css):(.+)\.js$/

/** The segment standing for `..` in a marker path. */
const UP = '~u'

/** The prefix of an absolute marker path. */
const ABSOLUTE = '~abs/'

/** A marker module in Vite: the file it reads and the attribute type. */
export interface ViteMarker {
  /** The absolute path of the target file (a local file or a mirror file). */
  path: string
  type: DenoType
}

/**
 * The Vite id of a marker module for `file` imported `with { type }`: `\0deno:<type>:<path>.js`
 * with `<path>` relative to `root` (see the module documentation). A query on `file` is dropped:
 * the module is the file's content either way.
 */
export function viteMarkerId(
  file: string,
  type: DenoType,
  root: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string {
  const syntax = flavor === 'win32' ? win32 : posix
  const { base } = splitQuery(file)
  const slash = (path: string): string => (flavor === 'win32' ? path.replaceAll('\\', '/') : path)
  const relative = slash(syntax.relative(root, base))
  let path: string
  if (relative === '' || relative.startsWith('~') || syntax.isAbsolute(relative)) {
    path = `${ABSOLUTE}${slash(base)}`
  } else {
    path = relative
      .split('/')
      .map((segment) => (segment === '..' ? UP : segment))
      .join('/')
  }
  return `${DENO_VIRTUAL_PREFIX}${type}:${path}.js`
}

/**
 * The Vite id for a core marker id (`<file>?deno-type=<type>`, possibly with other query
 * parameters), or `null` when `id` carries no marker.
 */
export function viteMarkerIdFor(
  id: string,
  root: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string | null {
  const marker = readDenoType(id)
  return marker === null ? null : viteMarkerId(marker.base, marker.type, root, flavor)
}

/** Parses a {@link viteMarkerId} made for `root`; `null` for any other id. */
export function parseViteMarkerId(
  id: string,
  root: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): ViteMarker | null {
  const match = VITE_MARKER_ID.exec(splitQuery(id).base)
  if (match === null) return null
  const syntax = flavor === 'win32' ? win32 : posix
  const encoded = match[2] ?? ''
  let path: string
  if (encoded.startsWith(ABSOLUTE)) {
    const absolute = encoded.slice(ABSOLUTE.length)
    path = flavor === 'win32' ? absolute.replaceAll('/', '\\') : absolute
  } else {
    const segments = encoded.split('/').map((segment) => (segment === UP ? '..' : segment))
    path = syntax.resolve(root, ...segments)
  }
  return { type: match[1] as DenoType, path }
}

/** The core marker id (`<file>?deno-type=<type>`) of a Vite marker, for `PluginState.load`. */
export function coreMarkerId(marker: ViteMarker): string {
  return withDenoType(marker.path, marker.type)
}
