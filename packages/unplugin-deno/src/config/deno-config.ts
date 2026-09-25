import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DenoPluginError } from '../diagnostics/errors.js'
import { locateJsonValue, parseJsonc } from '../utils/fs.js'
import { toPath } from '../utils/path.js'

/** `nodeModulesDir` modes (Deno ≥ 2.0; the legacy booleans map to `auto`/`none`). */
export type NodeModulesDirMode = 'auto' | 'manual' | 'none'

/** `compilerOptions.jsx` values accepted by Deno 2.9. */
export type JsxMode =
  | 'preserve'
  | 'react'
  | 'react-jsx'
  | 'react-jsxdev'
  | 'react-native'
  | 'precompile'

/** The `compilerOptions` fields the plugin reads. */
export interface DenoCompilerOptions {
  jsx?: JsxMode
  jsxImportSource?: string
  jsxImportSourceTypes?: string
  jsxFactory?: string
  jsxFragmentFactory?: string
  jsxPrecompileSkipElements?: string[]
  types?: string[]
}

/** `lock`: `false` disables the lockfile, a string sets its path. */
export type LockConfig = boolean | string | { path?: string; frozen?: boolean }

/**
 * A minimum dependency age: minutes (number or digits), an ISO-8601 duration (`P2D`), an RFC 3339
 * date or date-time (`2025-09-16`), or `0`/`false` to disable it.
 */
export type MinimumDependencyAgeValue = number | string | boolean

/**
 * `minimumDependencyAge` is a `deno.json` key since Deno 2.5.5 (verified against
 * `cli/schemas/config-file.v1.json` at v2.9.7 and `libs/config/deno_json/mod.rs`
 * `to_minimum_dependency_age_config`): a {@link MinimumDependencyAgeValue} or
 * `{ age?, exclude?: ["npm:pkg", "jsr:@scope/*"] }`. Only the workspace root's value is used; the
 * default is 1440 minutes (24 h) since Deno 2.9.
 */
export type MinimumDependencyAgeConfig =
  | MinimumDependencyAgeValue
  | { age?: MinimumDependencyAgeValue; exclude?: string[] }

/**
 * The subset of `deno.json(c)` the plugin uses (schema: Deno 2.9.7
 * `cli/schemas/config-file.v1.json`). Unknown keys are ignored when reading.
 */
export interface DenoConfig {
  /** JSR package name (`@scope/name`) of a workspace member or linked package. */
  name?: string
  version?: string
  /** A root export (`"./mod.ts"`) or a map of export names to files. */
  exports?: string | Record<string, unknown>
  /** Import map entries; non-string values become invalid (`null`) entries. */
  imports?: Record<string, unknown>
  scopes?: Record<string, Record<string, unknown>>
  /** Path (or `file:` URL) of an external import map, used when `imports`/`scopes` are absent. */
  importMap?: string
  workspace?: string[] | { members?: string[] }
  /** Local JSR/npm packages that override registry versions (stable since Deno 2.9). */
  links?: string[]
  /** Deprecated name of {@link DenoConfig.links} (before Deno 2.3.6). */
  patch?: string[]
  nodeModulesDir?: NodeModulesDirMode | boolean
  /** npm linker for `node_modules` (Deno 2.8; not in the JSON schema but read by Deno). */
  nodeModulesLinker?: 'isolated' | 'hoisted'
  /** Install `jsr:` dependencies into `node_modules/@jsr/…` (Deno 2.9). */
  jsrDepsInNodeModules?: boolean
  vendor?: boolean
  lock?: LockConfig
  compilerOptions?: DenoCompilerOptions
  unstable?: string[]
  exclude?: string[]
  minimumDependencyAge?: MinimumDependencyAgeConfig
  /** Default catalog for `catalog:` values (Deno 2.8). */
  catalog?: Record<string, string>
  /** Named catalogs for `catalog:<name>` values (Deno 2.8). */
  catalogs?: Record<string, Record<string, string>>
}

