/**
 * Media types (docs/architecture.md §2): Deno's `MediaType` names, derived from file names, URLs
 * and content types exactly as `deno_media_type` 0.4 (the version inside the vendored loader) does,
 * and mapped to host loaders.
 *
 * @module
 */
import type { MediaType } from './types.js'

/** Every {@link MediaType}, in the order of Deno's enum. */
export const MEDIA_TYPES: readonly MediaType[] = Object.freeze([
  'JavaScript',
  'Jsx',
  'Mjs',
  'Cjs',
  'TypeScript',
  'Mts',
  'Cts',
  'Dts',
  'Dmts',
  'Dcts',
  'Tsx',
  'Css',
  'Json',
  'Jsonc',
  'Json5',
  'Html',
  'Markdown',
  'Sql',
  'Wasm',
  'SourceMap',
  'Unknown',
])

const mediaTypes: ReadonlySet<string> = new Set(MEDIA_TYPES)

/** Whether `value` is a {@link MediaType} name. */
export function isMediaType(value: unknown): value is MediaType {
  return typeof value === 'string' && mediaTypes.has(value)
}

const EXTENSIONS: Readonly<Record<string, MediaType>> = {
  ts: 'TypeScript',
  mts: 'Mts',
  cts: 'Cts',
  tsx: 'Tsx',
  js: 'JavaScript',
  jsx: 'Jsx',
  mjs: 'Mjs',
  cjs: 'Cjs',
  css: 'Css',
  json: 'Json',
  jsonc: 'Jsonc',
  json5: 'Json5',
  wasm: 'Wasm',
  md: 'Markdown',
  markdown: 'Markdown',
  map: 'SourceMap',
}

const DECLARATIONS: Readonly<Partial<Record<MediaType, MediaType>>> = {
  TypeScript: 'Dts',
  Mts: 'Dmts',
  Cts: 'Dcts',
}

/**
 * The media type of a file name (`mod.ts`, `types.d.ts`, `x.D.MTS`), from its last extension,
 * case-insensitively. A `.ts`/`.mts`/`.cts` name containing `.d.` is a declaration file.
 * Deno maps no extension to `Html` or `Sql`; unknown extensions give `Unknown`.
 */
export function mediaTypeFromFileName(fileName: string): MediaType {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return 'Unknown'
  const stem = fileName.slice(0, dot + 1)
  const mediaType = EXTENSIONS[fileName.slice(dot + 1).toLowerCase()] ?? 'Unknown'
  const declaration = DECLARATIONS[mediaType]
  return declaration !== undefined && stem.includes('.d.') ? declaration : mediaType
}

