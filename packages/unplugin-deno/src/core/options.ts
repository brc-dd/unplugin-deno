import { join, resolve } from 'node:path'
import type { UnpluginContextMeta } from 'unplugin'
import { DenoPluginError } from '../diagnostics/errors.js'
import { isDebugEnabled } from '../diagnostics/logger.js'

/** Where the bundled code runs. */
export type Platform = 'browser' | 'node' | 'deno' | 'neutral'

/** A string or RegExp pattern; strings match exactly unless documented otherwise. */
export type Pattern = string | RegExp

/** Options for inlining environment variables into the bundle (planned for M2). */
export interface EnvOptions {
  /** Inline variables whose name starts with one of these prefixes, e.g. `PUBLIC_`. */
  prefix?: string | string[]
  /** Inline these variables by exact name. */
  allow?: string[]
  /** `.env` files to read, relative to `cwd`. */
  files?: string[]
}

/** Toggles for the diagnostics checks (planned for M2). */
export interface ChecksOptions {
  /** Warn when `node:` builtins, `Deno.*` or CommonJS-only packages reach a browser bundle. */
  browserSafety?: boolean
  /** Warn about duplicate copies of frameworks (react, preact, vue, solid). */
  duplicates?: boolean
  /** Explain lockfile drift, minimum-dependency-age and `cachedOnly` misses. */
  lockfile?: boolean
}

/** Context passed to the {@link Options.resolve} hook. */
export interface ResolveHookContext {
  /** The host bundler. */
  host: UnpluginContextMeta['framework']
  /** The platform the importer is bundled for. */
  platform: Platform
}

/**
 * Result of the {@link Options.resolve} hook: a replacement specifier that is resolved further,
 * `false` to leave the import to the host, or `null`/`undefined` for the default behaviour.
 */
export type ResolveHookResult = string | false | null | undefined

/** User-level override of the resolution of one import. */
export type ResolveHook = (
  specifier: string,
  importer: string | undefined,
  context: ResolveHookContext,
) => ResolveHookResult | Promise<ResolveHookResult>

/** Options of unplugin-deno. Every option is optional; see the README for the defaults. */
export interface Options {
  // Discovery

  /**
   * Directory used for config discovery and relative paths.
   * @default the host root (Vite `root`, esbuild `absWorkingDir`, otherwise `process.cwd()`)
   */
  cwd?: string
  /**
   * Path to `deno.json(c)`, relative to `cwd`; `false` disables config discovery (bare
   * specifiers are then never resolved by this plugin).
   * @default discovered by walking up from `cwd`
   */
  config?: string | false
  /**
   * Directory for the remote-module mirror, relative to `cwd`.
   * @default `<workspace root>/node_modules/.unplugin-deno`
   */
  cacheDir?: string
  /**
   * Resolution engine: the vendored `@deno/loader` (`'loader'`), the installed Deno CLI
   * (`'deno'`, planned for M2), or `'auto'` (the loader, falling back to the CLI when the config
   * uses features the loader lacks).
   * @default 'auto'
   */
  engine?: 'auto' | 'loader' | 'deno'
  /**
   * Deno executable used by the `deno` engine (planned; the engine is not implemented yet).
   * @default 'deno' (looked up on `PATH`)
   */
  denoBinary?: string

  // Resolution

  /**
   * Platform the output runs on. `'auto'` derives it from the host configuration and the project
   * shape, never from the runtime running the build; a record maps Vite environment names to
   * platforms.
   * @default 'auto'
   */
  platform?: 'auto' | Platform | Record<string, Platform>
  /**
   * Extra export conditions, added to the platform's conditions.
   * @default []
   */
  conditions?: string[]
  /**
   * Where npm packages are loaded from: the project's `node_modules` (resolved by the host),
   * Deno's global npm cache, or `'auto'` (`node_modules` unless `nodeModulesDir` is `"none"`).
   * @default 'auto'
   */
  npm?: 'auto' | 'node_modules' | 'deno-cache'
  /**
   * How `deno.lock` is used: `'auto'` reads it, `'frozen'` fails when resolutions drift from it
   * (planned for M2), `'off'` ignores it.
   * @default 'auto'
   */
  lockfile?: 'auto' | 'frozen' | 'off'
  /**
   * Never download; fail with a hint to run `deno install` when a module is not cached.
   * @default false
   */
  cachedOnly?: boolean
  /**
   * Hosts remote `https:`/`http:` imports may load from. Replaces the default list; spread
   * `DEFAULT_ALLOW_IMPORT` to extend it.
   * @default Deno's `--allow-import` defaults (`deno.land`, `jsr.io`, `esm.sh`, `cdn.jsdelivr.net`,
   *   `raw.githubusercontent.com`, `gist.githubusercontent.com`)
   *
   * Planned: not enforced yet.
   */
  allowImport?: string[]
  /**
   * Specifiers or import-map keys left to the host's resolver.
   * @default []
   */
  exclude?: Pattern | Pattern[]
  /**
   * Limits which importers the plugin acts on (by module id).
   * @default all importers
   */
  importers?: { include?: Pattern | Pattern[]; exclude?: Pattern | Pattern[] }

