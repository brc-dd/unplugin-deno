/**
 * The remote-module mirror (docs/architecture.md §5.3): remote (`https:`/`http:`, JSR) and `data:`
 * modules are written as real files under `<cacheDir>/<generation>/`, transpiled by the engine,
 * with their import specifiers rewritten so hosts resolve them natively (relative paths between
 * mirror files, pinned `npm:` specifiers, `node:` builtins, `?deno-type=` markers), a sibling
 * source map and a `manifest.json` that maps URLs to files and back.
 *
 * Source maps (L2, L11): the map on disk names the original as `sourceRoot` + `sources` = the URL
 * (`sourceRoot: "https://jsr.io/@std/path/1.1.6/posix/"`, `sources: ["join.ts"]`), which esbuild
 * (it reads the linked map) and other standard readers turn into the URL. Rollup, Rolldown and
 * Vite resolve `sources` against the module's directory as paths, so a URL there came out mangled
 * (`…/posix/https:/jsr.io/…`); the plugin's `load` hands them the map with `sources` set to the
 * file name next to the mirror file ({@link mirrorSourceName}) and no `sourceRoot`, which they
 * turn into `node_modules/.unplugin-deno/<generation>/https/jsr.io/…/join.ts` (verified with Vite
 * 8.3.1, Rolldown 1.2.11, Rollup 4.63.5 and esbuild 0.28.2). `data:` URLs keep `sources: [url]`
 * on disk. npm files of Deno's global cache are not mirrored and keep their `DENO_DIR` paths.
 *
 * @module
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { SourceMapInput } from '@jridgewell/remapping'
import remapping from '@jridgewell/remapping'
import { MagicString } from 'magic-string'
import type { Lockfile } from '../config/lockfile.js'
import { DenoPluginError, isDenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import { mediaTypeExtension, mediaTypeFromFileName } from '../engine/media-type.js'
import type {
  EncodedSourceMap,
  Engine,
  LoadedModule,
  MediaType,
  ResolvedModule,
} from '../engine/types.js'
import { writeFileAtomic } from '../utils/fs.js'
import { sha256Hex, shortHash } from '../utils/hash.js'
import type { ScannedImport } from '../utils/lexer.js'
import { LexerError, scanModule } from '../utils/lexer.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR } from '../utils/path.js'
import type { AllowImportContext } from './allow-import.js'
import { isDenoType } from './attributes.js'
import type { DenoType } from './id.js'
import { isMirrorPath, splitQuery, withDenoType } from './id.js'
import type { LockCheck } from './lockfile-policy.js'
import { pinSpecifier } from './platform.js'

/**
 * How a URL is mirrored: `module` = code (transpiled by the engine, specifiers rewritten, `.js`
 * name, source map); `asset` = the raw bytes under the URL's own name (targets of `json`, `text`,
 * `bytes` and `css` imports, and non-code modules such as Wasm).
 */
export type MirrorKind = 'module' | 'asset'

/** A file in the mirror. */
export interface MirroredFile {
  /** Absolute OS path of the file. */
  path: string
  /** The URL it mirrors, after redirects. */
  url: string
  kind: MirrorKind
}

/** Options of {@link createMirror}. */
export interface MirrorOptions {
  /** Absolute mirror directory (`cacheDir` option). */
  cacheDir: string
  /** Generation (8 hex characters, see {@link mirrorGeneration}). */
  generation: string
  /** The engine that loads and resolves remote modules (created lazily). */
  engine: () => Promise<Engine>
  /**
   * An engine whose graph was never seeded, for raw loads the main engine refuses: the loader
   * records `css` imports (and `text`/`bytes` ones without `unstable: ["raw-imports"]`) as graph
   * errors and then fails every load of those URLs.
   */
  rawEngine?: () => Promise<Engine>
  /** The lockfile whose `remote` integrity entries are checked, if any. */
  lockfile: Pick<Lockfile, 'pin' | 'remoteIntegrity'> | null
  logger: Logger
  /** Path syntax (tests use `win32` on every OS for the layout rules). */
  flavor?: PathFlavor
  /**
   * Throws `DISALLOWED_HOST` for a remote URL the allow-list refuses (R15): called for the remote
   * imports of mirrored modules before they are loaded, and for the final URL of a redirect.
   */
  checkRemote?: ((url: string, context: AllowImportContext) => void) | undefined
  /** Compares a resolution inside a remote module with `deno.lock` (R5); may throw. */
  checkLockfile?: ((check: LockCheck, importer: string) => void) | undefined
  /**
   * Keep `jsr:` imports of remote modules as they are, for `resolveId` to resolve (the
   * `node_modules/@jsr` route, R11: JSR sources are never mirrored then).
   */
  keepJsrSpecifiers?: boolean | undefined
}

