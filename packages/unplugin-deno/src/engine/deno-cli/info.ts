/**
 * The data the `deno` engine reads from Deno (docs/architecture.md §4.3): `deno info --json`
 * output, validated by hand-written guards (its format is marked unstable, and format changes broke
 * earlier plugins), the progress lines on stderr, and remote modules in the
 * `DENO_DIR` cache.
 *
 * @module
 */
import { isMediaType } from '../media-type.js'
import type { MediaType } from '../types.js'

/** How a dependency resolved (`code` or `type` of a {@link DenoInfoDependency}). */
export interface DenoInfoResolution {
  /** The resolved specifier (`jsr:`/`npm:` requirement, URL); absent when resolution failed. */
  specifier?: string | undefined
  /** Why resolution failed. */
  error?: string | undefined
  /** Where the import is, zero-based. */
  span?: DenoInfoSpan | undefined
}

/** A range in a module, zero-based. */
export interface DenoInfoSpan {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

/** An import of a module. */
export interface DenoInfoDependency {
  /** The specifier as written. */
  specifier: string
  /** The runtime import; absent for type-only imports. */
  code?: DenoInfoResolution | undefined
  /** The type import (`import type`, `@ts-types`). */
  type?: DenoInfoResolution | undefined
  isDynamic?: boolean | undefined
  /** `json`, `text`, `bytes` or `css` for imports with a `type` attribute. */
  assertionType?: string | undefined
}

/** A module of the graph. */
export interface DenoInfoModule {
  specifier: string
  /** `esm`, `asserted` (JSON), `npm`, `node`, `external`, `wasm`; absent for failed modules. */
  kind?: string | undefined
  /** Its file: the local file, or the `DENO_DIR/remote/…` cache file of a remote module. */
  local?: string | undefined
  /** Deno's media type name (`TypeScript`, `TSX`, `JSX`, …; see {@link toMediaType}). */
  mediaType?: string | undefined
  /** Why the module could not be loaded or resolved. */
  error?: string | undefined
  /** The npm package id (`kleur@4.1.5`) of a `kind: "npm"` module. */
  npmPackage?: string | undefined
  dependencies: DenoInfoDependency[]
}

/** An npm package of the graph (`npmPackages[id]`). */
export interface DenoInfoNpmPackage {
  /** The package id (`kleur@4.1.5`, or with peer dependencies `react-dom@19.2.0_react@19.2.0`). */
  id: string
  name: string
  version: string
  /** Ids of the packages it depends on. */
  dependencies: string[]
  /** Where the package is (Deno 2.8.3+): `DENO_DIR/npm/…` or `node_modules/.deno/…`. */
  localPath?: string | undefined
}

/** `deno info --json <module>` output (`version: 1`), the parts the engine uses. */
export interface DenoInfoOutput {
  version: 1
  roots: string[]
  modules: DenoInfoModule[]
  /** Specifier → specifier (`jsr:@std/path@^1` → `https://jsr.io/…`, `npm:kleur@^4` → `npm:/kleur@4.1.5`). */
  redirects: Record<string, string>
  /** JSR requirement → package (`@std/path@1` → `@std/path@1.1.6`). */
  packages: Record<string, string>
  npmPackages: Record<string, DenoInfoNpmPackage>
}

/** `deno info --json` printed something the engine does not understand. */
export class DenoInfoFormatError extends Error {
  override readonly name = 'DenoInfoFormatError'
}

/**
 * Parses and validates `deno info --json` output. Unknown fields are ignored; missing optional
 * fields default to empty values.
 *
 * @throws {DenoInfoFormatError} For invalid JSON or an unexpected shape (the message names the
 *   offending field).
 */
export function parseDenoInfo(text: string): DenoInfoOutput {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new DenoInfoFormatError(
      `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const root = record(value, 'the output')
  if (root.version !== 1) {
    throw new DenoInfoFormatError(`unsupported "version" ${JSON.stringify(root.version)}`)
  }
  return {
    version: 1,
    roots: strings(root.roots, 'roots'),
    modules: array(root.modules, 'modules').map((item, index) =>
      parseModule(item, `modules[${index}]`),
    ),
    redirects: optionalStringRecord(root.redirects, 'redirects'),
    packages: optionalStringRecord(root.packages, 'packages'),
    npmPackages: Object.fromEntries(
      Object.entries(optionalRecord(root.npmPackages, 'npmPackages')).map(([id, item]) => [
        id,
        parseNpmPackage(id, item, `npmPackages[${JSON.stringify(id)}]`),
      ]),
    ),
  }
}

function parseModule(value: unknown, at: string): DenoInfoModule {
  const raw = record(value, at)
  return {
    specifier: string(raw.specifier, `${at}.specifier`),
    kind: optionalString(raw.kind, `${at}.kind`),
    local: optionalString(raw.local, `${at}.local`),
    mediaType: optionalString(raw.mediaType, `${at}.mediaType`),
    error: optionalString(raw.error, `${at}.error`),
    npmPackage: optionalString(raw.npmPackage, `${at}.npmPackage`),
    dependencies:
      raw.dependencies === undefined || raw.dependencies === null
        ? []
        : array(raw.dependencies, `${at}.dependencies`).map((item, index) =>
            parseDependency(item, `${at}.dependencies[${index}]`),
          ),
  }
}

function parseDependency(value: unknown, at: string): DenoInfoDependency {
  const raw = record(value, at)
  return {
    specifier: string(raw.specifier, `${at}.specifier`),
    code: parseResolution(raw.code, `${at}.code`),
    type: parseResolution(raw.type, `${at}.type`),
    isDynamic: optionalBoolean(raw.isDynamic, `${at}.isDynamic`),
    assertionType: optionalString(raw.assertionType, `${at}.assertionType`),
  }
}

function parseResolution(value: unknown, at: string): DenoInfoResolution | undefined {
  if (value === undefined || value === null) return undefined
  const raw = record(value, at)
  const specifier = optionalString(raw.specifier, `${at}.specifier`)
  const error = optionalString(raw.error, `${at}.error`)
  if (specifier === undefined && error === undefined) {
    throw new DenoInfoFormatError(`${at} has neither "specifier" nor "error"`)
  }
  return { specifier, error, span: parseSpan(raw.span) }
}

function parseSpan(value: unknown): DenoInfoSpan | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { start, end } = value as Record<string, unknown>
  const from = parsePosition(start)
  const to = parsePosition(end)
  return from === undefined || to === undefined ? undefined : { start: from, end: to }
}

function parsePosition(value: unknown): { line: number; character: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { line, character } = value as Record<string, unknown>
  return typeof line === 'number' && typeof character === 'number' ? { line, character } : undefined
}

function parseNpmPackage(id: string, value: unknown, at: string): DenoInfoNpmPackage {
  const raw = record(value, at)
  return {
    id,
    name: string(raw.name, `${at}.name`),
    version: string(raw.version, `${at}.version`),
    dependencies:
      raw.dependencies === undefined ? [] : strings(raw.dependencies, `${at}.dependencies`),
    localPath: optionalString(raw.localPath, `${at}.localPath`),
  }
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DenoInfoFormatError(`${at} is not an object`)
  }
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown, at: string): Record<string, unknown> {
  return value === undefined || value === null ? {} : record(value, at)
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new DenoInfoFormatError(`${at} is not an array`)
  return value
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string') throw new DenoInfoFormatError(`${at} is not a string`)
  return value
}

function optionalString(value: unknown, at: string): string | undefined {
  return value === undefined || value === null ? undefined : string(value, at)
}

function optionalBoolean(value: unknown, at: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new DenoInfoFormatError(`${at} is not a boolean`)
  return value
}

function strings(value: unknown, at: string): string[] {
  return array(value, at).map((item, index) => string(item, `${at}[${index}]`))
}

function optionalStringRecord(value: unknown, at: string): Record<string, string> {
  const raw = optionalRecord(value, at)
  for (const [key, item] of Object.entries(raw)) string(item, `${at}[${JSON.stringify(key)}]`)
  return raw as Record<string, string>
}

/**
 * The {@link MediaType} for a `deno info` media type name. Deno serialises `Jsx` and `Tsx` as
 * `JSX` and `TSX` (`deno_media_type`'s `Display`); other names are the enum's. Unknown names and
 * `undefined` give `undefined`.
 */
export function toMediaType(name: string | undefined): MediaType | undefined {
  if (name === 'JSX') return 'Jsx'
  if (name === 'TSX') return 'Tsx'
  return isMediaType(name) ? name : undefined
}

/** What Deno reported on stderr while it ran. */
export interface DenoStderr {
  /** URLs of `Download <url>` lines (a download started). */
  downloads: string[]
  /** Packages of `Initialize <package>` lines (installed into `node_modules`). */
  installed: string[]
  /** The text from the first `error: ` line on, without that prefix; `''` when there is none. */
  error: string
  /** URLs of `Specifier: <url>` lines inside the error (the module an error is about). */
  specifiers: string[]
  /** Other `Warning …` lines. */
  warnings: string[]
}

/**
 * Splits Deno's stderr into progress lines and the error. Only URLs and package names are taken
 * from it (to attribute downloads and name the failing module); no decision depends on the error
 * text.
 */
export function parseDenoStderr(text: string): DenoStderr {
  const result: DenoStderr = {
    downloads: [],
    installed: [],
    error: '',
    specifiers: [],
    warnings: [],
  }
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const errorStart = lines.findIndex((line) => line.startsWith('error: '))
  for (const [index, line] of lines.entries()) {
    if (errorStart !== -1 && index >= errorStart) {
      const specifier = /^\s*Specifier: (\S+)\s*$/.exec(line)?.[1]
      if (specifier !== undefined) result.specifiers.push(specifier)
      continue
    }
    const download = /^Download (\S+)\s*$/.exec(line)?.[1]
    if (download !== undefined) {
      result.downloads.push(download)
      continue
    }
    const installed = /^Initialize (\S+)\s*$/.exec(line)?.[1]
    if (installed !== undefined) {
      result.installed.push(installed)
      continue
    }
    if (/^(?:⚠️\s*|Warning\b)/.test(line)) result.warnings.push(line.trim())
  }
  if (errorStart !== -1) {
    result.error = lines.slice(errorStart).join('\n').slice('error: '.length).trim()
  }
  return result
}

/** A remote module read from the `DENO_DIR` cache. */
export interface CachedModule {
  /** The module's bytes (what Deno hashes for `deno.lock`). */
  content: Uint8Array
  /** Response headers recorded by Deno (lower-case names), e.g. `content-type`. */
  headers: Record<string, string>
}

const METADATA_PREFIX = new TextEncoder().encode('\n// denoCacheMetadata=')
const decoder = new TextDecoder()

/**
 * Splits a `DENO_DIR/remote/…` cache file into the module and Deno's metadata. The format
 * (`deno_cache_dir` 0.34 `cache_file.rs`) is `<content>\n// denoCacheMetadata=<json><EOF>`: the
 * last line holds the metadata. Returns `undefined` when the file is not in that format (Deno then
 * treats it as not cached).
 */
export function splitCacheFile(bytes: Uint8Array): CachedModule | undefined {
  const newline = bytes.lastIndexOf(0x0a)
  if (newline === -1 || bytes.length - newline < METADATA_PREFIX.length) return undefined
  for (let index = 0; index < METADATA_PREFIX.length; index++) {
    if (bytes[newline + index] !== METADATA_PREFIX[index]) return undefined
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(decoder.decode(bytes.subarray(newline + METADATA_PREFIX.length)))
  } catch {
    return undefined
  }
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const rawHeaders = (metadata as Record<string, unknown>).headers
  const headers: Record<string, string> = {}
  if (typeof rawHeaders === 'object' && rawHeaders !== null) {
    for (const [name, value] of Object.entries(rawHeaders)) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value
    }
  }
  return { content: bytes.subarray(0, newline), headers }
}