  // Externals (server output)

  /**
   * Specifiers kept as imports in the output, using `deno bundle` patterns (`npm:*`,
   * `jsr:@std/*`, exact specifiers) or RegExps.
   * @default []
   */
  external?: Pattern[]
  /**
   * Specifiers bundled even when the platform would keep them external (`platform: 'deno'`).
   * @default []
   */
  bundle?: Pattern[]
  /**
   * Rewrite external `npm:`/`jsr:` specifiers to the exact resolved versions.
   * @default true for platform `deno`, otherwise false
   */
  pinExternals?: boolean
  /**
   * Write a `deno.json` (and trimmed `deno.lock`) next to the output that pins the externals
   * (planned for M2). A string sets the file name.
   * @default false
   */
  emitDenoConfig?: boolean | string

  // Transforms

  /**
   * Support `with { type: "text" | "bytes" }` import attributes on every host.
   * @default true
   */
  importAttributes?: boolean
  /**
   * Replace `import.meta.main` with `false` outside entry modules (planned for M2).
   * @default true
   */
  importMetaMain?: boolean
  /**
   * Inline environment variables (planned for M2); `false` disables it.
   * @default false
   */
  env?: EnvOptions | false
  /**
   * What to do when `Deno.*` globals reach a browser bundle (planned for M2).
   * @default 'warn' for the browser platform, otherwise 'off'
   */
  denoGlobals?: 'error' | 'warn' | 'off'
  /**
   * Who transforms JSX in local files: the host (`'host'`), the engine per `deno.json`
   * (`'deno'`, supports `precompile`), or `'auto'` (host for local files, engine for remote ones).
   * @default 'auto'
   *
   * Planned: `'deno'` (transpiling local files through the engine, e.g. `jsx: "precompile"`) has no
   * effect yet; local files are always transpiled by the host, remote modules by the engine.
   */
  jsx?: 'auto' | 'host' | 'deno'

  // Diagnostics

  /**
   * Diagnostics checks (planned for M2); `true`/`false` toggles all of them.
   * @default all enabled
   */
  checks?: ChecksOptions | boolean
  /**
   * Print debug output (engine, config files, lockfile, per-specifier trace).
   * @default true when `DEBUG` matches `unplugin-deno`
   */
  debug?: boolean

  // Escape hatches

  /** Overrides the resolution of individual imports. */
  resolve?: ResolveHook
}

/** Config discovery mode after {@link resolveOptions}. */
export type ResolvedConfigOption =
  | { mode: 'discover' }
  | { mode: 'file'; path: string }
  | { mode: 'none' }

/** {@link Options} with every default applied; hooks read only this object. */
export interface ResolvedOptions {
  /** Absolute. */
  cwd: string
  config: ResolvedConfigOption
  /** Absolute, or `null` for the default under the workspace root (see {@link defaultCacheDir}). */
  cacheDir: string | null
  engine: 'auto' | 'loader' | 'deno'
  denoBinary: string
  platform: 'auto' | Platform | Readonly<Record<string, Platform>>
  conditions: string[]
  npm: 'auto' | 'node_modules' | 'deno-cache'
  lockfile: 'auto' | 'frozen' | 'off'
  cachedOnly: boolean
  allowImport: string[]
  exclude: Pattern[]
  importers: { include: Pattern[]; exclude: Pattern[] }
  external: Pattern[]
  bundle: Pattern[]
  /** `null`: decided per platform by {@link pinExternalsFor}. */
  pinExternals: boolean | null
  emitDenoConfig: boolean | string
  importAttributes: boolean
  importMetaMain: boolean
  env: { prefix: string[]; allow: string[]; files: string[] } | false
  /** `null`: decided per platform by {@link denoGlobalsFor}. */
  denoGlobals: 'error' | 'warn' | 'off' | null
  jsx: 'auto' | 'host' | 'deno'
  checks: Required<ChecksOptions>
  debug: boolean
  resolve: ResolveHook | undefined
}