/** The mirror of one generation; see the module documentation. */
export interface Mirror {
  readonly cacheDir: string
  readonly generation: string
  /** `<cacheDir>/<generation>`. */
  readonly root: string
  /** The absolute path `url` is mirrored to (§5.3 layout), given its media type. */
  mirrorPathFor(url: string, mediaType: MediaType, kind?: MirrorKind): string
  /**
   * Mirrors `url` and everything it imports (memoised; concurrent calls share one promise) and
   * returns its file. Files and manifest entries of the current generation are reused without
   * loading anything.
   *
   * @throws {DenoPluginError} From the engine, `INTEGRITY_MISMATCH` when the content differs from
   *   `deno.lock`, `MIRROR_WRITE_FAILED` when the mirror cannot be written.
   */
  ensureMirrored(url: string, kind?: MirrorKind): Promise<MirroredFile>
  /** Whether `path` (query ignored) is inside the mirror directory (any generation). */
  isMirrorPath(path: string): boolean
  /** The URL a mirror file mirrors, from the manifest of its generation; `undefined` if unknown. */
  urlForMirrorPath(path: string): Promise<string | undefined>
  /**
   * Reads a mirrored code file and its source map (the `sourceMappingURL` comment removed), or
   * `null` when `path` is not a mirrored code file (assets are loaded by the host).
   */
  readModule(path: string): Promise<{ code: string; map: EncodedSourceMap | null } | null>
  /** Writes the manifest when it changed (merged with the one on disk). */
  flush(): Promise<void>
  /**
   * Removes the other generations except the most recently used one (§5.3: keep the current and
   * the previous generation). Returns the removed generation names.
   */
  collectGarbage(): Promise<string[]>
}

/**
 * The mirror generation (§5.3): the first 8 hex characters of sha256 over the config generation
 * (`configGeneration(project)`: configs, import maps, package.json files, lockfile), the plugin
 * version, the platform and the conditions.
 */
export function mirrorGeneration(
  configGeneration: string,
  pluginVersion: string,
  platform: string,
  conditions: readonly string[],
): string {
  return shortHash([configGeneration, pluginVersion, platform, conditions.join(',')].join('\0'), 8)
}

// ---------------------------------------------------------------------------------------------
// Layout (§5.3)

const MANIFEST = 'manifest.json'
const MANIFEST_VERSION = 1
const GENERATION_NAME = /^[0-9a-f]{8}$/
/** Names hosts keep verbatim as JavaScript; code with another name gets `.js` appended. */
const JS_NAME = /\.(?:m|c)?js$/i
/** Windows-invalid characters (and `\`, a separator there), percent-encoded in segments. */
// oxlint-disable-next-line no-control-regex -- control characters are invalid in Windows names
const INVALID_CHARS = /[<>:"|?*\\\u0000-\u001F]/g
/** Windows device names, reserved with any extension. */
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i
/** Longest segment kept as is (file systems allow 255 bytes per name). */
const MAX_SEGMENT = 200

const CODE_MEDIA_TYPES: ReadonlySet<MediaType> = new Set<MediaType>([
  'JavaScript',
  'Jsx',
  'Mjs',
  'Cjs',
  'TypeScript',
  'Mts',
  'Cts',
  'Tsx',
  'Dts',
  'Dmts',
  'Dcts',
  'Unknown',
])

/** Whether a module of `mediaType` is mirrored as code (transpiled JavaScript). */
export function isCodeMediaType(mediaType: MediaType): boolean {
  return CODE_MEDIA_TYPES.has(mediaType)
}

/**
 * The path segments of `url` below the generation directory (§5.3):
 * `https/<host>/<url path…>` or `data/<16 hex of sha256(url)>.<ext>`. Each segment is made safe
 * for Windows ({@link sanitizeSegment}); an empty segment (`a//b`, a trailing `/`) becomes `~e`;
 * a query is replaced by `~q<8 hex of sha256(?query)>` before the extension; code gets `.js`
 * appended unless its name already ends in `.js`/`.mjs`/`.cjs`; assets keep their name, except
 * that a JavaScript name gets `~raw` before the extension so it cannot collide with the code file.
 */
export function mirrorSegments(url: string, mediaType: MediaType, kind: MirrorKind): string[] {
  const parsed = new URL(url)
  if (parsed.protocol === 'data:') {
    return ['data', finalName(`${shortHash(url, 16)}${mediaTypeExtension(mediaType)}`, kind)]
  }
  const segments = parsed.pathname.split('/').slice(1)
  const last = segments.pop() ?? ''
  const query = parsed.search === '' ? '' : `~q${shortHash(parsed.search, 8)}`
  return [
    parsed.protocol.slice(0, -1),
    sanitizeSegment(parsed.host),
    ...segments.map((segment) => sanitizeSegment(segment)),
    finalName(withQueryMarker(sanitizeSegment(last), query), kind),
  ]
}

/**
 * Makes one URL path segment a valid file name on every OS: Windows-invalid characters
 * (`<>:"|?*`, `\`, control characters) and trailing dots and spaces are percent-encoded, device
 * names (`con`, `nul.js`, …) get their first character encoded, `''` becomes `~e`, and names longer
 * than 200 characters are shortened with a `~h<hash>` suffix (keeping the extension).
 */
export function sanitizeSegment(segment: string): string {
  if (segment === '') return '~e'
  let result = segment.replace(INVALID_CHARS, percentEncode)
  result = result.replace(/[. ]+$/, (tail) => [...tail].map(percentEncode).join(''))
  if (RESERVED_NAMES.test(result)) result = `${percentEncode(result.charAt(0))}${result.slice(1)}`
  if (result.length <= MAX_SEGMENT) return result
  const extension = knownExtension(result)
  return `${result.slice(0, MAX_SEGMENT - 50)}~h${shortHash(result, 8)}${extension}`
}

function percentEncode(char: string): string {
  return [...new TextEncoder().encode(char)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('')
}

/** The extension of `name` when it is one Deno knows (`.ts`, `.json`, …), else `''`. */
function knownExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || mediaTypeFromFileName(name) === 'Unknown') return ''
  return name.slice(dot)
}