const DOCS_HINT = 'See https://docs.deno.com/go/config for the expected shape.'

/**
 * Reads and validates a `deno.json(c)`. An empty file is an empty config (like Deno).
 *
 * @throws {DenoPluginError} `CONFIG_NOT_FOUND` when the file does not exist, `CONFIG_INVALID`
 *   for syntax errors and invalid values (with `file:line:column`).
 */
export async function readDenoConfig(path: string): Promise<DenoConfig> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw readError(path, error)
  }
  return parseDenoConfig(text, path)
}

/** Maps a file system error of a config read to a {@link DenoPluginError}. */
export function readError(path: string, error: unknown): DenoPluginError {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new DenoPluginError('CONFIG_NOT_FOUND', `Cannot find ${path}.`, {
      hint: 'Check the `config` option or create the file.',
      cause: error,
    })
  }
  return new DenoPluginError('CONFIG_INVALID', `Cannot read ${path}.`, { cause: error })
}

/**
 * Parses and validates the text of a `deno.json(c)` (see {@link readDenoConfig}).
 *
 * @throws {DenoPluginError} `CONFIG_INVALID` with `file:line:column`.
 */
export function parseDenoConfig(text: string, file: string): DenoConfig {
  const source = text.replace(/^\uFEFF/, '')
  if (source.trim() === '') return {}
  const value = parseJsonc(source, file)
  const check = new Checker(source, file)
  const root = check.object(value, [], 'a JSON object')
  const config: DenoConfig = {}
  const get = (key: string): unknown => (Object.hasOwn(root, key) ? root[key] : undefined)

  assign(config, 'name', check.optionalString(get('name'), ['name']))
  assign(config, 'version', check.optionalString(get('version'), ['version']))
  assign(config, 'importMap', check.optionalString(get('importMap'), ['importMap']))
  assign(config, 'exports', check.exports(get('exports')))
  assign(config, 'imports', check.optionalObject(get('imports'), ['imports']))
  assign(config, 'scopes', check.scopes(get('scopes')))
  assign(config, 'workspace', check.workspace(get('workspace')))
  assign(config, 'links', check.optionalStrings(get('links'), ['links']))
  assign(config, 'patch', check.optionalStrings(get('patch'), ['patch']))
  assign(config, 'nodeModulesDir', check.nodeModulesDir(get('nodeModulesDir')))
  assign(
    config,
    'nodeModulesLinker',
    check.optionalEnum(get('nodeModulesLinker'), ['nodeModulesLinker'], ['isolated', 'hoisted']),
  )
  assign(
    config,
    'jsrDepsInNodeModules',
    check.optionalBoolean(get('jsrDepsInNodeModules'), ['jsrDepsInNodeModules']),
  )
  assign(config, 'vendor', check.optionalBoolean(get('vendor'), ['vendor']))
  assign(config, 'lock', check.lock(get('lock')))
  assign(config, 'compilerOptions', check.compilerOptions(get('compilerOptions')))
  assign(config, 'unstable', check.optionalStrings(get('unstable'), ['unstable']))
  assign(config, 'exclude', check.optionalStrings(get('exclude'), ['exclude']))
  assign(config, 'minimumDependencyAge', check.minimumDependencyAge(get('minimumDependencyAge')))
  assign(config, 'catalog', check.stringRecord(get('catalog'), ['catalog']))
  assign(config, 'catalogs', check.catalogs(get('catalogs')))
  return config
}

function assign<K extends keyof DenoConfig>(
  config: DenoConfig,
  key: K,
  value: DenoConfig[K] | undefined,
): void {
  if (value !== undefined) config[key] = value
}

type JsonPath = Array<string | number>

function compilerOptionPath(key: string): JsonPath {
  return ['compilerOptions', key]
}

/** Validates JSON values, reporting errors at the value's position in the source text. */
class Checker {
  private readonly text: string
  private readonly file: string

  constructor(text: string, file: string) {
    this.text = text
    this.file = file
  }