/** Host information {@link resolveOptions} needs. */
export interface OptionsContext {
  /** Absolute host root (Vite `root`, esbuild `absWorkingDir`, otherwise `process.cwd()`). */
  root: string
  /** Environment variables (`DEBUG`). */
  env: Readonly<Record<string, string | undefined>>
}

/** Deno's default `--allow-import` hosts. */
export const DEFAULT_ALLOW_IMPORT: readonly string[] = Object.freeze([
  'deno.land',
  'jsr.io',
  'esm.sh',
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
])

const PLATFORMS: readonly Platform[] = ['browser', 'node', 'deno', 'neutral']

/** The default mirror directory for a workspace root: `<root>/node_modules/.unplugin-deno`. */
export function defaultCacheDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'node_modules', '.unplugin-deno')
}

/** Whether external `npm:`/`jsr:` specifiers are pinned for `platform`. */
export function pinExternalsFor(
  options: Pick<ResolvedOptions, 'pinExternals'>,
  platform: Platform,
): boolean {
  return options.pinExternals ?? platform === 'deno'
}

/** The `denoGlobals` behaviour for `platform`. */
export function denoGlobalsFor(
  options: Pick<ResolvedOptions, 'denoGlobals'>,
  platform: Platform,
): 'error' | 'warn' | 'off' {
  return options.denoGlobals ?? (platform === 'browser' ? 'warn' : 'off')
}

/**
 * Validates user options and applies every default (docs/architecture.md §5.1). Pure: it reads
 * nothing but its arguments.
 *
 * @throws {DenoPluginError} `OPTIONS_INVALID` for values of the wrong type.
 */
export function resolveOptions(
  user: Options | undefined,
  context: OptionsContext,
): ResolvedOptions {
  const options: Options = user ?? {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw invalid('options', 'an object', options)
  }
  const cwd = resolve(context.root, optionalString(options, 'cwd') ?? '.')
  const cacheDir = optionalString(options, 'cacheDir')
  return {
    cwd,
    config: resolveConfig(options.config, cwd),
    cacheDir: cacheDir === undefined ? null : resolve(cwd, cacheDir),
    engine: oneOf(options, 'engine', ['auto', 'loader', 'deno'], 'auto'),
    denoBinary: optionalString(options, 'denoBinary') ?? 'deno',
    platform: resolvePlatform(options.platform),
    conditions: stringArray(options, 'conditions') ?? [],
    npm: oneOf(options, 'npm', ['auto', 'node_modules', 'deno-cache'], 'auto'),
    lockfile: oneOf(options, 'lockfile', ['auto', 'frozen', 'off'], 'auto'),
    cachedOnly: optionalBoolean(options, 'cachedOnly') ?? false,
    allowImport: stringArray(options, 'allowImport') ?? [...DEFAULT_ALLOW_IMPORT],
    exclude: patterns('exclude', options.exclude),
    importers: resolveImporters(options.importers),
    external: patterns('external', options.external),
    bundle: patterns('bundle', options.bundle),
    pinExternals: optionalBoolean(options, 'pinExternals') ?? null,
    emitDenoConfig: resolveEmitDenoConfig(options.emitDenoConfig),
    importAttributes: optionalBoolean(options, 'importAttributes') ?? true,
    importMetaMain: optionalBoolean(options, 'importMetaMain') ?? true,
    env: resolveEnv(options.env),
    denoGlobals:
      options.denoGlobals === undefined
        ? null
        : oneOf(options, 'denoGlobals', ['error', 'warn', 'off'], 'warn'),
    jsx: oneOf(options, 'jsx', ['auto', 'host', 'deno'], 'auto'),
    checks: resolveChecks(options.checks),
    debug: optionalBoolean(options, 'debug') ?? isDebugEnabled(context.env),
    resolve: resolveHook(options.resolve),
  }
}

function resolveConfig(value: Options['config'], cwd: string): ResolvedConfigOption {
  if (value === undefined) return { mode: 'discover' }
  if (value === false) return { mode: 'none' }
  if (typeof value === 'string' && value !== '') return { mode: 'file', path: resolve(cwd, value) }
  throw invalid('config', 'a non-empty path or false', value)
}