function withQueryMarker(name: string, marker: string): string {
  if (marker === '') return name
  const extension = knownExtension(name)
  return `${name.slice(0, name.length - extension.length)}${marker}${extension}`
}

function finalName(name: string, kind: MirrorKind): string {
  if (kind === 'module') return JS_NAME.test(name) ? name : `${name}.js`
  const extension = JS_NAME.exec(name)?.[0]
  return extension === undefined ? name : `${name.slice(0, -extension.length)}~raw${extension}`
}

/**
 * The `sources` and `sourceRoot` of a mirror file's source map on disk (see the module
 * documentation): for an `http(s):` URL with a file name, `sourceRoot` is the URL up to its last
 * path segment and `sources` that segment with the query (`sourceRoot + sources[0]` is the URL
 * without its fragment); other URLs (`data:`, directory URLs) are `sources: [url]`.
 */
export function mirrorMapSources(url: string): { sources: string[]; sourceRoot?: string } {
  const parsed = URL.parse(url)
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return { sources: [url] }
  }
  const slash = parsed.pathname.lastIndexOf('/')
  const name = parsed.pathname.slice(slash + 1)
  if (name === '') return { sources: [url] }
  return {
    sourceRoot: `${parsed.origin}${parsed.pathname.slice(0, slash + 1)}`,
    sources: [`${name}${parsed.search}`],
  }
}

/**
 * The source name the plugin's `load` gives Rollup-family hosts for a mirror code file: its file
 * name without the `.js` the mirror appended to TypeScript and JSX names (`join.ts.js` →
 * `join.ts`), so the hosts' output maps name `…/https/jsr.io/…/posix/join.ts` next to the mirror
 * file. JavaScript names stay as they are (`react.js`, `util.mjs`).
 */
export function mirrorSourceName(path: string, flavor: PathFlavor = HOST_PATH_FLAVOR): string {
  const name = (flavor === 'win32' ? win32 : posix).basename(splitQuery(path).base)
  return /\.(?:[cm]?tsx?|jsx)\.js$/i.test(name) ? name.slice(0, -'.js'.length) : name
}

/**
 * The map of the mirror code file at `path` as the plugin's `load` returns it to Rollup-family
 * hosts: `sources` = [{@link mirrorSourceName}] without `sourceRoot` (they would resolve a URL as
 * a path), `sourcesContent` kept.
 */
export function hostMirrorMap(
  map: EncodedSourceMap,
  path: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): EncodedSourceMap {
  if (map.sources.length !== 1) return map
  const { sourceRoot: _sourceRoot, ...rest } = map
  return { ...rest, sources: [mirrorSourceName(path, flavor)] }
}

/**
 * The import specifier from the file `from` to the file `to`: a relative path with `/`
 * separators that starts with `./` or `../` (hosts resolve it as a path, not as a URL).
 */
export function relativeSpecifier(
  from: string,
  to: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): string {
  const syntax = flavor === 'win32' ? win32 : posix
  const relative = syntax.relative(syntax.dirname(from), to)
  const slashed = flavor === 'win32' ? relative.replaceAll('\\', '/') : relative
  if (syntax.isAbsolute(relative)) return slashed
  return slashed === '..' || slashed.startsWith('../') ? slashed : `./${slashed}`
}

// ---------------------------------------------------------------------------------------------
// Manifest

interface ManifestEntry {
  /** Path relative to the generation directory, `/`-separated. */
  file: string
  mediaType: MediaType
  /** sha256 hex of the source (before transpiling). */
  integrity: string
  /** URLs of the modules it imports (mirrored as modules). */
  deps: string[]
  /** URLs of the assets it imports (`json`, `text`, `bytes`, `css`). */
  assets: string[]
}

interface ManifestData {
  version: typeof MANIFEST_VERSION
  generation: string
  modules: Record<string, ManifestEntry>
  assets: Record<string, ManifestEntry>
  /** Requested URL → final URL. */
  redirects: Record<string, string>
}