/** The media type of an OS path (`/`- or `\`-separated), from its last segment. */
export function mediaTypeFromPath(path: string): MediaType {
  const trimmed = path.replace(/[\\/]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed === '' ? 'Unknown' : mediaTypeFromFileName(trimmed.slice(slash + 1))
}

/**
 * The media type of a URL: the MIME type of a `data:` URL, otherwise the extension of the last
 * path segment (query and hash ignored). `node:fs`, `npm:kleur@4` and URLs without an extension
 * give `Unknown`.
 */
export function mediaTypeFromUrl(url: string | URL): MediaType {
  const parsed = typeof url === 'string' ? URL.parse(url) : url
  if (parsed === null) return 'Unknown'
  if (parsed.protocol === 'data:') return mediaTypeFromContentType(dataUrlMimeType(parsed.href))
  return mediaTypeFromFileName(urlFileName(parsed) ?? '')
}

/**
 * The media type for a `content-type` header value, as Deno computes it for downloaded modules.
 * `url` (the module URL) refines JavaScript and TypeScript content types by extension
 * (`.jsx`, `.mjs`, `.d.ts`, …) and resolves `text/plain` and `application/octet-stream`.
 */
export function mediaTypeFromContentType(contentType: string, url?: string | URL): MediaType {
  const parsed = url === undefined ? null : typeof url === 'string' ? URL.parse(url) : url
  const essence = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  switch (essence) {
    case 'application/typescript':
    case 'text/typescript':
    case 'video/vnd.dlna.mpeg-tts':
    case 'video/mp2t':
    case 'application/x-typescript':
      return refineByExtension(parsed, 'TypeScript')
    case 'application/javascript':
    case 'text/javascript':
    case 'application/ecmascript':
    case 'text/ecmascript':
    case 'application/x-javascript':
    case 'application/node':
      return refineByExtension(parsed, 'JavaScript')
    case 'text/jscript':
      return refineByExtension(parsed, 'Jsx')
    case 'text/jsx':
      return 'Jsx'
    case 'text/tsx':
      return 'Tsx'
    case 'application/json':
    case 'text/json':
      return 'Json'
    case 'application/jsonc':
    case 'text/jsonc':
      return 'Jsonc'
    case 'application/json5':
    case 'text/json5':
      return 'Json5'
    case 'application/wasm':
      return 'Wasm'
    case 'text/css':
      return 'Css'
    case 'text/markdown':
      return 'Markdown'
    case 'text/plain':
    case 'application/octet-stream':
      return parsed === null || parsed.protocol === 'data:' ? 'Unknown' : mediaTypeFromUrl(parsed)
    default:
      return essence.endsWith('+json') ? 'Json' : 'Unknown'
  }
}

/** Deno's `map_js_like_extension`: the URL's extension refines a JavaScript/TypeScript type. */
function refineByExtension(url: URL | null, fallback: MediaType): MediaType {
  if (url === null || url.protocol === 'data:') return fallback
  const fromName = mediaTypeFromFileName(urlFileName(url) ?? '')
  switch (fromName) {
    case 'Jsx':
    case 'Mjs':
    case 'Cjs':
    case 'Tsx':
    case 'Dts':
    case 'Dmts':
    case 'Dcts':
      return fromName
    case 'Mts':
      return fallback === 'JavaScript' ? 'Mjs' : 'Mts'
    case 'Cts':
      return fallback === 'JavaScript' ? 'Cjs' : 'Cts'
    default:
      return fallback
  }
}

/** The last path segment of a URL (trailing slashes ignored), or the host for empty paths. */
function urlFileName(url: URL): string | undefined {
  const path = (url.pathname === '' ? url.hostname : url.pathname).replace(/\/+$/, '')
  return path === '' ? undefined : path.slice(path.lastIndexOf('/') + 1)
}

/** The MIME type of a `data:` URL (`data:text/javascript;base64,…` → `text/javascript;base64`). */
function dataUrlMimeType(url: string): string {
  const comma = url.indexOf(',')
  const header = url.slice('data:'.length, comma === -1 ? undefined : comma)
  return decodeURIComponentSafe(header).trim() || 'text/plain'
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

const FILE_EXTENSIONS: Readonly<Record<MediaType, string>> = {
  JavaScript: '.js',
  Jsx: '.jsx',
  Mjs: '.mjs',
  Cjs: '.cjs',
  TypeScript: '.ts',
  Mts: '.mts',
  Cts: '.cts',
  Dts: '.d.ts',
  Dmts: '.d.mts',
  Dcts: '.d.cts',
  Tsx: '.tsx',
  Css: '.css',
  Json: '.json',
  Jsonc: '.jsonc',
  Json5: '.json5',
  Html: '.html',
  Markdown: '.md',
  Sql: '.sql',
  Wasm: '.wasm',
  SourceMap: '.map',
  Unknown: '',
}

/**
 * The conventional file extension of a media type, with the leading dot (`.ts`, `.d.mts`); `''`
 * for `Unknown`. Used to name files whose URL has no usable extension (`data:` URLs).
 */
export function mediaTypeExtension(mediaType: MediaType): string {
  return FILE_EXTENSIONS[mediaType]
}

/** The esbuild loaders used for engine output (see {@link esbuildLoaderFor}). */
export type EsbuildLoader = 'js' | 'ts' | 'jsx' | 'css' | 'json' | 'text' | 'binary'

/**
 * The Rolldown `moduleType`s used for engine output; the names coincide with
 * {@link EsbuildLoader}.
 */
export type RolldownModuleType = EsbuildLoader

const LOADERS: Readonly<Record<MediaType, EsbuildLoader>> = {
  JavaScript: 'js',
  Mjs: 'js',
  Cjs: 'js',
  Mts: 'js',
  TypeScript: 'ts',
  Cts: 'ts',
  Dts: 'ts',
  Dmts: 'ts',
  Dcts: 'ts',
  Jsx: 'jsx',
  Tsx: 'jsx',
  Css: 'css',
  Json: 'json',
  Jsonc: 'text',
  Json5: 'text',
  Markdown: 'text',
  Html: 'text',
  Sql: 'text',
  SourceMap: 'text',
  Wasm: 'binary',
  Unknown: 'binary',
}

/**
 * The esbuild loader for code of `mediaType` **as the engine returns it** from `load()`
 * (TypeScript already transpiled, so `Mts` → `js`, `Tsx` → `jsx`), the table `deno bundle` uses.
 * Not meant for untranspiled sources.
 */
export function esbuildLoaderFor(mediaType: MediaType): EsbuildLoader {
  return LOADERS[mediaType]
}

/** The Rolldown `moduleType` for engine output of `mediaType`; same table as {@link esbuildLoaderFor}. */
export function moduleTypeFor(mediaType: MediaType): RolldownModuleType {
  return LOADERS[mediaType]
}
