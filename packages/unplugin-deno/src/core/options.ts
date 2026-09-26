import { join, resolve } from 'node:path'
import type { UnpluginContextMeta } from 'unplugin'
import { DenoPluginError } from '../diagnostics/errors.js'
import { isDebugEnabled } from '../diagnostics/logger.js'

/** Where the bundled code runs. */
export type Platform = 'browser' | 'node' | 'deno' | 'neutral'

/** A string or RegExp pattern; strings match exactly unless documented otherwise. */
export type Pattern = string | RegExp

/**
 * Options for inlining environment variables: reads with a literal key (`Deno.env.get("X")`,
 * `process.env.X`, `process.env["X"]`) of allowed variables are replaced with their values as JSON
 * literals (`undefined` when unset). `Deno.env.toObject()` and other reads stay as they are.
 * Recommended: `{ prefix: 'PUBLIC_' }`.
 */
export interface EnvOptions {
  /** Inline variables whose name starts with one of these (non-empty) prefixes, e.g. `PUBLIC_`. */
  prefix?: string | string[]
  /** Inline these variables by exact name. */
  allow?: string[]
  /**
   * `.env` files to read, relative to `cwd`; later files win, and variables set in the process
   * win over every file.
   * @default `.env` and `.env.local`, where they exist
   */
  files?: string[]
  /**
   * Inline into code for server platforms (`deno`, `node`, `neutral`) too, not only for the
   * browser.
   * @default false
   */
  server?: boolean
}

/** Toggles for the diagnostics checks. */
export interface ChecksOptions {
  /**
   * Browser safety: warn when a local or remote module of a browser bundle imports a `node:`
   * builtin (with the importer), and when an npm package resolves to a native addon (`.node`,
   * any platform; it is kept external either way).
   */
  browserSafety?: boolean
  /** Warn at the end of a build when one npm package was bundled in several versions. */
  duplicates?: boolean
  /**
   * Explain resolutions that `deno.lock` does not cover: packages missing from the lockfile
   * (`NOT_IN_LOCKFILE` instead of `CACHED_ONLY_MISS` when `cachedOnly` cannot resolve them), drift
   * that `lockfile: 'auto'` allows, and versions the minimum dependency age held back (debug
   * output, and a hint on `RESOLVE_CONSTRAINT` errors). `lockfile: 'frozen'` fails on drift
   * either way.
   */
  lockfile?: boolean
}