  fail(path: JsonPath, expected: string): never {
    const position = locateJsonValue(this.text, path) ?? { line: 1, column: 1 }
    const field = path.length === 0 ? 'The config' : `"${path.join('.')}"`
    throw new DenoPluginError(
      'CONFIG_INVALID',
      `${this.file}:${position.line}:${position.column}: ${field} must be ${expected}.`,
      { hint: DOCS_HINT },
    )
  }

  object(value: unknown, path: JsonPath, expected = 'an object'): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return this.fail(path, expected)
    }
    return value as Record<string, unknown>
  }

  optionalObject(value: unknown, path: JsonPath): Record<string, unknown> | undefined {
    return value === undefined || value === null ? undefined : this.object(value, path)
  }

  optionalString(value: unknown, path: JsonPath): string | undefined {
    if (value === undefined || value === null) return undefined
    return typeof value === 'string' ? value : this.fail(path, 'a string')
  }

  optionalBoolean(value: unknown, path: JsonPath): boolean | undefined {
    if (value === undefined || value === null) return undefined
    return typeof value === 'boolean' ? value : this.fail(path, 'a boolean')
  }

  optionalStrings(value: unknown, path: JsonPath): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) return this.fail(path, 'an array of strings')
    value.forEach((item, index) => {
      if (typeof item !== 'string') this.fail([...path, index], 'a string')
    })
    return [...(value as string[])]
  }

  optionalEnum<const T extends string>(
    value: unknown,
    path: JsonPath,
    allowed: readonly T[],
  ): T | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
      return value as T
    return this.fail(path, `one of ${allowed.map((item) => `"${item}"`).join(', ')}`)
  }

  stringRecord(value: unknown, path: JsonPath): Record<string, string> | undefined {
    const record = this.optionalObject(value, path)
    if (record === undefined) return undefined
    for (const [key, item] of Object.entries(record)) {
      if (typeof item !== 'string') this.fail([...path, key], 'a string')
    }
    return record as Record<string, string>
  }

  catalogs(value: unknown): Record<string, Record<string, string>> | undefined {
    const record = this.optionalObject(value, ['catalogs'])
    if (record === undefined) return undefined
    const result: Record<string, Record<string, string>> = {}
    for (const key of Object.keys(record)) {
      result[key] = this.stringRecord(record[key], ['catalogs', key]) ?? {}
    }
    return result
  }

  exports(value: unknown): DenoConfig['exports'] {
    if (value === undefined || value === null || typeof value === 'string')
      return value ?? undefined
    return this.object(value, ['exports'], 'a string or an object')
  }

  scopes(value: unknown): DenoConfig['scopes'] {
    const scopes = this.optionalObject(value, ['scopes'])
    if (scopes === undefined) return undefined
    const result: Record<string, Record<string, unknown>> = {}
    for (const key of Object.keys(scopes)) {
      result[key] = this.object(scopes[key], ['scopes', key])
    }
    return result
  }

  workspace(value: unknown): DenoConfig['workspace'] {
    if (value === undefined || value === null) return undefined
    if (Array.isArray(value)) return this.optionalStrings(value, ['workspace'])
    const object = this.object(value, ['workspace'], 'an array of strings or { "members": [...] }')
    const members = this.optionalStrings(object.members, ['workspace', 'members'])
    return members === undefined ? {} : { members }
  }

  nodeModulesDir(value: unknown): DenoConfig['nodeModulesDir'] {
    if (value === undefined || value === null || typeof value === 'boolean')
      return value ?? undefined
    return this.optionalEnum(value, ['nodeModulesDir'], ['auto', 'manual', 'none'])
  }

  lock(value: unknown): LockConfig | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'boolean' || typeof value === 'string') return value
    const object = this.object(value, ['lock'], 'a boolean, a path or { "path", "frozen" }')
    const path = this.optionalString(object.path, ['lock', 'path'])
    const frozen = this.optionalBoolean(object.frozen, ['lock', 'frozen'])
    return { ...(path === undefined ? {} : { path }), ...(frozen === undefined ? {} : { frozen }) }
  }

  compilerOptions(value: unknown): DenoCompilerOptions | undefined {
    const object = this.optionalObject(value, ['compilerOptions'])
    if (object === undefined) return undefined
    const options: DenoCompilerOptions = {}
    const jsx = this.optionalEnum(object.jsx, compilerOptionPath('jsx'), [
      'preserve',
      'react',
      'react-jsx',
      'react-jsxdev',
      'react-native',
      'precompile',
    ])
    if (jsx !== undefined) options.jsx = jsx
    for (const key of [
      'jsxImportSource',
      'jsxImportSourceTypes',
      'jsxFactory',
      'jsxFragmentFactory',
    ] as const) {
      const text = this.optionalString(object[key], compilerOptionPath(key))
      if (text !== undefined) options[key] = text
    }
    const skip = this.optionalStrings(
      object.jsxPrecompileSkipElements,
      compilerOptionPath('jsxPrecompileSkipElements'),
    )
    if (skip !== undefined) options.jsxPrecompileSkipElements = skip
    const types = this.optionalStrings(object.types, compilerOptionPath('types'))
    if (types !== undefined) options.types = types
    return options
  }

  minimumDependencyAge(value: unknown): MinimumDependencyAgeConfig | undefined {
    const path = ['minimumDependencyAge']
    if (value === undefined || value === null) return undefined
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      return value
    }
    const object = this.object(value, path, 'a number, a string, false or { "age", "exclude" }')
    const age = object.age
    if (
      age !== undefined &&
      age !== null &&
      !['number', 'string', 'boolean'].includes(typeof age)
    ) {
      this.fail([...path, 'age'], 'a number, a string or false')
    }
    const exclude = this.optionalStrings(object.exclude, [...path, 'exclude'])
    return {
      ...(age === undefined || age === null ? {} : { age: age as MinimumDependencyAgeValue }),
      ...(exclude === undefined ? {} : { exclude }),
    }
  }
}

