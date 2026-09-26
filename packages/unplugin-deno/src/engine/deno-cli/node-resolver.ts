/**
 * Node.js module resolution for npm packages, ported from Deno's `node_resolver` 0.80.0 (the version
 * inside the vendored loader) in the configuration the loader uses: bundle mode, execution (not
 * types) resolution, and the `browser`/`node` platform conditions (docs/architecture.md §4.3).
 * `deno info` names an npm package but not the file a subpath resolves to, and it never resolves the
 * imports inside npm packages, so the `deno` engine resolves those itself.
 *
 * Deviations from Node.js that come from bundle mode: a directory import is allowed (`<dir>.js`,
 * then the directory's `package.json`/`index.js`), a missing file is retried with a `.js`
 * extension, and legacy main resolution prefers `browser` (browser platform only), then `module`,
 * then `main`. Like the loader, the object form of the `browser` field is not supported.
 *
 * @module
 */
import { readFileSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR, isSubpath, toFileUrl, toPath } from '../../utils/path.js'
import type { ResolutionMode } from '../types.js'

/**
 * Node.js builtin modules importable without the `node:` prefix: the list of Deno 2.9.7
 * (`builtinModules` of `node:module`). It is fixed here rather than read at run time because Bun's
 * list also names `ws`, `undici` and `bun:*`, which are ordinary packages elsewhere.
 */