/** How `deno.lock` is used (see {@link Options.lockfile}). */
export type LockfileMode = 'auto' | 'frozen' | 'off'

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
   * (`'deno'`: `deno info --json` for the module graph and `deno transpile` for remote TypeScript;
   * needs Deno 2.8.3+), or `'auto'` (the loader, unless the project uses a feature the vendored
   * loader lacks — `catalog:` versions, globs in `links`, `jsrDepsInNodeModules`, a `JSR_URL`
   * naming another registry — and a usable Deno is found).
   * @default 'auto'
   */
  engine?: 'auto' | 'loader' | 'deno'
  /**
   * Deno executable used by the `deno` engine.
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
   * How `deno.lock` is used (the plugin never writes it):
   *
   * - `'auto'`: versions pinned in the lockfile are used; imports it does not cover resolve to
   *   the versions `deno install` would pick (debug output says so). Acts as `'frozen'` when the
   *   `CI` environment variable is set (not `''`, `'0'` or `'false'`) or `deno.json` sets
   *   `"lock": { "frozen": true }`, and a lockfile exists.
   * - `'frozen'`: like `deno install --frozen`: an `npm:`/`jsr:` import or remote URL that
   *   resolves to a version the lockfile does not record (or records differently) fails with
   *   `LOCKFILE_FROZEN_DRIFT`, listing the drift; run `deno install` to update the lockfile.
   * - `'off'`: `deno.lock` is ignored (the engines get `noLock`, like `deno run --no-lock`).
   * @default 'auto'
   */
  lockfile?: LockfileMode
  /**
   * Never download (like `deno run --cached-only`): remote modules, JSR packages and npm packages
   * must be in Deno's cache (`DENO_DIR`) already. A missing one fails with `CACHED_ONLY_MISS`,
   * whose hint names the import and the command that fills the cache (`deno cache <entry>` or
   * `deno install`); an `npm:`/`jsr:` import `deno.lock` does not record fails with
   * `NOT_IN_LOCKFILE` instead. Both engines behave the same: the `deno` engine points Deno's
   * HTTP proxy at a closed port for this.
   * @default false
   */
  cachedOnly?: boolean
  /**
   * Hosts that remote `https:`/`http:` modules may be imported from, like Deno's
   * `--allow-import`: `host` (any port), `host:port`, `*.domain` (the domain and its
   * subdomains), IP addresses (`[::1]:8000` for IPv6), or `'*'` for every host. A list replaces
   * the defaults; spread {@link DEFAULT_ALLOW_IMPORT} to extend them. Hosts of the remote
   * modules `deno.lock` records, of the URLs the import maps name and of the JSR registry are
   * always allowed. Checked before anything is downloaded, for the imports of remote modules and
   * their redirects too; a disallowed host fails with `DISALLOWED_HOST`.
   * @default {@link DEFAULT_ALLOW_IMPORT}, Deno 2.9's defaults (`deno.land:443`, `jsr.io:443`,
   *   `esm.sh:443`, `raw.esm.sh:443`, `cdn.jsdelivr.net:443`, `raw.githubusercontent.com:443`,
   *   `gist.githubusercontent.com:443`: HTTPS only)
   */
  allowImport?: string[]
  /**
   * The `fetch` the `loader` engine downloads with (remote modules, JSR and npm metadata and
   * tarballs), e.g. to go through a proxy, add authentication, or serve JSR from a private
   * registry. The default is `globalThis.fetch` at call time (Node.js ≥ 24 honours `HTTP_PROXY`,
   * `HTTPS_PROXY` and `NO_PROXY` with `NODE_USE_ENV_PROXY=1`; Deno and Bun always do). Without it
   * the loader also reads `NPM_CONFIG_REGISTRY`, `.npmrc` (registries, scoped registries, auth)
   * and `DENO_AUTH_TOKENS`, but not `JSR_URL` (see the README). The `deno` engine ignores it: the
   * Deno CLI downloads by itself (`HTTPS_PROXY`, `DENO_CERT`, `JSR_URL`, …).
   * @default globalThis.fetch
   */
  fetch?: typeof fetch
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
   * After a build for the Deno platform, write a `deno.json` (`{ "lock": "./deno.lock",
   * "nodeModulesDir": "none" }`) and a `deno.lock` that records the external `npm:`/`jsr:`
   * packages and their dependencies (copied from the project's lockfile, or read from Deno's
   * cache when the project has none), so `deno cache <entry>` and then
   * `deno run --frozen --cached-only <entry>` work in the output directory (Deno Deploy). `true`
   * writes them next to the first entry chunk; a string names the directory (relative to `cwd`).
   * Builds for other platforms write nothing.
   * @default false
   */
  emitDenoConfig?: boolean | string

  // Transforms

  /**
   * Support `with { type: "text" | "bytes" | "css" }` import attributes on every host (`json` is
   * left to the host).
   * @default true
   */
  importAttributes?: boolean
  /**
   * Load `.wasm` module imports (without an import attribute or a query) like Deno: the module is
   * instantiated and its exports are the importer's bindings; the Wasm's own imports resolve like
   * other imports. `false` leaves `.wasm` files to the host (Vite `?init`, `@rollup/plugin-wasm`).
   * @default true
   */
  wasm?: boolean
  /**
   * Replace `import.meta.main` with `false` in modules that are not entries of the build (Rollup,
   * Rolldown and Vite builds; esbuild only in remote modules, which it loads from the mirror).
   * @default true
   */
  importMetaMain?: boolean
  /**
   * Inline environment variables into browser bundles (see {@link EnvOptions}); `false` disables
   * it. Not on esbuild for `Deno.env.get()` reads (esbuild has no transform hook; its `define`
   * covers `process.env.X`).
   * @default false
   */
  env?: EnvOptions | false
  /**
   * What to do when a local module of a browser bundle uses a `Deno.*` global (reported once per
   * file with its first location; `'error'` fails the build). Not on esbuild (no transform hook).
   * @default 'warn' for the browser platform, otherwise 'off'
   */
  denoGlobals?: 'error' | 'warn' | 'off'
  /**
   * Who configures the JSX transform of local files: `'auto'` applies the `compilerOptions.jsx*`
   * settings of `deno.json` to the host's transform (Vite `oxc.jsx`/`esbuild.jsx*`, Rolldown
   * `transform.jsx`, Rollup `jsx`, esbuild `jsx*`) unless the host config sets JSX itself; `'host'`
   * never touches the host config. Remote modules are always transpiled by the engine.
   * @default 'auto'
   *
   * Planned: `'deno'` (transpiling local files through the engine, e.g. `jsx: "precompile"`) acts
   * like `'auto'` for now; `precompile` falls back to the automatic runtime with a warning.
   */
  jsx?: 'auto' | 'host' | 'deno'

  // Diagnostics

  /**
   * Diagnostics checks (see {@link ChecksOptions}); `true`/`false` toggles all of them.
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
  lockfile: LockfileMode
  cachedOnly: boolean
  allowImport: string[]
  /** `undefined`: `globalThis.fetch` at call time. */
  fetch: typeof fetch | undefined
  exclude: Pattern[]
  importers: { include: Pattern[]; exclude: Pattern[] }
  external: Pattern[]
  bundle: Pattern[]
  /** `null`: decided per platform by {@link pinExternalsFor}. */
  pinExternals: boolean | null
  /** `true`: next to the entry chunk; a string: that directory (absolute). */
  emitDenoConfig: boolean | string
  importAttributes: boolean
  wasm: boolean
  importMetaMain: boolean
  /** `files: null`: the default files (`.env`, `.env.local`). */
  env: { prefix: string[]; allow: string[]; files: string[] | null; server: boolean } | false
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

