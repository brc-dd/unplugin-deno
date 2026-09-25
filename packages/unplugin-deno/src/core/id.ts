import { HOST_PATH_FLAVOR, isSubpath } from '../utils/path.js'
import type { PathFlavor } from '../utils/path.js'

// The id scheme (docs/architecture.md §5): query splitting, the `?deno-type=` import-attribute
// marker (§5.5), virtual ids and mirror-path detection. Every string check on ids goes through
// this module.

/** Import-attribute types encoded in ids (`json` is left to the host). */
export type DenoType = 'text' | 'bytes' | 'css'

/** The query parameter carrying the {@link DenoType} marker. */
export const DENO_TYPE_PARAM = 'deno-type'

/** Prefix of the plugin's own virtual module ids. */
export const DENO_VIRTUAL_PREFIX = '\0deno:'

/** Id of the empty module used for `browser: false` package mappings. */
export const EMPTY_MODULE_ID = `${DENO_VIRTUAL_PREFIX}empty`

/** Host filter matching ids that carry the {@link DenoType} marker. */
export const DENO_TYPE_ID_FILTER: RegExp = /[?&]deno-type=/

/** Host filter matching the plugin's own virtual ids ({@link DENO_VIRTUAL_PREFIX}). */
export const DENO_VIRTUAL_ID_FILTER: RegExp = /^\0deno:/

const DENO_TYPES: ReadonlySet<string> = new Set<DenoType>(['text', 'bytes', 'css'])

/** A trailing marker on a `data:` URL, the only query a data URL can carry. */
const DATA_URL_MARKER = /\?deno-type=(?:text|bytes|css)$/

/** Windows long-path prefixes whose `?` is part of the path, not a query. */
const LONG_PATH_PREFIX = /^(?:\\\\\?\\|\/\/\?\/)/

/** An id split into its path/URL part and its query. */
export interface SplitId {
  /** The id without {@link SplitId.query}. */
  base: string
  /** Everything from the first `?` (including a `#` fragment), verbatim, or `''`. */
  query: string
}

/**
 * Splits an id at its first `?`: `a.svg?raw` → `a.svg` + `?raw`, `w.ts?worker&url` → `w.ts` +
 * `?worker&url`. Safe on Windows long paths (`\\?\C:\x.ts?raw` splits after `x.ts`) and on
 * `data:` URLs, whose payload may contain `?`: only a trailing `?deno-type=<type>` marker is split
 * off a data URL.
 */
export function splitQuery(id: string): SplitId {
  if (/^data:/i.test(id)) {
    const marker = DATA_URL_MARKER.exec(id)
    return marker === null
      ? { base: id, query: '' }
      : { base: id.slice(0, marker.index), query: marker[0] }
  }
  const start = LONG_PATH_PREFIX.exec(id)?.[0].length ?? 0
  const index = id.indexOf('?', start)
  return index === -1
    ? { base: id, query: '' }
    : { base: id.slice(0, index), query: id.slice(index) }
}

/**
 * Adds (or replaces) the `deno-type` marker: `x.txt` → `x.txt?deno-type=text`,
 * `x.txt?raw` → `x.txt?raw&deno-type=text`. A `#` fragment stays at the end.
 */
export function withDenoType(id: string, type: DenoType): string {
  const base = stripDenoType(id)
  const { base: path, query } = splitQuery(base)
  const hashIndex = query.indexOf('#')
  const search = hashIndex === -1 ? query : query.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : query.slice(hashIndex)
  const separator = search === '' ? '?' : search === '?' ? '' : '&'
  return `${path}${search}${separator}${DENO_TYPE_PARAM}=${type}${hash}`
}

/**
 * Reads the `deno-type` marker: `x.txt?raw&deno-type=text` → `{ base: 'x.txt?raw', type: 'text' }`.
 * Returns `null` when the id has no marker or an unknown type.
 */
export function readDenoType(id: string): { base: string; type: DenoType } | null {
  const parsed = parseMarker(id)
  if (parsed === null || !DENO_TYPES.has(parsed.value)) return null
  return { base: parsed.base, type: parsed.value as DenoType }
}

/** Removes the `deno-type` marker (any value), keeping other query parameters and the fragment. */
export function stripDenoType(id: string): string {
  return parseMarker(id)?.base ?? id
}

function parseMarker(id: string): { base: string; value: string } | null {
  const { base: path, query } = splitQuery(id)
  if (query === '') return null
  const hashIndex = query.indexOf('#')
  const search = hashIndex === -1 ? query.slice(1) : query.slice(1, hashIndex)
  const hash = hashIndex === -1 ? '' : query.slice(hashIndex)
  const params = search.split('&')
  const isMarker = (param: string): boolean =>
    param === DENO_TYPE_PARAM || param.startsWith(`${DENO_TYPE_PARAM}=`)
  const marker = params.find(isMarker)
  if (marker === undefined) return null
  const value = marker.slice(DENO_TYPE_PARAM.length + 1)
  const rest = params.filter((param) => !isMarker(param))
  const remaining = rest.length === 0 ? '' : `?${rest.join('&')}`
  return { base: `${path}${remaining}${hash}`, value }
}

/** Whether `id` is a virtual module id (Rollup convention: a `\0` prefix). */
export function isVirtualId(id: string): boolean {
  return id.startsWith('\0')
}

/** Whether `id` is one of the plugin's own virtual ids (`\0deno:…`). */
export function isDenoVirtualId(id: string): boolean {
  return id.startsWith(DENO_VIRTUAL_PREFIX)
}

/**
 * Whether `id` belongs to another plugin and must be left alone (docs/plan.md R7): a `\0` virtual
 * id that is not ours, or a `virtual:` specifier.
 */
export function isForeignId(id: string): boolean {
  return (isVirtualId(id) && !isDenoVirtualId(id)) || id.startsWith('virtual:')
}

/**
 * Whether the plugin handles `id` in `resolveId`: not another plugin's id, and matched by the
 * `resolveId` filter (owned schemes, import-map keys, markers; docs/architecture.md §5.2).
 */
export function isOwnedSpecifier(id: string, filter: RegExp): boolean {
  if (isForeignId(id)) return false
  filter.lastIndex = 0
  return filter.test(id)
}

/**
 * A host filter matching ids inside the directory `dir` (and their queries): either separator,
 * case-insensitive on Windows. Used for the mirror directory in `load` filters.
 */
export function pathPrefixFilter(dir: string, flavor: PathFlavor = HOST_PATH_FLAVOR): RegExp {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const source = trimmed
    .split(/[\\/]/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]')
  return new RegExp(`^${source}(?:[\\\\/]|\\?|$)`, flavor === 'win32' ? 'i' : '')
}

/**
 * Whether the path of `id` (its query is ignored) lies inside the mirror directory `cacheDir`.
 * Segment-aware and case-insensitive on Windows; both must be absolute paths of the given flavour.
 */
export function isMirrorPath(
  id: string,
  cacheDir: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): boolean {
  if (isVirtualId(id)) return false
  const { base } = splitQuery(id)
  const absolute = flavor === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(base) : base.startsWith('/')
  return absolute && isSubpath(cacheDir, base, flavor)
}