function emptyManifest(generation: string): ManifestData {
  return { version: MANIFEST_VERSION, generation, modules: {}, assets: {}, redirects: {} }
}

function isEntryRecord(record: unknown): record is Record<string, ManifestEntry> {
  return (
    typeof record === 'object' &&
    record !== null &&
    Object.values(record).every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ManifestEntry).file === 'string' &&
        Array.isArray((entry as ManifestEntry).deps) &&
        Array.isArray((entry as ManifestEntry).assets),
    )
  )
}

/** Parses a manifest; `null` for anything invalid (the manifest is a rebuildable cache). */
function parseManifest(text: string, generation: string): ManifestData | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const data = value as Partial<ManifestData>
  if (data.version !== MANIFEST_VERSION || data.generation !== generation) return null
  if (!isEntryRecord(data.modules) || !isEntryRecord(data.assets)) return null
  if (typeof data.redirects !== 'object' || data.redirects === null) return null
  return data as ManifestData
}

// ---------------------------------------------------------------------------------------------
// The mirror

/** A module or asset loaded from the engine and waiting to be written. */
interface Prepared {
  url: string
  kind: MirrorKind
  loaded: LoadedModule
  /** Absolute path of the mirror file. */
  path: string
}

/** Creates the mirror of one generation (see {@link Mirror}). */
export function createMirror(options: MirrorOptions): Mirror {
  return new MirrorImpl(options)
}

class MirrorImpl implements Mirror {
  readonly cacheDir: string
  readonly generation: string
  readonly root: string
  readonly #options: MirrorOptions
  readonly #path: typeof posix
  readonly #flavor: PathFlavor
  #manifest: Promise<ManifestData> | undefined
  #dirty = false
  /** Loads, keyed by `<kind> <url>` (requested and final URLs). */
  readonly #prepared = new Map<string, Promise<Prepared>>()
  /** Written (or reused) entries, keyed by `<kind> <url>`. */
  readonly #written = new Map<string, Promise<MirroredFile>>()
  /** Whole dependency closures, keyed by `<kind> <url>`. */
  readonly #closures = new Map<string, Promise<MirroredFile>>()
  /** Relative file (normalised) → URL, for every generation's manifest read so far. */
  readonly #reverse = new Map<string, string>()
  readonly #otherManifests = new Map<string, Promise<void>>()

  constructor(options: MirrorOptions) {
    this.#options = options
    this.#flavor = options.flavor ?? HOST_PATH_FLAVOR
    this.#path = this.#flavor === 'win32' ? win32 : posix
    this.cacheDir = options.cacheDir
    this.generation = options.generation
    this.root = this.#path.join(options.cacheDir, options.generation)
  }

  mirrorPathFor(url: string, mediaType: MediaType, kind: MirrorKind = 'module'): string {
    return this.#path.join(this.root, ...mirrorSegments(url, mediaType, kind))
  }

  isMirrorPath(path: string): boolean {
    return isMirrorPath(path, this.cacheDir, this.#flavor)
  }

  ensureMirrored(url: string, kind: MirrorKind = 'module'): Promise<MirroredFile> {
    const key = `${kind} ${url}`
    let closure = this.#closures.get(key)
    if (closure === undefined) {
      closure = this.#closure(url, kind)
      this.#closures.set(key, closure)
      closure.catch(() => this.#closures.delete(key))
    }
    return closure
  }

  async urlForMirrorPath(path: string): Promise<string | undefined> {
    const { base } = splitQuery(path)
    if (!this.isMirrorPath(base)) return undefined
    const relative = this.#path.relative(this.cacheDir, base)
    const [generation] = relative.split(/[\\/]/)
    if (generation === undefined) return undefined
    if (generation === this.generation) await this.#manifestData()
    else await this.#readOtherManifest(generation)
    return this.#reverse.get(this.#reverseKey(relative))
  }

  async readModule(path: string): Promise<{ code: string; map: EncodedSourceMap | null } | null> {
    const { base } = splitQuery(path)
    if (!this.isMirrorPath(base) || !JS_NAME.test(base)) return null
    let map: EncodedSourceMap | null
    try {
      map = JSON.parse(await readFile(`${base}.map`, 'utf8')) as EncodedSourceMap
    } catch {
      return null
    }
    const code = await readFile(base, 'utf8')
    return { code: stripSourceMappingComment(code), map }
  }

  async flush(): Promise<void> {
    if (!this.#dirty || this.#manifest === undefined) return
    this.#dirty = false
    const ours = await this.#manifest
    const file = this.#path.join(this.root, MANIFEST)
    const disk = parseManifest(await readFile(file, 'utf8').catch(() => ''), this.generation)
    const merged: ManifestData = {
      ...emptyManifest(this.generation),
      modules: { ...disk?.modules, ...ours.modules },
      assets: { ...disk?.assets, ...ours.assets },
      redirects: { ...disk?.redirects, ...ours.redirects },
    }
    await this.#write(file, `${JSON.stringify(merged, null, 2)}\n`)
  }

  async collectGarbage(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.cacheDir)
    } catch {
      return []
    }
    const others = await Promise.all(
      names
        .filter((name) => GENERATION_NAME.test(name) && name !== this.generation)
        .map(async (name) => {
          const dir = this.#path.join(this.cacheDir, name)
          const info = await stat(dir).catch(() => undefined)
          return { name, dir, time: info?.isDirectory() === true ? info.mtimeMs : -1 }
        }),
    )
    const stale = others
      .filter((other) => other.time >= 0)
      .toSorted((a, b) => b.time - a.time)
      .slice(1)
    await Promise.all(
      stale.map((other) => rm(other.dir, { recursive: true, force: true, maxRetries: 3 })),
    )
    if (stale.length > 0) {
      this.#options.logger.debug(
        `[mirror] removed stale generations ${stale.map((other) => other.name).join(', ')}`,
      )
    }
    return stale.map((other) => other.name)
  }