/**
 * Deno's default `--allow-import` hosts (Deno 2.9.7, `deno run --help`): HTTPS on the default
 * port only, so `http://deno.land/…` is not allowed by default (as in Deno).
 */
export const DEFAULT_ALLOW_IMPORT: readonly string[] = Object.freeze([
  'deno.land:443',
  'jsr.io:443',
  'esm.sh:443',
  'raw.esm.sh:443',
  'cdn.jsdelivr.net:443',
  'raw.githubusercontent.com:443',
  'gist.githubusercontent.com:443',
])

/**
 * An `allowImport` entry: `*`, a host name (optionally `*.`-prefixed), an IPv4 address or a
 * bracketed IPv6 address, with an optional port.
 */
const ALLOW_IMPORT_ENTRY =
  /^(?:\*|(?:\*\.)?[\w-]+(?:\.[\w-]+)*(?::\d{1,5})?|\[[\da-fA-F:.]+\](?::\d{1,5})?)$/

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
    allowImport: resolveAllowImport(options.allowImport),
    fetch: resolveFetch(options.fetch),
    exclude: patterns('exclude', options.exclude),
    importers: resolveImporters(options.importers),
    external: patterns('external', options.external),
    bundle: patterns('bundle', options.bundle),
    pinExternals: optionalBoolean(options, 'pinExternals') ?? null,
    emitDenoConfig: resolveEmitDenoConfig(options.emitDenoConfig, cwd),
    importAttributes: optionalBoolean(options, 'importAttributes') ?? true,
    wasm: optionalBoolean(options, 'wasm') ?? true,
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

function resolveEmitDenoConfig(value: unknown, cwd: string): boolean | string {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && value !== '') return resolve(cwd, value)
  throw invalid('emitDenoConfig', 'a boolean or a directory', value)
}

function resolveAllowImport(value: unknown): string[] {
  if (value === undefined) return [...DEFAULT_ALLOW_IMPORT]
  if (!Array.isArray(value)) throw invalid('allowImport', 'an array of host names', value)
  for (const entry of value) {
    if (typeof entry !== 'string' || !ALLOW_IMPORT_ENTRY.test(entry)) {
      throw invalid(
        'allowImport',
        "host names such as 'example.com', 'example.com:8443', '*.example.com' or '*'",
        entry,
      )
    }
  }
  return [...(value as string[])]
}

function resolveFetch(value: unknown): typeof fetch | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'function') return value as typeof fetch
  throw invalid('fetch', 'a function', value)
}

function resolveEnv(value: unknown): ResolvedOptions['env'] {
  if (value === undefined || value === false) return false
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('env', 'an object or false', value)
  }
  const env = value as Record<string, unknown>
  const prefix = env.prefix
  const prefixes =
    typeof prefix === 'string' ? [prefix] : (stringArray(env, 'prefix', 'env.prefix') ?? [])
  // An empty prefix would inline every variable of the build process, secrets included.
  if (prefixes.includes('')) throw invalid('env.prefix', 'non-empty prefixes', '')
  const allow = stringArray(env, 'allow', 'env.allow') ?? []
  if (allow.includes('')) throw invalid('env.allow', 'non-empty variable names', '')
  return {
    prefix: prefixes,
    allow,
    files: stringArray(env, 'files', 'env.files') ?? null,
    server: optionalBoolean(env, 'server', 'env.server') ?? false,
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