/** `nodeModulesDir` with the legacy booleans mapped (`true` → `auto`, `false` → `none`). */
export function normalizeNodeModulesDir(
  value: DenoConfig['nodeModulesDir'],
): NodeModulesDirMode | undefined {
  if (value === true) return 'auto'
  if (value === false) return 'none'
  return value
}

/** Workspace member entries from either `workspace` form, or `undefined` when not a workspace. */
export function normalizeWorkspace(config: DenoConfig): string[] | undefined {
  const { workspace } = config
  if (workspace === undefined) return undefined
  return Array.isArray(workspace) ? workspace : (workspace.members ?? [])
}

/** `links` entries (falling back to the deprecated `patch`), and whether `patch` was used. */
export function normalizeLinks(config: DenoConfig): { links: string[]; deprecatedPatch: boolean } {
  if (config.links !== undefined) return { links: config.links, deprecatedPatch: false }
  if (config.patch !== undefined) return { links: config.patch, deprecatedPatch: true }
  return { links: [], deprecatedPatch: false }
}

/**
 * `exports` as a map of export names to file paths (`"./mod.ts"` → `{ ".": "./mod.ts" }`).
 * Entries with non-string values are dropped; use {@link validateExports} to report them.
 */
export function normalizeExports(exports: DenoConfig['exports']): Record<string, string> {
  if (exports === undefined) return {}
  if (typeof exports === 'string') return { '.': exports }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

/**
 * The first problem with `exports` under Deno's rules (`to_exports_config`): keys are `.` or
 * `./name` without trailing slash, empty or dot-only segments, or characters outside
 * `[a-zA-Z0-9_\-./]`; values are strings starting with `./`, not ending in `/`, with a file
 * extension. Returns `undefined` when valid. Deno ignores a package with invalid exports.
 */
export function validateExports(exports: DenoConfig['exports']): string | undefined {
  if (exports === undefined) return undefined
  if (typeof exports === 'string') return validateExportValue('.', exports)
  for (const [key, value] of Object.entries(exports)) {
    if (key !== '.') {
      if (key === '') return 'an export name must not be empty (use "." for the root export)'
      if (!key.startsWith('./')) return `the export name "${key}" must start with "./"`
      if (key.endsWith('/')) return `the export name "${key}" must not end with "/"`
      if (!/^[a-zA-Z0-9_\-./]+$/.test(key)) return `the export name "${key}" has invalid characters`
      if (
        key
          .split('/')
          .slice(1)
          .some((part) => part === '' || /^\.+$/.test(part))
      ) {
        return `the export name "${key}" has empty or dot-only segments`
      }
    }
    if (typeof value !== 'string') return `the "${key}" export must be a string`
    const problem = validateExportValue(key, value)
    if (problem !== undefined) return problem
  }
  return undefined
}

function validateExportValue(key: string, value: string): string | undefined {
  if (!value.startsWith('./')) return `the "${key}" export "${value}" must start with "./"`
  if (value.endsWith('/')) return `the "${key}" export "${value}" must not end with "/"`
  const last = value.slice(value.lastIndexOf('/'))
  if (!last.includes('.')) return `the "${key}" export "${value}" must have a file extension`
  return undefined
}

/** The resolved `lock` setting of a config. */
export interface LockSettings {
  /** `false` when `lock: false`. */
  enabled: boolean
  /** Absolute path of the lockfile (`<config dir>/deno.lock` by default), `null` when disabled. */
  path: string | null
  /** `lock.frozen`. */
  frozen: boolean
}

/** Resolves `lock` relative to the config file (Deno's `resolve_lockfile_path`). */
export function normalizeLock(config: DenoConfig, configPath: string): LockSettings {
  const { lock } = config
  const dir = dirname(configPath)
  if (lock === false) return { enabled: false, path: null, frozen: false }
  const custom = typeof lock === 'string' ? lock : typeof lock === 'object' ? lock.path : undefined
  const path = custom === undefined ? resolve(dir, 'deno.lock') : resolveConfigPath(dir, custom)
  const frozen = typeof lock === 'object' && lock.frozen === true
  return { enabled: true, path, frozen }
}

/** Resolves a path written in a config file (relative to its directory; `file:` URLs allowed). */
export function resolveConfigPath(dir: string, value: string): string {
  if (value.startsWith('file:')) return toPath(value)
  return isAbsolute(value) ? value : resolve(dir, value)
}

/** The JSX settings of a config, with Deno's defaults for `jsx`, `jsxFactory` and `jsxFragmentFactory`. */
export interface JsxSettings {
  jsx: JsxMode
  importSource: string | undefined
  importSourceTypes: string | undefined
  factory: string
  fragmentFactory: string
  precompileSkipElements: string[] | undefined
}

/** Reads the `compilerOptions.jsx*` settings (defaults from the Deno 2.9 schema). */
export function jsxSettings(config: DenoConfig | undefined): JsxSettings {
  const options = config?.compilerOptions ?? {}
  return {
    jsx: options.jsx ?? 'react',
    importSource: options.jsxImportSource,
    importSourceTypes: options.jsxImportSourceTypes,
    factory: options.jsxFactory ?? 'React.createElement',
    fragmentFactory: options.jsxFragmentFactory ?? 'React.Fragment',
    precompileSkipElements: options.jsxPrecompileSkipElements,
  }
}

/** Fields Deno only honours in the workspace root config (it warns and ignores them in members). */
export const ROOT_ONLY_FIELDS = [
  'importMap',
  'lock',
  'minimumDependencyAge',
  'nodeModulesDir',
  'nodeModulesLinker',
  'jsrDepsInNodeModules',
  'catalog',
  'catalogs',
  'links',
  'patch',
  'scopes',
  'unstable',
  'vendor',
  'workspace',
] as const satisfies ReadonlyArray<keyof DenoConfig>

/** Warnings for root-only fields set in a workspace member config (Deno's wording). */
export function memberConfigWarnings(config: DenoConfig): string[] {
  return ROOT_ONLY_FIELDS.filter((field) => config[field] !== undefined).map(
    (field) => `The "${field}" field can only be specified in the workspace root deno.json file.`,
  )
}

/** Deno 2.9's default minimum dependency age: 1440 minutes (24 h). */
export const DEFAULT_MINIMUM_DEPENDENCY_AGE_MINUTES = 1440

/** A resolved minimum dependency age. */
export interface MinimumDependencyAge {
  /** Only versions published before this date are used; `null` when disabled. */
  newestDependencyDate: Date | null
  /** `npm:`/`jsr:` package names (or `prefix*` patterns) exempt from the age requirement. */
  exclude: string[]
}

/**
 * Resolves `minimumDependencyAge` relative to `now` (Deno's `parse_minutes_duration_or_date`):
 * a number or digits = minutes; `0`, `"0"` and `false` disable it; otherwise an RFC 3339 date-time,
 * a `YYYY-MM-DD` date (midnight UTC) or an ISO-8601 duration without years or months (`P2D`,
 * `PT12H`, `P1W`). Returns `undefined` when unset (callers apply
 * {@link DEFAULT_MINIMUM_DEPENDENCY_AGE_MINUTES}).
 *
 * @throws {DenoPluginError} `CONFIG_INVALID` for values Deno rejects.
 */
export function resolveMinimumDependencyAge(
  value: MinimumDependencyAgeConfig | undefined,
  now: Date,
  file = 'deno.json',
): MinimumDependencyAge | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object') {
    const date = value.age === undefined ? undefined : ageToDate(value.age, now, file)
    return { newestDependencyDate: date ?? null, exclude: value.exclude ?? [] }
  }
  return { newestDependencyDate: ageToDate(value, now, file), exclude: [] }
}