  // -- closure -----------------------------------------------------------------------------------

  /** Writes `url` and, breadth first, everything it imports; cycles are fine (see #written). */
  async #closure(url: string, kind: MirrorKind): Promise<MirroredFile> {
    const manifest = await this.#manifestData()
    const first = await this.#entry(url, kind)
    const seen = new Set([`${first.kind} ${first.url}`])
    let wave = this.#dependencies(manifest, first)
    while (wave.length > 0) {
      const next = wave.filter(([depKind, depUrl]) => {
        const key = `${depKind} ${depUrl}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const files = await Promise.all(next.map(([depKind, depUrl]) => this.#entry(depUrl, depKind)))
      wave = files.flatMap((file) => this.#dependencies(manifest, file))
    }
    return first
  }

  /**
   * The imports of `file` recorded in the manifest, checked against the allow-list and the
   * lockfile's `remote` entries again: a file reused from an earlier build of the generation was
   * rewritten under that build's options (`allowImport`, a lockfile mode that allowed drift).
   * Requirements of JSR packages are checked only when a file is written.
   */
  #dependencies(manifest: ManifestData, file: MirroredFile): Array<[MirrorKind, string]> {
    const dependencies = this.#recordedDependencies(manifest, file)
    for (const [kind, url] of dependencies) {
      if (!/^https?:/.test(url)) continue
      this.#options.checkRemote?.(url, { importer: file.url })
      if (kind !== 'module') continue
      this.#options.checkLockfile?.(
        { specifier: url, resolved: { kind: 'remote', url, mediaType: 'Unknown' } },
        file.url,
      )
    }
    return dependencies
  }

  #recordedDependencies(manifest: ManifestData, file: MirroredFile): Array<[MirrorKind, string]> {
    const entry = (file.kind === 'module' ? manifest.modules : manifest.assets)[file.url]
    if (entry === undefined) return []
    return [
      ...entry.deps.map((dep): [MirrorKind, string] => ['module', dep]),
      ...entry.assets.map((dep): [MirrorKind, string] => ['asset', dep]),
    ]
  }

  /** The written file for `url` (reused from the manifest, or loaded, rewritten and written). */
  #entry(url: string, kind: MirrorKind): Promise<MirroredFile> {
    const key = `${kind} ${url}`
    let written = this.#written.get(key)
    if (written === undefined) {
      written = this.#reuseOrWrite(url, kind)
      this.#written.set(key, written)
      written.catch(() => this.#written.delete(key))
    }
    return written
  }

  async #reuseOrWrite(url: string, kind: MirrorKind): Promise<MirroredFile> {
    const reused = await this.#reusable(url, kind)
    if (reused !== undefined) return reused
    const prepared = await this.#prepare(url, kind)
    if (prepared.url === url && prepared.kind === kind) return this.#writePrepared(prepared)
    // A redirect (or a non-code module mirrored as an asset): write it once, under its final key.
    if (prepared.url !== url) {
      const manifest = await this.#manifestData()
      manifest.redirects[url] = prepared.url
      this.#dirty = true
    }
    this.#prepared.set(`${prepared.kind} ${prepared.url}`, Promise.resolve(prepared))
    return this.#entry(prepared.url, prepared.kind)
  }

  /** A manifest entry of this generation whose files still exist. */
  async #reusable(url: string, kind: MirrorKind): Promise<MirroredFile | undefined> {
    const manifest = await this.#manifestData()
    const finalUrl = manifest.redirects[url] ?? url
    const module = kind === 'module' ? manifest.modules[finalUrl] : undefined
    if (module !== undefined) return this.#existing(finalUrl, 'module', module)
    const asset = manifest.assets[finalUrl]
    // A module request for a non-code URL (Wasm, JSON) was mirrored as an asset.
    if (asset === undefined || (kind === 'module' && isCodeMediaType(asset.mediaType))) {
      return undefined
    }
    return this.#existing(finalUrl, 'asset', asset)
  }

  async #existing(
    url: string,
    kind: MirrorKind,
    entry: ManifestEntry,
  ): Promise<MirroredFile | undefined> {
    const path = this.#path.join(this.root, ...entry.file.split('/'))
    const files = kind === 'module' ? [path, `${path}.map`] : [path]
    const present = await Promise.all(files.map((file) => exists(file)))
    return present.every(Boolean) ? { path, url, kind } : undefined
  }

  /** Loads `url` from the engine (memoised by requested and final URL). */
  #prepare(url: string, kind: MirrorKind): Promise<Prepared> {
    const key = `${kind} ${url}`
    let prepared = this.#prepared.get(key)
    if (prepared === undefined) {
      prepared = this.#load(url, kind)
      this.#prepared.set(key, prepared)
      prepared.then(
        (value) => this.#prepared.set(`${value.kind} ${value.url}`, prepared as Promise<Prepared>),
        () => this.#prepared.delete(key),
      )
    }
    return prepared
  }

  async #load(url: string, kind: MirrorKind): Promise<Prepared> {
    this.#options.logger.debug(`[mirror] loading ${url}`)
    let loaded: LoadedModule
    if (kind === 'asset') {
      loaded = await this.#loadRaw(url)
    } else {
      loaded = moduleOf(await (await this.#options.engine()).load(url, 'default'), url)
      // A module import of a non-code URL (Wasm, JSON) is mirrored as an asset.
      if (!isCodeMediaType(loaded.mediaType)) loaded = await this.#loadRaw(loaded.url)
    }
    if (loaded.url !== url && /^https?:/.test(loaded.url)) {
      // A redirect to another host must be allowed too (R15).
      this.#options.checkRemote?.(loaded.url, { redirectedFrom: url })
    }
    const effective: MirrorKind =
      kind === 'module' && !isCodeMediaType(loaded.mediaType) ? 'asset' : kind
    return {
      url: loaded.url,
      kind: effective,
      loaded,
      path: this.mirrorPathFor(loaded.url, loaded.mediaType, effective),
    }
  }

  /** The raw bytes of `url`, from the separate raw engine when the main engine refuses. */
  async #loadRaw(url: string): Promise<LoadedModule> {
    try {
      return moduleOf(await (await this.#options.engine()).load(url, 'bytes'), url)
    } catch (error) {
      const raw = this.#options.rawEngine
      if (raw === undefined || !isDenoPluginError(error)) throw error
      this.#options.logger.debug(`[mirror] loading ${url} with a separate engine: ${error.message}`)
      return moduleOf(await (await raw()).load(url, 'bytes'), url)
    }
  }

  /** The mirror path of a dependency, reusing the manifest when possible. */
  async #pathOf(
    url: string,
    kind: MirrorKind,
  ): Promise<{ path: string; url: string; kind: MirrorKind }> {
    const reused = await this.#reusable(url, kind)
    if (reused !== undefined) return reused
    const prepared = await this.#prepare(url, kind)
    return { path: prepared.path, url: prepared.url, kind: prepared.kind }
  }

  async #writePrepared(prepared: Prepared): Promise<MirroredFile> {
    const integrity = this.#checkIntegrity(prepared)
    const manifest = await this.#manifestData()
    let deps: string[] = []
    let assets: string[] = []
    if (prepared.kind === 'module') {
      const rewritten = await this.#rewrite(prepared)
      deps = rewritten.deps
      assets = rewritten.assets
      await this.#write(`${prepared.path}.map`, `${JSON.stringify(rewritten.map)}\n`)
      await this.#write(prepared.path, rewritten.code)
    } else {
      await this.#write(prepared.path, prepared.loaded.bytes)
    }
    const file = this.#path.relative(this.root, prepared.path).split(this.#path.sep).join('/')
    const entry: ManifestEntry = {
      file,
      mediaType: prepared.loaded.mediaType,
      integrity,
      deps,
      assets,
    }
    ;(prepared.kind === 'module' ? manifest.modules : manifest.assets)[prepared.url] = entry
    this.#reverse.set(this.#reverseKey(this.#path.join(this.generation, file)), prepared.url)
    this.#dirty = true
    this.#options.logger.debug(`[mirror] wrote ${prepared.url} → ${file}`)
    return { path: prepared.path, url: prepared.url, kind: prepared.kind }
  }

  /** sha256 of the source; compared with `deno.lock` `remote` entries (§5.3 step 3). */
  #checkIntegrity(prepared: Prepared): string {
    const { loaded } = prepared
    const original = prepared.kind === 'module' ? loaded.map?.sourcesContent?.[0] : undefined
    const integrity = sha256Hex(typeof original === 'string' ? original : loaded.bytes)
    if (!/^https?:/.test(loaded.url)) return integrity
    const expected = this.#options.lockfile?.remoteIntegrity(loaded.url) ?? null
    if (expected !== null && expected !== integrity) {
      throw new DenoPluginError(
        'INTEGRITY_MISMATCH',
        `The content of ${loaded.url} does not match the integrity recorded in deno.lock (expected ${expected}, got ${integrity}).`,
        {
          hint: 'The remote module changed. Check the source, then update deno.lock (`deno cache --reload` or `deno install`).',
          specifier: loaded.url,
        },
      )
    }
    return integrity
  }

  // -- rewriting (§5.3 step 2) ------------------------------------------------------------------

  async #rewrite(
    prepared: Prepared,
  ): Promise<{ code: string; map: EncodedSourceMap; deps: string[]; assets: string[] }> {
    const { loaded } = prepared
    let imports: ScannedImport[]
    try {
      imports = scanModule(loaded.code).imports
    } catch (error) {
      throw new DenoPluginError(
        'UNSUPPORTED_MEDIA_TYPE',
        `Cannot scan the imports of ${loaded.url} (${loaded.mediaType}): ${error instanceof LexerError ? error.message : String(error)}`,
        {
          hint: 'Report this module to unplugin-deno; the engine returned code the lexer cannot read.',
          specifier: loaded.url,
          cause: error,
        },
      )
    }
    const magic = new MagicString(loaded.code)
    const deps = new Set<string>()
    const assets = new Set<string>()
    const engine = await this.#options.engine()
    await Promise.all(
      imports.map(async (entry) => {
        if (entry.specifier === undefined || entry.template) {
          if (entry.dynamic)
            this.#options.logger.debug(
              `[mirror] left a non-literal import() in ${loaded.url} unchanged`,
            )
          return
        }
        const type = entry.attributes?.type
        const denoType = isDenoType(type) ? type : undefined
        const target = await this.#rewriteTarget(
          engine,
          entry,
          loaded.url,
          prepared.path,
          denoType,
          type === 'json',
        )
        if (target === undefined) return
        if (target.dep !== undefined)
          (target.dep.kind === 'module' ? deps : assets).add(target.dep.url)
        magic.overwrite(entry.start, entry.end, JSON.stringify(target.specifier))
        if (
          denoType !== undefined &&
          entry.clause !== null &&
          entry.clause.end > entry.clause.start
        ) {
          magic.remove(entry.clause.start, entry.clause.end)
        }
      }),
    )
    const basename = this.#path.basename(prepared.path)
    const map = composeMaps(magic, loaded, basename)
    const code = `${magic.toString()}\n//# sourceMappingURL=${encodeFileName(basename)}.map\n`
    return { code, map, deps: [...deps].toSorted(), assets: [...assets].toSorted() }
  }

  /**
   * The replacement specifier for one import of a mirrored module; `undefined` keeps it (external
   * schemes, and dynamic imports the engine cannot resolve, which fail at runtime as in Deno).
   */
  async #rewriteTarget(
    engine: Engine,
    entry: ScannedImport,
    referrer: string,
    from: string,
    denoType: DenoType | undefined,
    json: boolean,
  ): Promise<{ specifier: string; dep?: { url: string; kind: MirrorKind } } | undefined> {
    const specifier = entry.specifier as string
    const mark = (value: string): string =>
      denoType === undefined ? value : withDenoType(value, denoType)
    if (this.#options.keepJsrSpecifiers === true && specifier.startsWith('jsr:')) {
      // resolveId takes it through node_modules/@jsr (R11).
      return { specifier: mark(specifier) }
    }
    let target: ResolvedModule
    try {
      target = await engine.resolve(specifier, referrer, 'import')
      // Deno locks code and JSON imports, not `text`/`bytes`/`css` ones.
      if (denoType === undefined)
        this.#options.checkLockfile?.({ specifier, resolved: target }, referrer)
    } catch (error) {
      if (!isDenoPluginError(error)) throw error
      if (error.code === 'LOCKFILE_FROZEN_DRIFT') throw error
      // The loader's graph records `css` imports (and `text`/`bytes` ones without the unstable
      // flag) as errors; a relative or absolute URL target resolves against the referrer.
      const url = denoType === undefined && !json ? undefined : attributeTarget(specifier, referrer)
      if (url !== undefined) {
        target = { kind: url.startsWith('data:') ? 'data' : 'remote', url, mediaType: 'Unknown' }
      } else if (entry.dynamic) {
        this.#options.logger.debug(
          `[mirror] left import("${specifier}") in ${referrer} unchanged: ${error.message}`,
        )
        return undefined
      } else {
        throw error
      }
    }
    switch (target.kind) {
      case 'remote':
      case 'data': {
        if (target.kind === 'remote' && this.#options.checkRemote !== undefined) {
          try {
            this.#options.checkRemote(target.url, { importer: referrer })
          } catch (error) {
            // A dynamic import fails at runtime (as in Deno), not the build.
            if (!entry.dynamic || !isDenoPluginError(error)) throw error
            this.#options.logger.debug(
              `[mirror] left import("${specifier}") in ${referrer} unchanged: ${error.message}`,
            )
            return undefined
          }
        }
        const kind: MirrorKind = denoType !== undefined || json ? 'asset' : 'module'
        const dep = await this.#pathOf(target.url, kind)
        return { specifier: mark(relativeSpecifier(from, dep.path, this.#flavor)), dep }
      }
      case 'npm':
        return {
          specifier: mark(pinSpecifier(target, specifier, this.#options.lockfile) ?? specifier),
        }
      case 'node':
        return { specifier: target.url }
      case 'local':
        return { specifier: mark(relativeSpecifier(from, target.path ?? specifier, this.#flavor)) }
      case 'external':
        return undefined
    }
  }

  // -- manifest -----------------------------------------------------------------------------------

  #manifestData(): Promise<ManifestData> {
    this.#manifest ??= this.#readManifest(this.generation).then((data) => {
      const manifest = data ?? emptyManifest(this.generation)
      this.#index(this.generation, manifest)
      return manifest
    })
    return this.#manifest
  }

  async #readManifest(generation: string): Promise<ManifestData | null> {
    const file = this.#path.join(this.cacheDir, generation, MANIFEST)
    const text = await readFile(file, 'utf8').catch(() => null)
    return text === null ? null : parseManifest(text, generation)
  }

  #readOtherManifest(generation: string): Promise<void> {
    let read = this.#otherManifests.get(generation)
    if (read === undefined) {
      read = this.#readManifest(generation).then((data) => {
        if (data !== null) this.#index(generation, data)
      })
      this.#otherManifests.set(generation, read)
    }
    return read
  }