function resolvePlatform(value: unknown): ResolvedOptions['platform'] {
  if (value === undefined || value === 'auto') return 'auto'
  if (isPlatform(value)) return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value)
    for (const [name, platform] of entries) {
      if (!isPlatform(platform)) {
        throw invalid(`platform.${name}`, `one of ${quoteList(PLATFORMS)}`, platform)
      }
    }
    return Object.freeze(Object.fromEntries(entries) as Record<string, Platform>)
  }
  throw invalid('platform', `'auto', one of ${quoteList(PLATFORMS)} or a record of them`, value)
}

function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

function resolveImporters(value: unknown): ResolvedOptions['importers'] {
  if (value === undefined) return { include: [], exclude: [] }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('importers', 'an object with include/exclude patterns', value)
  }
  const { include, exclude } = value as { include?: unknown; exclude?: unknown }
  return {
    include: patterns('importers.include', include),
    exclude: patterns('importers.exclude', exclude),
  }
}

function resolveEmitDenoConfig(value: unknown): boolean | string {
  if (value === undefined) return false
  if (typeof value === 'boolean' || (typeof value === 'string' && value !== '')) return value
  throw invalid('emitDenoConfig', 'a boolean or a file name', value)
}

function resolveEnv(value: unknown): ResolvedOptions['env'] {
  if (value === undefined || value === false) return false
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('env', 'an object or false', value)
  }
  const env = value as Record<string, unknown>
  const prefix = env.prefix
  return {
    prefix:
      typeof prefix === 'string' ? [prefix] : (stringArray(env, 'prefix', 'env.prefix') ?? []),
    allow: stringArray(env, 'allow', 'env.allow') ?? [],
    files: stringArray(env, 'files', 'env.files') ?? [],
  }
}

function resolveChecks(value: unknown): Required<ChecksOptions> {
  if (value === undefined || value === true) {
    return { browserSafety: true, duplicates: true, lockfile: true }
  }
  if (value === false) return { browserSafety: false, duplicates: false, lockfile: false }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('checks', 'a boolean or an object', value)
  }
  const checks = value as Record<string, unknown>
  return {
    browserSafety: optionalBoolean(checks, 'browserSafety', 'checks.browserSafety') ?? true,
    duplicates: optionalBoolean(checks, 'duplicates', 'checks.duplicates') ?? true,
    lockfile: optionalBoolean(checks, 'lockfile', 'checks.lockfile') ?? true,
  }
}

function resolveHook(value: unknown): ResolveHook | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'function') return value as ResolveHook
  throw invalid('resolve', 'a function', value)
}

function patterns(name: string, value: unknown): Pattern[] {
  if (value === undefined) return []
  const list: unknown[] = Array.isArray(value) ? value : [value]
  for (const item of list) {
    if (typeof item !== 'string' && !(item instanceof RegExp)) {
      throw invalid(name, 'strings or RegExps', item)
    }
  }
  return list as Pattern[]
}

function oneOf<const T extends string>(
  options: object,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value: unknown = Reflect.get(options, key)
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw invalid(key, `one of ${quoteList(allowed)}`, value)
}

function optionalString(options: object, key: string): string | undefined {
  const value: unknown = Reflect.get(options, key)
  if (value === undefined || typeof value === 'string') return value
  throw invalid(key, 'a string', value)
}

function optionalBoolean(options: object, key: string, label = key): boolean | undefined {
  const value: unknown = Reflect.get(options, key)
  if (value === undefined || typeof value === 'boolean') return value
  throw invalid(label, 'a boolean', value)
}

function stringArray(options: object, key: string, label = key): string[] | undefined {
  const value: unknown = Reflect.get(options, key)
  if (value === undefined) return undefined
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value]
  throw invalid(label, 'an array of strings', value)
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

function invalid(name: string, expected: string, actual: unknown): DenoPluginError {
  const shown = typeof actual === 'string' ? `'${actual}'` : describeValue(actual)
  return new DenoPluginError(
    'OPTIONS_INVALID',
    `Invalid option \`${name}\`: expected ${expected}, got ${shown}.`,
  )
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (value instanceof RegExp) return String(value)
  if (typeof value === 'object') return 'an object'
  if (typeof value === 'function') return 'a function'
  return String(value)
}