function ageToDate(value: MinimumDependencyAgeValue, now: Date, file: string): Date | null {
  if (value === false || value === 0 || value === '0') return null
  if (typeof value === 'number' && Number.isInteger(value)) return minutesBefore(now, value)
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return minutesBefore(now, Number(value))
    const date = parseDate(value)
    if (date !== undefined) return date
    const duration = parseIsoDuration(value)
    if (duration !== undefined) return new Date(now.getTime() - duration)
  }
  throw new DenoPluginError(
    'CONFIG_INVALID',
    `${file}: "minimumDependencyAge" must be minutes, an ISO-8601 duration or an RFC 3339 date, got ${JSON.stringify(value)}.`,
    { hint: 'Use e.g. 1440, "P2D" or "2025-09-16"; 0 or false disables it.' },
  )
}

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * MINUTE_MS)
}

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDate(text: string): Date | undefined {
  const dateOnly = DATE_ONLY.exec(text)
  if (dateOnly !== null) {
    const date = new Date(`${text}T00:00:00Z`)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  const match = DATE_TIME.exec(text)
  if (match === null) return undefined
  const [, year, month, day, hour, minute, second = '00', fraction = '', zone = 'Z'] = match
  const offset = /^[Zz]$/.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${offset}`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const SECOND_MS = 1_000

/** ISO-8601 durations as Deno accepts them (`PnW` alone, or `PnDTnHnMnS`; no years/months). */
function parseIsoDuration(text: string): number | undefined {
  const sign = text.startsWith('-') ? -1 : 1
  const body = text.replace(/^[+-]/, '')
  const weeks = /^P(\d+)[Ww]$/.exec(body)
  if (weeks !== null) return sign * Number(weeks[1]) * 7 * DAY_MS
  const match =
    /^P(?:(\d+)[Dd])?(?:[Tt](?:(\d+)[Hh])?(?:(\d+)[Mm])?(?:(\d+(?:\.\d+)?)[Ss])?)?$/.exec(body)
  if (match === null || body === 'P' || /[Tt]$/.test(body)) return undefined
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  const total =
    Number(days) * DAY_MS +
    Number(hours) * HOUR_MS +
    Number(minutes) * MINUTE_MS +
    Number(seconds) * SECOND_MS
  return sign * total
}