  #index(generation: string, data: ManifestData): void {
    for (const records of [data.modules, data.assets]) {
      for (const [url, entry] of Object.entries(records)) {
        this.#reverse.set(
          this.#reverseKey(this.#path.join(generation, ...entry.file.split('/'))),
          url,
        )
      }
    }
  }

  /** A path relative to `cacheDir`, normalised for lookups (case-insensitive on Windows). */
  #reverseKey(relative: string): string {
    const slashed = relative.split(/[\\/]/).join('/')
    return this.#flavor === 'win32' ? slashed.toLowerCase() : slashed
  }

  async #write(file: string, data: string | Uint8Array): Promise<void> {
    try {
      await writeFileAtomic(file, data)
    } catch (error) {
      throw new DenoPluginError('MIRROR_WRITE_FAILED', `Cannot write ${file}.`, {
        hint: 'Make the mirror directory writable, or point the `cacheDir` option to a writable directory.',
        cause: error,
      })
    }
  }
}

/**
 * The source map of a rewritten module: our edits composed with the engine's transpile map, so it
 * points at the original source (the URL as `sourceRoot` + `sources`, {@link mirrorMapSources},
 * with `sourcesContent`).
 */
function composeMaps(magic: MagicString, loaded: LoadedModule, file: string): EncodedSourceMap {
  let result
  if (loaded.map === undefined) {
    const own = magic.generateMap({ source: loaded.url, hires: 'boundary', includeContent: true })
    result = remapping({ ...own, version: 3 } as SourceMapInput, () => null)
  } else {
    const own = magic.generateMap({ source: loaded.url, hires: 'boundary', includeContent: false })
    result = remapping(
      [{ ...own, version: 3 } as SourceMapInput, loaded.map as SourceMapInput],
      () => null,
    )
  }
  // One module, one source: the URL the engine loaded (as its map names it).
  const [only] = result.sources
  const sources =
    result.sources.length === 1 && typeof only === 'string'
      ? mirrorMapSources(only)
      : { sources: result.sources.map((source) => source ?? '') }
  return {
    version: 3,
    file,
    ...sources,
    sourcesContent: [...(result.sourcesContent ?? [])],
    names: [...result.names],
    mappings: result.mappings as string,
  }
}

function moduleOf(loaded: LoadedModule | { kind: 'external' }, url: string): LoadedModule {
  if (loaded.kind === 'external') {
    throw new DenoPluginError('RESOLVE_FAILED', `Cannot mirror ${url}: it is an external module.`, {
      specifier: url,
    })
  }
  return loaded
}

/** The remote or `data:` URL a relative or absolute URL specifier names, else `undefined`. */
function attributeTarget(specifier: string, referrer: string): string | undefined {
  if (!/^(?:\.{1,2}\/|\/|https?:|data:)/.test(specifier)) return undefined
  const url = URL.parse(specifier, referrer)
  return url !== null && /^(?:https?|data):$/.test(url.protocol) ? url.href : undefined
}

/** A file name as it appears in a `sourceMappingURL` (a relative URL). */
function encodeFileName(name: string): string {
  return name.replace(/[%#? ]/g, (char) => encodeURIComponent(char))
}

/** Removes the trailing `//# sourceMappingURL=…` line the mirror appends. */
export function stripSourceMappingComment(code: string): string {
  const match = /\n?\/\/# sourceMappingURL=[^\n]*\n?$/.exec(code)
  return match === null ? code : code.slice(0, match.index)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