export const BUILTIN_NODE_MODULES: ReadonlySet<string> = new Set([
  '_http_agent',
  '_http_common',
  '_http_outgoing',
  '_http_server',
  '_stream_duplex',
  '_stream_passthrough',
  '_stream_readable',
  '_stream_transform',
  '_stream_writable',
  '_tls_common',
  '_tls_wrap',
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

/** Builtins that exist only with the `node:` prefix. */
const PREFIX_ONLY_BUILTINS: ReadonlySet<string> = new Set(['sqlite', 'test', 'test/reporters'])

/** The Node.js error codes the resolver raises. */
export type NodeErrorCode =
  | 'ERR_MODULE_NOT_FOUND'
  | 'ERR_PACKAGE_PATH_NOT_EXPORTED'
  | 'ERR_PACKAGE_IMPORT_NOT_DEFINED'
  | 'ERR_INVALID_PACKAGE_TARGET'
  | 'ERR_INVALID_PACKAGE_CONFIG'
  | 'ERR_INVALID_MODULE_SPECIFIER'
  | 'ERR_UNSUPPORTED_ESM_URL_SCHEME'
  | 'ERR_UNKNOWN_BUILTIN_MODULE'

/** Details of a {@link NodeResolutionError}. */
export interface NodeResolutionErrorOptions {
  /** The file that does not exist (`ERR_MODULE_NOT_FOUND` for a file). */
  path?: string | undefined
  /** The package that could not be found (`ERR_MODULE_NOT_FOUND` for a bare specifier). */
  packageName?: string | undefined
}

/** A failed Node.js resolution, with the error code Node.js (and Deno) would report. */
export class NodeResolutionError extends Error {
  override readonly name = 'NodeResolutionError'
  readonly code: NodeErrorCode
  /** See {@link NodeResolutionErrorOptions.path}. */
  readonly path: string | undefined
  /** See {@link NodeResolutionErrorOptions.packageName}. */
  readonly packageName: string | undefined

  constructor(code: NodeErrorCode, message: string, options: NodeResolutionErrorOptions = {}) {
    super(`[${code}] ${message}`)
    this.code = code
    this.path = options.path
    this.packageName = options.packageName
  }
}

/** Whether `error` is a {@link NodeResolutionError} (optionally with the given code). */
export function isNodeResolutionError(
  error: unknown,
  code?: NodeErrorCode,
): error is NodeResolutionError {
  return error instanceof NodeResolutionError && (code === undefined || error.code === code)
}

/** What a specifier resolves to: a builtin (`node:fs`), a file, or a `data:` URL. */
export type NodeResolution =
  | { readonly kind: 'builtin'; readonly specifier: string }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }

/** The `package.json` fields the resolver and the engine read. */
export interface PackageJsonInfo {
  /** Path of the `package.json`. */
  path: string
  /** Its directory. */
  dir: string
  name: string | undefined
  version: string | undefined
  main: string | undefined
  module: string | undefined
  /** The string form of `browser` (the object form is ignored, like Deno's `deno_package_json`). */
  browser: string | undefined
  /** `exports`, normalised to a subpath map (`"./x"` or a conditions object becomes `{ ".": … }`). */
  exports: Record<string, unknown> | undefined
  imports: Record<string, unknown> | undefined
  dependencies: Readonly<Record<string, string>>
  optionalDependencies: Readonly<Record<string, string>>
  peerDependencies: Readonly<Record<string, string>>
  /** Names of peer dependencies marked `optional` in `peerDependenciesMeta`. */
  optionalPeers: ReadonlySet<string>
}

/** How the resolver finds packages and files; the engine supplies the package lookup. */
export interface NodeResolverHost {
  /**
   * The directory of package `name` for a bare import in the file `referrerPath`, or `undefined`
   * when it is not installed (or not a dependency).
   */
  packageFolder(name: string, referrerPath: string): string | undefined
}

/** Options of {@link NodeResolver}. */
export interface NodeResolverOptions {
  /** `browser` adds the `browser` condition and prefers the `browser` field. */
  platform: 'browser' | 'node'
  /** Extra conditions, added to the platform's. */
  conditions: readonly string[]
  host: NodeResolverHost
  /** Path syntax of the paths passed in (tests use both). */
  flavor?: PathFlavor | undefined
}

/** A resolved target before the existence check (`knownExists` skips it). */
type Target =
  | { readonly kind: 'builtin'; readonly specifier: string }
  | { readonly kind: 'path'; readonly path: string; readonly knownExists: boolean }

/** `(^|\|/)(.|..|node_modules)(\|/|$)`: segments an export target or subpath may not contain. */
const INVALID_SEGMENT = /(?:^|[\\/])(?:\.\.?|node_modules)(?:[\\/]|$)/

/**
 * Node.js resolution in bundle mode. One instance per engine and platform: `package.json` reads
 * are cached for its lifetime (installed packages do not change while an engine lives).
 */
export class NodeResolver {
  readonly #platform: 'browser' | 'node'
  readonly #extra: readonly string[]
  readonly #host: NodeResolverHost
  readonly #flavor: PathFlavor
  readonly #path: typeof posix
  readonly #packageJsons = new Map<string, PackageJsonInfo>()
  readonly #closest = new Map<string, PackageJsonInfo>()

  constructor(options: NodeResolverOptions) {
    this.#platform = options.platform
    this.#extra = [...options.conditions]
    this.#host = options.host
    this.#flavor = options.flavor ?? HOST_PATH_FLAVOR
    this.#path = this.#flavor === 'win32' ? win32 : posix
  }

  /**
   * The conditions for `mode`: the extra conditions, then `browser` + `import`/`require` on the
   * browser platform, `deno` + `node` + `import` (or `require` + `node`) otherwise. `default`
   * always matches.
   */
  conditions(mode: ResolutionMode): readonly string[] {
    const platform =
      this.#platform === 'browser'
        ? ['browser', mode === 'require' ? 'require' : 'import']
        : mode === 'require'
          ? ['require', 'node']
          : ['deno', 'node', 'import']
    return [...this.#extra, ...platform]
  }

  /**
   * Resolves `specifier` imported by the file `referrerPath` (Node.js `defaultResolve`): builtins,
   * `data:`/`file:`/`node:` URLs, relative and absolute paths, `#imports` of the closest
   * `package.json`, the package itself by name, and other packages through the host.
   *
   * @throws {NodeResolutionError}
   */
  resolve(specifier: string, referrerPath: string, mode: ResolutionMode): NodeResolution {
    if (BUILTIN_NODE_MODULES.has(specifier)) {
      return { kind: 'builtin', specifier: `node:${specifier}` }
    }
    const conditions = this.conditions(mode)
    const absolutePath = this.#flavor === 'win32' && /^[a-zA-Z]:[\\/]/.test(specifier)
    const scheme = absolutePath ? undefined : /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(specifier)?.[1]
    if (scheme !== undefined) {
      return this.#resolveUrl(specifier, scheme.toLowerCase(), referrerPath, conditions)
    }
    let target: Target
    if (absolutePath || isRelativeOrAbsolute(specifier)) {
      target = { kind: 'path', path: this.#join(referrerPath, specifier), knownExists: false }
    } else if (specifier.startsWith('#')) {
      target = this.#packageImportsResolve(specifier, referrerPath, conditions)
    } else {
      target = this.#packageResolve(specifier, referrerPath, conditions)
    }
    return this.#finalize(target, conditions, referrerPath)
  }

  /**
   * The file for `subpath` (`''` or `/colors`) of the package in `packageDir`, the way Deno
   * resolves an `npm:` requirement once it knows the package.
   *
   * @throws {NodeResolutionError}
   */
  resolvePackage(
    packageDir: string,
    subpath: string,
    mode: ResolutionMode,
    referrerPath?: string,
  ): string {
    const conditions = this.conditions(mode)
    const target = this.#packageDirSubpath(
      packageDir,
      subpath === '' ? '.' : `.${subpath}`,
      conditions,
    )
    const resolved = this.#finalize(target, conditions, referrerPath)
    if (resolved.kind !== 'path') {
      throw new NodeResolutionError(
        'ERR_INVALID_PACKAGE_TARGET',
        `The package in ${packageDir} maps "${subpath || '.'}" to ${resolved.kind === 'builtin' ? resolved.specifier : resolved.url}, which is not a file.`,
      )
    }
    return resolved.path
  }

  /**
   * The `package.json` in `dir`, or `undefined` when there is none. Files found are cached; misses
   * are not (with `nodeModulesDir: "manual"` the user may install a package while an engine lives).
   */
  packageJson(dir: string): PackageJsonInfo | undefined {
    const path = this.#path.join(dir, 'package.json')
    const cached = this.#packageJsons.get(path)
    if (cached !== undefined) return cached
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
    const info = parsePackageJsonInfo(text, path, this.#path.dirname(path))
    this.#packageJsons.set(path, info)
    return info
  }

  /** The `package.json` closest to `dir` (itself or an ancestor), whatever its contents. */
  closestPackageJson(dir: string): PackageJsonInfo | undefined {
    const visited: string[] = []
    let current = dir
    let found: PackageJsonInfo | undefined
    for (;;) {
      found = this.#closest.get(current)
      if (found !== undefined) break
      visited.push(current)
      found = this.packageJson(current)
      if (found !== undefined) break
      const parent = this.#path.dirname(current)
      if (parent === current) break
      current = parent
    }
    if (found !== undefined) for (const entry of visited) this.#closest.set(entry, found)
    return found
  }

  #resolveUrl(
    specifier: string,
    scheme: string,
    referrerPath: string,
    conditions: readonly string[],
  ): NodeResolution {
    switch (scheme) {
      case 'data':
        return { kind: 'url', url: specifier }
      case 'node': {
        const name = specifier.slice('node:'.length)
        if (BUILTIN_NODE_MODULES.has(name) || PREFIX_ONLY_BUILTINS.has(name)) {
          return { kind: 'builtin', specifier: `node:${name}` }
        }
        throw new NodeResolutionError(
          'ERR_UNKNOWN_BUILTIN_MODULE',
          `No such built-in module: ${specifier}`,
        )
      }
      case 'file': {
        let path: string
        try {
          path = toPath(specifier, this.#flavor)
        } catch (error) {
          throw new NodeResolutionError(
            'ERR_INVALID_MODULE_SPECIFIER',
            `Invalid file URL "${specifier}" imported from ${referrerPath}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return this.#finalize({ kind: 'path', path, knownExists: false }, conditions, referrerPath)
      }
      default:
        throw new NodeResolutionError(
          'ERR_UNSUPPORTED_ESM_URL_SCHEME',
          `Only file, data and node URLs are supported in npm packages; received "${scheme}:" in "${specifier}" imported from ${referrerPath}.`,
        )
    }
  }

  /** `referrerPath` joined with a relative or absolute specifier, with URL semantics. */
  #join(referrerPath: string, specifier: string): string {
    if (this.#flavor === 'win32' && /^[a-zA-Z]:[\\/]/.test(specifier)) {
      return this.#path.normalize(specifier)
    }
    const base = toFileUrl(referrerPath, this.#flavor)
    // Node.js accepts `.//x`; the URL parser would read `//x` as a host.
    const relative = specifier.startsWith('.//') ? `./${specifier.slice(3)}` : specifier
    const url = new URL(relative, base)
    url.search = ''
    url.hash = ''
    try {
      return toPath(url, this.#flavor)
    } catch (error) {
      throw new NodeResolutionError(
        'ERR_INVALID_MODULE_SPECIFIER',
        `Cannot resolve "${specifier}" from ${referrerPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Node.js `finalizeResolution` in bundle mode (see the module comment). */
  #finalize(
    target: Target,
    conditions: readonly string[],
    referrerPath: string | undefined,
  ): NodeResolution {
    if (target.kind === 'builtin') return target
    if (target.knownExists) return { kind: 'path', path: target.path }
    const path = target.path.replace(/[\\/]+$/, '') || target.path
    const type = fileType(path)
    if (type === 'file') return { kind: 'path', path }
    if (type === 'dir') {
      const file = withKnownExtension(path, 'js', this.#path)
      if (fileType(file) === 'file') return { kind: 'path', path: file }
      return this.#finalize(
        this.#packageDirSubpath(path, '.', conditions),
        conditions,
        referrerPath,
      )
    }
    const file = withKnownExtension(path, 'js', this.#path)
    if (fileType(file) === 'file') return { kind: 'path', path: file }
    const from = referrerPath === undefined ? '' : ` imported from ${referrerPath}`
    throw new NodeResolutionError('ERR_MODULE_NOT_FOUND', `Cannot find module "${path}"${from}.`, {
      path,
    })
  }

  /** Node.js `packageResolve`: the package itself (self-reference) or a dependency. */
  #packageResolve(specifier: string, referrerPath: string, conditions: readonly string[]): Target {
    const { name, subpath } = parsePackageName(specifier, referrerPath)
    const closest = this.closestPackageJson(this.#path.dirname(referrerPath))
    if (closest !== undefined && closest.name === name && closest.exports !== undefined) {
      return this.#exportsResolve(closest, subpath, conditions)
    }
    const dir = this.#host.packageFolder(name, referrerPath)
    if (dir === undefined) {
      throw new NodeResolutionError(
        'ERR_MODULE_NOT_FOUND',
        `Could not find package "${name}" from referrer "${referrerPath}".`,
        { packageName: name },
      )
    }
    return this.#packageDirSubpath(dir, subpath, conditions)
  }

  /** `resolve_package_dir_subpath`: `exports`, then legacy main or the subpath as a file. */
  #packageDirSubpath(dir: string, subpath: string, conditions: readonly string[]): Target {
    const pkg = this.packageJson(dir)
    if (pkg === undefined) {
      if (subpath === '.') return this.#legacyIndex(dir)
      return { kind: 'path', path: this.#path.join(dir, subpath), knownExists: false }
    }
    if (pkg.exports !== undefined) return this.#exportsResolve(pkg, subpath, conditions)
    if (subpath === '.') return this.#legacyMain(pkg)
    return { kind: 'path', path: this.#path.join(pkg.dir, subpath), knownExists: false }
  }

  /** Legacy main resolution in bundle mode: `browser` (browser platform), `module`, `main`. */
  #legacyMain(pkg: PackageJsonInfo): Target {
    const main =
      (this.#platform === 'browser' ? nonEmpty(pkg.browser) : undefined) ??
      nonEmpty(pkg.module) ??
      nonEmpty(pkg.main)
    if (main !== undefined) {
      for (const ending of ['', '.js', '/index.js']) {
        const guess = this.#path.join(pkg.dir, `${main}${ending}`)
        if (fileType(guess) === 'file') return { kind: 'path', path: guess, knownExists: true }
      }
    }
    return this.#legacyIndex(pkg.dir)
  }

  #legacyIndex(dir: string): Target {
    const index = this.#path.join(dir, 'index.js')
    if (fileType(index) === 'file') return { kind: 'path', path: index, knownExists: true }
    throw new NodeResolutionError('ERR_MODULE_NOT_FOUND', `Cannot find module "${index}".`, {
      path: index,
    })
  }

  /** Node.js `packageExportsResolve`. */
  #exportsResolve(pkg: PackageJsonInfo, subpath: string, conditions: readonly string[]): Target {
    const exports = pkg.exports ?? {}
    const notExported = (): NodeResolutionError =>
      new NodeResolutionError(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        subpath === '.'
          ? `No "exports" main defined in ${pkg.path}.`
          : `Package subpath "${subpath}" is not defined by "exports" in ${pkg.path}.`,
      )
    if (Object.hasOwn(exports, subpath) && !subpath.includes('*') && !subpath.endsWith('/')) {
      const target = this.#packageTarget(
        pkg,
        exports[subpath],
        '',
        subpath,
        false,
        false,
        conditions,
      )
      if (target === undefined) throw notExported()
      return target
    }
    const match = bestPatternMatch(Object.keys(exports), subpath, false)
    if (match !== undefined) {
      const target = this.#packageTarget(
        pkg,
        exports[match.key],
        match.subpath,
        match.key,
        true,
        false,
        conditions,
      )
      if (target === undefined) throw notExported()
      return target
    }
    throw notExported()
  }

  /** Node.js `packageImportsResolve` for `#name` specifiers. */
  #packageImportsResolve(
    name: string,
    referrerPath: string,
    conditions: readonly string[],
  ): Target {
    if (name === '#' || name.endsWith('/')) {
      throw new NodeResolutionError(
        'ERR_INVALID_MODULE_SPECIFIER',
        `"${name}" is not a valid internal imports specifier name imported from ${referrerPath}.`,
      )
    }
    const pkg = this.closestPackageJson(this.#path.dirname(referrerPath))
    const imports = pkg?.imports
    if (pkg !== undefined && imports !== undefined) {
      let target: Target | undefined
      if (Object.hasOwn(imports, name) && !name.includes('*')) {
        target = this.#packageTarget(pkg, imports[name], '', name, false, true, conditions)
      } else {
        const match = bestPatternMatch(Object.keys(imports), name, true)
        if (match !== undefined) {
          target = this.#packageTarget(
            pkg,
            imports[match.key],
            match.subpath,
            match.key,
            true,
            true,
            conditions,
          )
        }
      }
      if (target !== undefined) return target
    }
    const where = pkg === undefined ? '' : ` in package ${pkg.path}`
    throw new NodeResolutionError(
      'ERR_PACKAGE_IMPORT_NOT_DEFINED',
      `Package import specifier "${name}" is not defined${where} imported from ${referrerPath}.`,
    )
  }

  /** Node.js `resolvePackageTarget`: strings, fallback arrays and condition objects. */
  #packageTarget(
    pkg: PackageJsonInfo,
    target: unknown,
    subpath: string,
    match: string,
    pattern: boolean,
    internal: boolean,
    conditions: readonly string[],
  ): Target | undefined {
    if (typeof target === 'string') {
      return this.#packageTargetString(pkg, target, subpath, match, pattern, internal, conditions)
    }
    if (Array.isArray(target)) {
      let lastError: NodeResolutionError | undefined
      for (const item of target) {
        let resolved: Target | undefined
        try {
          resolved = this.#packageTarget(pkg, item, subpath, match, pattern, internal, conditions)
        } catch (error) {
          if (isNodeResolutionError(error, 'ERR_INVALID_PACKAGE_TARGET')) {
            lastError = error
            continue
          }
          throw error
        }
        if (resolved !== undefined) return resolved
        lastError = undefined
      }
      if (lastError !== undefined) throw lastError
      return undefined
    }
    if (typeof target === 'object' && target !== null) {
      for (const [key, value] of Object.entries(target)) {
        if (key !== 'default' && !conditions.includes(key)) continue
        const resolved = this.#packageTarget(
          pkg,
          value,
          subpath,
          match,
          pattern,
          internal,
          conditions,
        )
        if (resolved !== undefined) return resolved
      }
    }
    return undefined
  }

  /** Node.js `resolvePackageTargetString`. */
  #packageTargetString(
    pkg: PackageJsonInfo,
    target: string,
    subpath: string,
    match: string,
    pattern: boolean,
    internal: boolean,
    conditions: readonly string[],
  ): Target {
    const invalidTarget = (): NodeResolutionError =>
      new NodeResolutionError(
        'ERR_INVALID_PACKAGE_TARGET',
        `Invalid "${internal ? 'imports' : 'exports'}" target "${target}" defined for "${match}" in ${pkg.path}.`,
      )
    if (subpath !== '' && !pattern && !target.endsWith('/')) throw invalidTarget()
    if (!target.startsWith('./')) {
      if (internal && !target.startsWith('../') && !target.startsWith('/')) {
        if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target)) {
          const name = target.startsWith('node:') ? target.slice('node:'.length) : undefined
          if (
            name !== undefined &&
            (BUILTIN_NODE_MODULES.has(name) || PREFIX_ONLY_BUILTINS.has(name))
          ) {
            return { kind: 'builtin', specifier: target }
          }
          throw invalidTarget()
        }
        const request = pattern
          ? target.replace('*', () => subpath)
          : subpath === ''
            ? target
            : `${target}${subpath}`
        try {
          return this.#packageResolve(request, pkg.path, conditions)
        } catch (error) {
          if (BUILTIN_NODE_MODULES.has(target))
            return { kind: 'builtin', specifier: `node:${target}` }
          throw error
        }
      }
      throw invalidTarget()
    }
    if (INVALID_SEGMENT.test(target.slice(2))) throw invalidTarget()
    const resolved = this.#path.join(pkg.dir, target)
    if (!isSubpath(pkg.dir, resolved, this.#flavor)) throw invalidTarget()
    if (subpath === '') return { kind: 'path', path: resolved, knownExists: false }
    if (INVALID_SEGMENT.test(subpath)) {
      const request = pattern ? match.replace('*', () => subpath) : `${match}${subpath}`
      throw new NodeResolutionError(
        'ERR_INVALID_MODULE_SPECIFIER',
        `"${request}" is not a valid subpath for the "${internal ? 'imports' : 'exports'}" resolution of ${pkg.path}.`,
      )
    }
    const path = pattern
      ? this.#path.normalize(resolved.replace('*', () => subpath))
      : this.#path.join(resolved, subpath)
    return { kind: 'path', path, knownExists: false }
  }
}

/** A `package.json` parsed into {@link PackageJsonInfo}. */
function parsePackageJsonInfo(text: string, path: string, dir: string): PackageJsonInfo {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch (error) {
    throw new NodeResolutionError(
      'ERR_INVALID_PACKAGE_CONFIG',
      `Invalid package config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const raw = isRecord(value) ? value : {}
  const peersMeta = isRecord(raw.peerDependenciesMeta) ? raw.peerDependenciesMeta : {}
  return {
    path,
    dir,
    name: stringField(raw.name),
    version: stringField(raw.version),
    main: stringField(raw.main),
    module: stringField(raw.module),
    browser: stringField(raw.browser),
    exports: normalizeExports(raw.exports),
    imports: isRecord(raw.imports) ? raw.imports : undefined,
    dependencies: stringRecord(raw.dependencies),
    optionalDependencies: stringRecord(raw.optionalDependencies),
    peerDependencies: stringRecord(raw.peerDependencies),
    optionalPeers: new Set(
      Object.entries(peersMeta)
        .filter(([, meta]) => isRecord(meta) && meta.optional === true)
        .map(([name]) => name),
    ),
  }
}

/**
 * `exports` as a subpath map: a string, an array or a conditions object (keys not starting with
 * `.`) is sugar for `{ ".": exports }` (`deno_package_json`'s `is_conditional_exports_main_sugar`,
 * where the first key decides for a mixed object).
 */
export function normalizeExports(exports: unknown): Record<string, unknown> | undefined {
  if (typeof exports === 'string' || Array.isArray(exports)) return { '.': exports }
  if (!isRecord(exports)) return undefined
  const [first] = Object.keys(exports)
  if (first !== undefined && (first === '' || !first.startsWith('.'))) return { '.': exports }
  return exports
}

/** Node.js `patternKeyCompare`: `1` when `b` is the more specific pattern key. */
export function patternKeyCompare(a: string, b: string): number {
  const aStar = a.indexOf('*')
  const bStar = b.indexOf('*')
  const baseA = aStar === -1 ? a.length : aStar + 1
  const baseB = bStar === -1 ? b.length : bStar + 1
  if (baseA > baseB) return -1
  if (baseB > baseA) return 1
  if (aStar === -1) return 1
  if (bStar === -1) return -1
  if (a.length > b.length) return -1
  if (b.length > a.length) return 1
  return 0
}

/**
 * The most specific pattern key (`./*.js`) of `keys` that matches `request`, with the part `*`
 * stands for. `imports` require a non-empty match (`request` longer than the key).
 */
function bestPatternMatch(
  keys: readonly string[],
  request: string,
  imports: boolean,
): { key: string; subpath: string } | undefined {
  let best = ''
  let bestSubpath: string | undefined
  for (const key of keys) {
    const star = key.indexOf('*')
    if (star === -1 || !request.startsWith(key.slice(0, star))) continue
    const trailer = key.slice(star + 1)
    const longEnough = imports ? request.length > key.length : request.length >= key.length
    if (
      longEnough &&
      request.endsWith(trailer) &&
      patternKeyCompare(best, key) === 1 &&
      key.lastIndexOf('*') === star
    ) {
      best = key
      bestSubpath = request.slice(star, request.length - trailer.length)
    }
  }
  return bestSubpath === undefined ? undefined : { key: best, subpath: bestSubpath }
}

/**
 * Splits a bare specifier into package name and `.`-prefixed subpath (`@s/p/x` → `@s/p`, `./x`).
 *
 * @throws {NodeResolutionError} `ERR_INVALID_MODULE_SPECIFIER` for an invalid package name.
 */
export function parsePackageName(
  specifier: string,
  referrer: string,
): { name: string; subpath: string } {
  let separator = specifier.indexOf('/')
  let valid = specifier !== ''
  if (specifier.startsWith('@')) {
    if (separator === -1) valid = false
    else separator = specifier.indexOf('/', separator + 1)
  }
  const name = separator === -1 ? specifier : specifier.slice(0, separator)
  const subpath = separator === -1 ? '.' : `.${specifier.slice(separator)}`
  if (!valid || name.includes('%') || name.includes('\\')) {
    throw new NodeResolutionError(
      'ERR_INVALID_MODULE_SPECIFIER',
      `"${specifier}" is not a valid package name imported from ${referrer}.`,
    )
  }
  return { name, subpath }
}

/**
 * `path` with its extension replaced by `ext` (Deno's `with_known_extension`): known code
 * extensions (`.js`, `.json`, `.d`, `.ts`, `.d.ts`, …) are replaced, others get `ext` appended
 * (`lib` → `lib.js`, `x.min` → `x.min.js`).
 */
export function withKnownExtension(
  path: string,
  ext: string,
  syntax: typeof posix = posix,
): string {
  const base = syntax.basename(path)
  if (base === '') return path
  const lower = base.toLowerCase()
  let cut: number | undefined
  const dot = lower.lastIndexOf('.')
  if (dot !== -1) {
    const current = lower.slice(dot + 1)
    if (['cts', 'mts', 'ts'].includes(current)) {
      const previous = lower.lastIndexOf('.', dot - 1)
      cut = previous !== -1 && lower.slice(previous + 1, dot) === 'd' ? previous : dot
    } else if (['cjs', 'js', 'json', 'jsx', 'mjs', 'tsx', 'd'].includes(current)) {
      cut = dot
    }
  }
  const stem = cut === undefined ? base : base.slice(0, cut)
  return syntax.join(syntax.dirname(path), `${stem}.${ext}`)
}

/** Whether a specifier is a relative (`./`, `../`, `.`, `..`) or absolute (`/`) path. */
function isRelativeOrAbsolute(specifier: string): boolean {
  return (
    specifier.startsWith('/') ||
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  )
}

function fileType(path: string): 'file' | 'dir' | undefined {
  try {
    const stat = statSync(path)
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : undefined
  } catch {
    return undefined
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
