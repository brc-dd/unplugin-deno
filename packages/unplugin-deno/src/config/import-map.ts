import { isAbsolute } from 'node:path'
import { DenoPluginError, isDenoPluginError } from '../diagnostics/errors.js'
import { parseJsrSpecifier } from '../core/specifier.js'
import { toDirUrl, toFileUrl } from '../utils/path.js'
import { hasOpaquePath, isSpecialScheme, normalizeUrl, percentDecodeLossy } from '../utils/url.js'
import { normalizeExports, validateExports } from './deno-config.js'
import type { ConfigFolder, Discovery, ImportMapSource } from './discover.js'
import type { PackageJsonDependency } from './package-json.js'
import { packageJsonDependencies, parseDependency, workspaceCatalogs } from './package-json.js'
import type { SemVer } from './version-req.js'
import { parseSpecifierVersionReq, parseVersion, satisfies } from './version-req.js'

// Import maps as Deno 2.9 implements them (docs/architecture.md §3.2): the WICG algorithm
// (https://html.spec.whatwg.org/multipage/webappapis.html#import-maps, checked against the
// web-platform-tests data in test/data/wpt-import-maps) with the behaviour of Deno's `import_map`
// crate (https://github.com/denoland/import_map, MIT) where it differs:
// - addresses after a matched prefix are percent-decoded and appended segment by segment, skipping
//   `.`/`..` segments (`rel/a/../../x.ts` → `<rel>/a/x.ts`) unless they start with `./`, `../` or
//   `/` (then URL-joined, so `rel/../x` is rejected as backtracking);
// - inline `imports`/`scopes` of a deno.json expand `jsr:`/`npm:` package entries to subpaths
//   (`"@std/path": "jsr:@std/path@^1"` adds `"@std/path/": "jsr:/@std/path@^1/"`);
// and Deno's workspace resolver (`libs/resolver/workspace.rs` `WorkspaceResolver::resolve`):
// member and link `imports` apply as a scope for their directory, `jsr:` specifiers naming a
// member or link resolve to its files when the version matches, bare member/link names resolve
// through their `exports`, then package.json dependencies and npm workspace members.

/** One entry of a specifier map. */
export interface SpecifierMapEntry {
  /** The normalised key: an absolute URL for URL-like keys, the key itself for bare keys. */
  key: string
  /** Whether {@link SpecifierMapEntry.key} is a bare specifier (not URL-like). */
  bare: boolean
  /** The resolved address, or `null` for an invalid entry (using it is an error). */
  address: string | null
  /** The file that declared the entry. */
  source: string
}

/** A normalised specifier map, sorted by key in descending code-unit order. */
export interface SpecifierMap {
  entries: SpecifierMapEntry[]
  byKey: Map<string, SpecifierMapEntry>
}

/** A normalised scope: a URL prefix and its specifier map. */
export interface ImportMapScope {
  prefix: string
  map: SpecifierMap
}

/** A parsed import map. */
export interface ParsedImportMap {
  imports: SpecifierMap
  /** Sorted by prefix in descending code-unit order. */
  scopes: ImportMapScope[]
  /** Problems the spec reports as console warnings (invalid addresses, empty keys, …). */
  warnings: string[]
}

/** Options of {@link parseImportMap}. */
export interface ParseImportMapOptions {
  /** Apply Deno's `jsr:`/`npm:` package expansion (inline deno.json maps). Default `false`. */
  expand?: boolean
  /** The file the map comes from, for messages. Default: the base URL. */
  source?: string
}

/**
 * Parses and normalises an import map (spec: "parse an import map string", "sort and normalize a
 * specifier map", "sort and normalize scopes"; Deno's `parse_from_value`).
 *
 * @throws {DenoPluginError} `IMPORT_MAP_INVALID` when the map, `imports`, `scopes` or a scope's
 *   value is not a JSON object.
 */
export function parseImportMap(
  value: unknown,
  baseUrl: string,
  options: ParseImportMapOptions = {},
): ParsedImportMap {
  const source = options.source ?? baseUrl
  const input = options.expand === true ? expandImportMapValue(value) : value
  if (!isPlainObject(input)) throw invalidMap(source, 'An import map must be a JSON object')
  const warnings: string[] = []
  for (const key of Object.keys(input)) {
    if (key !== 'imports' && key !== 'scopes') {
      warnings.push(`Invalid top-level key "${key}"; only "imports" and "scopes" can be present.`)
    }
  }
  const { imports, scopes } = input
  if (imports !== undefined && !isPlainObject(imports)) {
    throw invalidMap(source, 'The import map\'s "imports" must be an object')
  }
  if (scopes !== undefined && !isPlainObject(scopes)) {
    throw invalidMap(source, 'The import map\'s "scopes" must be an object')
  }
  const result: ParsedImportMap = {
    imports: parseSpecifierMap(imports ?? {}, baseUrl, source, warnings),
    scopes: [],
    warnings,
  }
  for (const [prefix, map] of Object.entries(scopes ?? {})) {
    if (!isPlainObject(map)) {
      throw invalidMap(source, `The value of the scope "${prefix}" must be an object`)
    }
    const normalized = parseUrl(prefix, baseUrl)
    if (normalized === null) {
      warnings.push(`Invalid scope "${prefix}" (parsed against base URL "${baseUrl}").`)
      continue
    }
    const key = canonicalUrl(normalized)
    result.scopes = result.scopes.filter((scope) => scope.prefix !== key)
    result.scopes.push({ prefix: key, map: parseSpecifierMap(map, baseUrl, source, warnings) })
  }
  result.scopes = result.scopes.toSorted((a, b) => compareDescending(a.prefix, b.prefix))
  return result
}

function invalidMap(source: string, message: string): DenoPluginError {
  return new DenoPluginError('IMPORT_MAP_INVALID', `${message} (${source}).`, {
    hint: 'See https://docs.deno.com/runtime/fundamentals/modules/#import-maps.',
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareDescending(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0
}

function parseSpecifierMap(
  raw: Record<string, unknown>,
  baseUrl: string,
  source: string,
  warnings: string[],
): SpecifierMap {
  const byKey = new Map<string, SpecifierMapEntry>()
  for (const [rawKey, value] of Object.entries(raw)) {
    if (rawKey === '') {
      warnings.push('Invalid empty string specifier.')
      continue
    }
    const keyUrl = parseUrlLike(rawKey, baseUrl)
    const key = keyUrl === null ? rawKey : canonicalUrl(keyUrl)
    byKey.set(key, {
      key,
      bare: keyUrl === null,
      address: parseAddress(rawKey, value, baseUrl, warnings),
      source,
    })
  }
  return sortedMap(byKey)
}

function sortedMap(byKey: Map<string, SpecifierMapEntry>): SpecifierMap {
  const entries = [...byKey.values()].toSorted((a, b) => compareDescending(a.key, b.key))
  return { entries, byKey }
}

function parseAddress(
  key: string,
  value: unknown,
  baseUrl: string,
  warnings: string[],
): string | null {
  if (typeof value !== 'string') {
    warnings.push(
      `Invalid address ${JSON.stringify(value) ?? String(value)} for the specifier key "${key}"; addresses must be strings.`,
    )
    return null
  }
  const url = parseUrlLike(value, baseUrl)
  if (url === null) {
    warnings.push(`Invalid address "${value}" for the specifier key "${key}".`)
    return null
  }
  const address = canonicalUrl(url)
  if (key.endsWith('/') && !address.endsWith('/')) {
    warnings.push(
      `Invalid target address "${address}" for package specifier "${key}"; package address targets must end with "/".`,
    )
    return null
  }
  return address
}

/**
 * The spec's "resolve a URL-like module specifier" (Deno's `try_url_like_specifier`): `/`, `./`
 * and `../` specifiers are resolved against `baseUrl`, anything else must be an absolute URL.
 */
function parseUrlLike(specifier: string, baseUrl: string): URL | null {
  if (specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../')) {
    const url = parseUrl(specifier, baseUrl)
    if (url !== null) return url
  }
  return parseUrl(specifier)
}

function parseUrl(input: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(input) : new URL(input, base)
  } catch {
    return null
  }
}

/** Serialises a URL like Deno (`^` kept unencoded, Windows drive letters upper-cased). */
function canonicalUrl(url: URL): string {
  return normalizeUrl(url) ?? url.href
}

/**
 * Deno's `expand_import_map_value`: for every `imports` (and scope) entry whose key has no
 * trailing slash and whose value is a `jsr:`/`npm:` specifier without one, adds
 * `"<key>/": "jsr:/<value>/"` unless that key exists. The `jsr:/` form keeps the value
 * hierarchical so subpaths can be appended (`jsr:@std/fmt@^1/` could not be a base URL).
 */
export function expandImportMapValue(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  const result: Record<string, unknown> = { ...value }
  if (isPlainObject(value.imports)) result.imports = expandImports(value.imports)
  if (isPlainObject(value.scopes)) {
    result.scopes = Object.fromEntries(
      Object.entries(value.scopes).map(([key, map]) => [
        key,
        isPlainObject(map) ? expandImports(map) : map,
      ]),
    )
  }
  return result
}

function expandImports(imports: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(imports)) {
    result[key] = value
    if (key.endsWith('/') || Object.hasOwn(imports, `${key}/`) || typeof value !== 'string')
      continue
    if (value.endsWith('/')) continue
    const scheme = value.startsWith('jsr:') ? 'jsr:' : value.startsWith('npm:') ? 'npm:' : null
    if (scheme === null) continue
    const rest = value.slice(4).replace(/^\//, '')
    result[`${key}/`] = `${scheme}/${rest}/`
  }
  return result
}

/** The normalised form of a parsed import map, as in the WPT `expectedParsedImportMap` data. */
export function serializeImportMap(map: ParsedImportMap): {
  imports: Record<string, string | null>
  scopes: Record<string, Record<string, string | null>>
} {
  return {
    imports: serializeSpecifierMap(map.imports),
    scopes: Object.fromEntries(
      map.scopes.map((scope) => [scope.prefix, serializeSpecifierMap(scope.map)]),
    ),
  }
}

function serializeSpecifierMap(specifierMap: SpecifierMap): Record<string, string | null> {
  return Object.fromEntries(specifierMap.entries.map((entry) => [entry.key, entry.address]))
}

/** The result of {@link resolveImportMap}. */
export interface ImportMapResolution {
  /** The resolved URL. */
  url: string
  /** The entry that matched, or `null` when a URL-like specifier was not remapped. */
  entry: SpecifierMapEntry | null
  /** The scope prefix whose map matched, or `null` for top-level `imports`. */
  scope: string | null
}

/**
 * Resolves `specifier` from `referrer` with `map` (spec: "resolve a module specifier"; Deno's
 * `ImportMap::resolve`). Scopes are tried from the most specific prefix, falling back to less
 * specific scopes and then top-level `imports`.
 *
 * @throws {DenoPluginError} `IMPORT_MAP_INVALID` when the matching entry is invalid (`null`),
 *   the remainder after a prefix cannot be resolved against its address, or it backtracks above
 *   it; `RESOLVE_UNMAPPED_BARE` for a bare specifier no entry maps.
 */
export function resolveImportMap(
  map: ParsedImportMap,
  specifier: string,
  referrer: string,
): ImportMapResolution {
  const base = normalizeUrl(referrer) ?? referrer
  const asUrl = parseUrlLike(specifier, base)
  const normalized = asUrl === null ? specifier : canonicalUrl(asUrl)
  const exact = map.scopes.find((scope) => scope.prefix === base)
  const candidates = [
    ...(exact === undefined ? [] : [exact]),
    ...map.scopes.filter(
      (scope) =>
        scope.prefix !== base && scope.prefix.endsWith('/') && base.startsWith(scope.prefix),
    ),
  ]
  for (const scope of candidates) {
    const match = resolveImportsMatch(scope.map, normalized, asUrl, specifier)
    if (match !== null) return { url: match.url, entry: match.entry, scope: scope.prefix }
  }
  const match = resolveImportsMatch(map.imports, normalized, asUrl, specifier)
  if (match !== null) return { url: match.url, entry: match.entry, scope: null }
  if (asUrl !== null) return { url: normalized, entry: null, scope: null }
  throw new DenoPluginError(
    'RESOLVE_UNMAPPED_BARE',
    `Import "${specifier}" is not a dependency and not in the import map.`,
    { specifier, importer: referrer, hint: `Add "${specifier}" to "imports" in deno.json.` },
  )
}

function resolveImportsMatch(
  specifierMap: SpecifierMap,
  normalized: string,
  asUrl: URL | null,
  specifier: string,
): { url: string; entry: SpecifierMapEntry } | null {
  const exact = specifierMap.byKey.get(normalized)
  if (exact !== undefined) {
    if (exact.address === null) throw blocked(exact, specifier)
    return { url: exact.address, entry: exact }
  }
  for (const entry of specifierMap.entries) {
    if (!entry.key.endsWith('/') || !normalized.startsWith(entry.key)) continue
    if (asUrl !== null && !isSpecialScheme(asUrl.protocol)) continue
    if (entry.address === null) throw blocked(entry, specifier)
    const afterPrefix = normalized.slice(entry.key.length)
    const url = appendSpecifierToBase(entry.address, afterPrefix)
    if (url === null) {
      throw new DenoPluginError(
        'IMPORT_MAP_INVALID',
        `Cannot resolve "${specifier}": "${afterPrefix}" cannot be resolved against "${entry.address}", the target of "${entry.key}" in ${entry.source}.`,
        {
          specifier,
          hint: /^(?:jsr|npm):[^/]/.test(entry.address)
            ? `Write the target as "${entry.address.slice(0, 4)}/${entry.address.slice(4)}" so subpaths can be appended.`
            : `Make the target of "${entry.key}" a hierarchical URL ending in "/".`,
        },
      )
    }
    if (!url.startsWith(entry.address)) {
      throw new DenoPluginError(
        'IMPORT_MAP_INVALID',
        `The specifier "${specifier}" backtracks above its prefix "${entry.key}" (${entry.source}).`,
        { specifier, hint: `Import files below "${entry.key}" only.` },
      )
    }
    return { url, entry }
  }
  return null
}

function blocked(entry: SpecifierMapEntry, specifier: string): DenoPluginError {
  return new DenoPluginError(
    'IMPORT_MAP_INVALID',
    `The import map entry "${entry.key}" in ${entry.source} has an invalid target, so "${specifier}" cannot be resolved.`,
    { specifier, hint: 'Fix the entry: targets must be URLs or ./, ../ or / paths.' },
  )
}

/**
 * Deno's `append_specifier_to_base`: the remainder is percent-decoded; unless it starts with
 * `./`, `../` or `/` it is appended to a hierarchical base segment by segment (dropping `.` and
 * `..`), otherwise it is URL-joined. Returns `null` when it cannot be resolved (opaque base).
 */
function appendSpecifierToBase(base: string, afterPrefix: string): string | null {
  const decoded = percentDecodeLossy(afterPrefix)
  const baseUrl = new URL(base)
  const relative = decoded.startsWith('../') || decoded.startsWith('./') || decoded.startsWith('/')
  if (relative || hasOpaquePath(baseUrl)) {
    const joined = parseUrl(decoded, base)
    return joined === null ? null : canonicalUrl(joined)
  }
  const cut = decoded.search(/[?#]/)
  const pathPart = cut === -1 ? decoded : decoded.slice(0, cut)
  const special = isSpecialScheme(baseUrl.protocol)
  let path = baseUrl.pathname.endsWith('/') ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname
  for (const segment of pathPart.split('/')) {
    if (segment === '.' || segment === '..') continue
    path += `/${encodePathSegment(segment, special)}`
  }
  const url = new URL(baseUrl.href)
  url.pathname = path
  const joined = cut === -1 ? url : parseUrl(decoded.slice(cut), url.href)
  return joined === null ? null : canonicalUrl(joined)
}

/**
 * Percent-encodes a path segment like the `url` crate's `PathSegmentsMut::extend`: the WHATWG
 * path set plus `/` and `%` (and `\` for special schemes); non-ASCII as UTF-8.
 */
function encodePathSegment(segment: string, special: boolean): string {
  let result = ''
  for (const char of segment) {
    const code = char.codePointAt(0) ?? 0
    const encode =
      code <= 0x20 || code >= 0x7f || '"#<>?`{}/%'.includes(char) || (special && char === '\\')
    result += encode ? encodeUtf8(char) : char
  }
  return result
}

function encodeUtf8(char: string): string {
  return [...new TextEncoder().encode(char)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('')
}

// ---------------------------------------------------------------------------------------------
// Workspace import maps

/** How a specifier was mapped by {@link ImportMapResolver.resolve}. */
export interface ImportMapMatch {
  /**
   * The mapped specifier: an absolute URL (`file:`, `https:`, `data:`, …) or a `jsr:`/`npm:`
   * specifier (the `jsr:/`/`npm:/` import-map form is normalised to `jsr:`/`npm:`). For an npm
   * workspace member (package.json `name`) it is the member directory URL plus the subpath, and
   * {@link ImportMapMatch.packageName}/{@link ImportMapMatch.subpath} are set so the caller can
   * resolve the package entry with Node rules.
   */
  mapped: string
  /**
   * - `import-map`: an `imports`/`scopes` entry (root, or a member's or link's `imports`);
   * - `workspace-member`: a workspace member's export or npm package;
   * - `link`: a linked package's export;
   * - `package-json-dependency`: a `package.json` dependency (the host resolves it from
   *   `node_modules`; `mapped` is the equivalent `npm:`/`jsr:` specifier, for pinning).
   */
  kind: 'import-map' | 'workspace-member' | 'link' | 'package-json-dependency'
  /** The scope prefix whose entry matched (member and link maps are scopes of their directory). */
  scope?: string
  /** The import-map key, package name or dependency name that matched. */
  key: string
  /** The file that provided the mapping (deno.json, import map file or package.json). */
  configPath: string
  /** For package.json-based matches: the package name. */
  packageName?: string
  /** For package.json-based matches: `''` or the subpath with its leading slash. */
  subpath?: string
}

/** Resolves bare (and URL) specifiers with a workspace's import maps. */
export interface ImportMapResolver {
  /**
   * Maps `specifier` as imported from `referrerUrl` (default: the workspace root). Returns `null`
   * when nothing maps it (relative and absolute URLs that no entry remaps, unknown bare names).
   *
   * @throws {DenoPluginError} `IMPORT_MAP_INVALID` for an invalid entry or a backtracking
   *   subpath, `RESOLVE_NOT_EXPORTED` for a missing workspace member export.
   */
  resolve(specifier: string, referrerUrl?: string): ImportMapMatch | null
  /**
   * The bare names the import maps and workspace packages claim (keys without a trailing `/`,
   * member and link package names), sorted; feeds the `resolveId` filter (§5.2).
   */
  ownedKeys(): string[]
  /** The combined import map: root `imports`/`scopes` plus one scope per member and link. */
  readonly map: ParsedImportMap
  /** Import-map problems Deno reports as warnings. */
  readonly warnings: string[]
}

/** What {@link createImportMapResolver} needs from a discovery or project. */
export type ImportMapInput = Pick<
  Discovery,
  'rootFolder' | 'members' | 'links' | 'workspaceRootUrl'
>

interface WorkspaceJsrPackage {
  name: string
  version: SemVer | null
  dirUrl: string
  exports: Record<string, string>
  configPath: string
  isLink: boolean
}

interface PackageJsonFolder {
  dirUrl: string
  path: string
  name: string | undefined
  dependencies: Array<[string, string]>
}

/**
 * Builds the import-map resolver of a workspace (docs/architecture.md §3.2), mirroring Deno 2.9's
 * `WorkspaceResolver`: the root import map (inline, or its external `importMap` file) plus each
 * member's and link's `imports` as a scope for its directory; member and link `scopes` are
 * ignored, as Deno does.
 *
 * @throws {DenoPluginError} `IMPORT_MAP_INVALID` for invalid maps or unknown `catalog:` entries.
 */
export function createImportMapResolver(project: ImportMapInput): ImportMapResolver {
  const { rootFolder } = project
  const catalogs = workspaceCatalogs(rootFolder?.packageJson?.json, rootFolder?.denoJson?.config)
  const rootSource = rootFolder?.denoJson?.importMap ?? null
  const map =
    rootSource === null
      ? { imports: sortedMap(new Map()), scopes: [], warnings: [] }
      : parseSource(rootSource, catalogs, false)
  const children = [...project.members, ...project.links]
  for (const folder of children) {
    const source = folder.denoJson?.importMap
    if (source === undefined || source === null) continue
    const child = parseSource(source, catalogs, true)
    map.warnings.push(...child.warnings)
    addScope(map, folder.dirUrl, child.imports)
  }
  map.scopes = map.scopes.toSorted((a, b) => compareDescending(a.prefix, b.prefix))
  const packages = jsrPackages(rootFolder, project.members, project.links, map.warnings)
  const packageJsonFolders = [rootFolder, ...project.members]
    .filter((folder): folder is ConfigFolder => folder !== null && folder.packageJson !== null)
    .map(toPackageJsonFolder)
    .toSorted((a, b) => (a.dirUrl < b.dirUrl ? -1 : a.dirUrl > b.dirUrl ? 1 : 0))
  const aliases = realPathAliases([rootFolder, ...children])
  const rootUrl = project.workspaceRootUrl
  const context: ResolveContext = { map, packages, packageJsonFolders, catalogs, rootUrl }
  return {
    map,
    warnings: map.warnings,
    resolve(specifier, referrerUrl) {
      const referrer = applyAliases(normalizeReferrer(referrerUrl, rootUrl), aliases)
      return resolveInWorkspace(context, specifier, referrer)
    },
    ownedKeys() {
      const keys = new Set<string>()
      for (const specifierMap of [map.imports, ...map.scopes.map((scope) => scope.map)]) {
        for (const entry of specifierMap.entries) {
          if (!entry.bare) continue
          const key = entry.key.endsWith('/') ? entry.key.slice(0, -1) : entry.key
          if (key !== '') keys.add(key)
        }
      }
      for (const pkg of packages) keys.add(pkg.name)
      for (const folder of packageJsonFolders) if (folder.name !== undefined) keys.add(folder.name)
      return [...keys].toSorted()
    },
  }
}

function parseSource(
  source: ImportMapSource,
  catalogs: Map<string, Record<string, string>>,
  importsOnly: boolean,
): ParsedImportMap {
  let value = source.value
  if (importsOnly)
    value = isPlainObject(value) && value.imports !== undefined ? { imports: value.imports } : {}
  if (source.inline) value = expandCatalogs(expandImportMapValue(value), catalogs, source.path)
  return parseImportMap(value, source.baseUrl, { source: source.path })
}

/**
 * Deno's `expand_catalog_specifiers` (inline maps only): `"x": "catalog:"` becomes
 * `"x": "npm:x@<range>"` plus `"x/": "npm:/x@<range>/"`, looked up in the workspace catalogs.
 */
function expandCatalogs(
  value: unknown,
  catalogs: Map<string, Record<string, string>>,
  source: string,
): unknown {
  if (!isPlainObject(value)) return value
  const expand = (map: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(map)) {
      if (typeof entry !== 'string' || !entry.startsWith('catalog:')) {
        result[key] = entry
        continue
      }
      const catalogName = entry.slice(8) || 'default'
      const name = key.endsWith('/') ? key.slice(0, -1) : key
      const range = catalogs.get(catalogName)?.[name]
      if (range === undefined) {
        throw new DenoPluginError(
          'IMPORT_MAP_INVALID',
          `The package "${name}" is not in the "${catalogName}" catalog (${source}).`,
          { hint: 'Add it to "catalog"/"catalogs" in the workspace root config.' },
        )
      }
      if (key.endsWith('/')) {
        result[key] = `npm:/${name}@${range}/`
        continue
      }
      result[key] = `npm:${name}@${range}`
      if (!Object.hasOwn(map, `${key}/`)) result[`${key}/`] = `npm:/${name}@${range}/`
    }
    return result
  }
  const result: Record<string, unknown> = { ...value }
  if (isPlainObject(value.imports)) result.imports = expand(value.imports)
  if (isPlainObject(value.scopes)) {
    result.scopes = Object.fromEntries(
      Object.entries(value.scopes).map(([key, map]) => [
        key,
        isPlainObject(map) ? expand(map) : map,
      ]),
    )
  }
  return result
}

/** Adds `imports` as the scope `prefix`, merging with an existing scope (the new entries win). */
function addScope(map: ParsedImportMap, prefix: string, imports: SpecifierMap): void {
  const key = normalizeUrl(prefix) ?? prefix
  const existing = map.scopes.find((scope) => scope.prefix === key)
  if (existing === undefined) {
    map.scopes.push({ prefix: key, map: imports })
    return
  }
  const merged = new Map(existing.map.byKey)
  for (const [entryKey, entry] of imports.byKey) merged.set(entryKey, entry)
  existing.map = sortedMap(merged)
}

function jsrPackages(
  rootFolder: ConfigFolder | null,
  members: ConfigFolder[],
  links: ConfigFolder[],
  warnings: string[],
): WorkspaceJsrPackage[] {
  const result: WorkspaceJsrPackage[] = []
  const add = (folder: ConfigFolder | null, isLink: boolean): void => {
    const denoJson = folder?.denoJson
    if (folder === null || denoJson === null || denoJson === undefined) return
    const { name, version, exports } = denoJson.config
    if (name === undefined) return
    const problem = validateExports(exports)
    if (problem !== undefined) {
      warnings.push(`Ignoring the package "${name}" in ${denoJson.path}: ${problem}.`)
      return
    }
    result.push({
      name,
      version: version === undefined ? null : parseVersion(version),
      dirUrl: normalizeUrl(folder.dirUrl) ?? folder.dirUrl,
      exports: normalizeExports(exports),
      configPath: denoJson.path,
      isLink,
    })
  }
  add(rootFolder, false)
  for (const member of members) add(member, false)
  for (const link of links) add(link, true)
  return result
}

function toPackageJsonFolder(folder: ConfigFolder): PackageJsonFolder {
  const packageJson = folder.packageJson
  if (packageJson === null) throw new TypeError('expected a package.json folder')
  return {
    dirUrl: normalizeUrl(folder.dirUrl) ?? folder.dirUrl,
    path: packageJson.path,
    name: packageJson.json.name,
    dependencies: packageJsonDependencies(packageJson.json),
  }
}

/** Real-path → discovered-path URL prefixes, longest first, for symlinked folders. */
function realPathAliases(folders: Array<ConfigFolder | null>): Array<[string, string]> {
  const aliases = new Map<string, string>()
  for (const folder of folders) {
    if (folder === null || folder.realDir === folder.dir) continue
    const real = normalizeUrl(toDirUrl(folder.realDir))
    const discovered = normalizeUrl(folder.dirUrl)
    if (real !== undefined && discovered !== undefined) aliases.set(real, discovered)
  }
  return [...aliases].toSorted((a, b) => b[0].length - a[0].length)
}

function applyAliases(referrer: string, aliases: Array<[string, string]>): string {
  for (const [real, discovered] of aliases) {
    if (referrer.startsWith(real)) return discovered + referrer.slice(real.length)
  }
  return referrer
}

function normalizeReferrer(referrer: string | undefined, rootUrl: string): string {
  if (referrer === undefined) return normalizeUrl(rootUrl) ?? rootUrl
  if (isAbsolute(referrer) && !/^[a-zA-Z][a-zA-Z\d+\-.]+:/.test(referrer)) {
    return normalizeUrl(toFileUrl(referrer)) ?? referrer
  }
  return normalizeUrl(referrer) ?? normalizeUrl(rootUrl) ?? rootUrl
}

interface ResolveContext {
  map: ParsedImportMap
  packages: WorkspaceJsrPackage[]
  packageJsonFolders: PackageJsonFolder[]
  catalogs: Map<string, Record<string, string>>
  rootUrl: string
}

function resolveInWorkspace(
  context: ResolveContext,
  specifier: string,
  referrer: string,
): ImportMapMatch | null {
  let resolution: ImportMapResolution
  try {
    resolution = resolveImportMap(context.map, specifier, referrer)
  } catch (error) {
    if (isDenoPluginError(error) && error.code === 'RESOLVE_UNMAPPED_BARE') {
      return resolveUnmappedBare(context, specifier, referrer)
    }
    if (isDenoPluginError(error) && error.importer === undefined) {
      throw new DenoPluginError(error.code, error.message, {
        hint: error.hint,
        specifier,
        importer: referrer,
        cause: error.cause,
      })
    }
    throw error
  }
  const { url, entry, scope } = resolution
  const member = resolveJsrToPackage(context, url)
  if (member !== null) {
    return entry === null
      ? member
      : { ...member, key: entry.key, ...(scope === null ? {} : { scope }) }
  }
  if (entry === null) return null
  return {
    mapped: normalizeMapped(url),
    kind: 'import-map',
    ...(scope === null ? {} : { scope }),
    key: entry.key,
    configPath: entry.source,
  }
}

/** `jsr:/@std/path@^1/join` → `jsr:@std/path@^1/join` (and the same for `npm:/`). */
function normalizeMapped(url: string): string {
  return /^(?:jsr|npm):\//.test(url) ? `${url.slice(0, 4)}${url.slice(5)}` : url
}

/**
 * A `jsr:` URL naming a workspace member or link resolves to its files when the member has no
 * version or the version satisfies the range (Deno's `maybe_resolve_specifier_to_workspace_jsr_pkg`).
 */
function resolveJsrToPackage(context: ResolveContext, url: string): ImportMapMatch | null {
  if (!url.startsWith('jsr:')) return null
  const parsed = parseJsrSpecifier(url)
  if (parsed === null) return null
  for (const pkg of context.packages) {
    if (pkg.name !== parsed.name) continue
    if (pkg.version !== null) {
      const req = parseSpecifierVersionReq(parsed.range ?? '*')
      if (req === null || !satisfies(pkg.version, req)) continue
    }
    return packageMatch(pkg, parsed.subpath, pkg.name)
  }
  return null
}

function packageMatch(pkg: WorkspaceJsrPackage, subpath: string, key: string): ImportMapMatch {
  const exportName = normalizeExportName(subpath)
  const target = pkg.exports[exportName]
  if (target === undefined) {
    const known = Object.keys(pkg.exports)
    throw new DenoPluginError(
      'RESOLVE_NOT_EXPORTED',
      `Unknown export "${exportName}" for "${pkg.name}" (${pkg.configPath}).`,
      {
        specifier: `${pkg.name}${subpath}`,
        hint:
          known.length === 0
            ? `Add "exports" to ${pkg.configPath}.`
            : `Exports: ${known.join(', ')}.`,
      },
    )
  }
  return {
    mapped: canonicalUrl(new URL(target, pkg.dirUrl)),
    kind: pkg.isLink ? 'link' : 'workspace-member',
    key,
    configPath: pkg.configPath,
  }
}

/** `deno_semver`'s `normalized_export_name`: `''`, `/` and `.` → `.`; `/x/` → `./x`. */
function normalizeExportName(subpath: string): string {
  if (subpath === '' || subpath === '/' || subpath === '.') return '.'
  const trimmed = subpath.endsWith('/') ? subpath.slice(0, -1) : subpath
  return trimmed.startsWith('./') ? trimmed : `./${trimmed.replace(/^\//, '')}`
}

function matchesPackageName(specifier: string, name: string): string | null {
  if (specifier === name) return ''
  return specifier.startsWith(`${name}/`) ? specifier.slice(name.length) : null
}

/**
 * Bare specifiers the import map does not map (Deno's `WorkspaceResolver::resolve` steps 2–4):
 * member and link names (members first), `package.json` dependencies of the referrer's
 * package.json folders (nearest first; Deno 2.9.7 stops early for some sibling folders, a bug
 * not replicated), then npm workspace members by `name` for referrers inside the workspace.
 */
function resolveUnmappedBare(
  context: ResolveContext,
  specifier: string,
  referrer: string,
): ImportMapMatch | null {
  for (const pkg of context.packages) {
    const subpath = matchesPackageName(specifier, pkg.name)
    if (subpath !== null) return packageMatch(pkg, subpath, pkg.name)
  }
  if (specifier.startsWith('#')) return null
  const folders = context.packageJsonFolders
    .filter((folder) => referrer.startsWith(folder.dirUrl))
    .toSorted((a, b) => b.dirUrl.length - a.dirUrl.length)
  for (const folder of folders) {
    for (const [alias, value] of folder.dependencies) {
      const subpath = matchesPackageName(specifier, alias)
      if (subpath === null) continue
      const dependency = parseDependency(alias, value)
      if (dependency.kind === 'workspace') {
        const member = npmMember(context, alias, subpath)
        if (member !== null) return member
      }
      return {
        mapped: `${dependencySpecifier(dependency, alias, context.catalogs)}${subpath}`,
        kind: 'package-json-dependency',
        key: alias,
        configPath: folder.path,
        packageName: dependency.kind === 'npm' ? dependency.name : alias,
        subpath,
      }
    }
  }
  if (!referrer.startsWith(normalizeUrl(context.rootUrl) ?? context.rootUrl)) return null
  for (const folder of context.packageJsonFolders) {
    if (folder.name === undefined) continue
    const subpath = matchesPackageName(specifier, folder.name)
    if (subpath !== null) return npmMember(context, folder.name, subpath)
  }
  return null
}

function npmMember(context: ResolveContext, name: string, subpath: string): ImportMapMatch | null {
  const folder = context.packageJsonFolders.find((candidate) => candidate.name === name)
  if (folder === undefined) return null
  return {
    mapped: subpath === '' ? folder.dirUrl : canonicalUrl(new URL(subpath.slice(1), folder.dirUrl)),
    kind: 'workspace-member',
    key: name,
    configPath: folder.path,
    packageName: name,
    subpath,
  }
}

/** The `npm:`/`jsr:` specifier equivalent to a package.json dependency (without subpath). */
function dependencySpecifier(
  dependency: PackageJsonDependency,
  alias: string,
  catalogs: Map<string, Record<string, string>>,
): string {
  switch (dependency.kind) {
    case 'npm':
      return `npm:${dependency.name}@${dependency.range}`
    case 'jsr':
      return dependency.specifier
    case 'catalog': {
      const range = catalogs.get(dependency.catalog)?.[alias]
      return range === undefined ? `catalog:${dependency.catalog}` : `npm:${alias}@${range}`
    }
    case 'workspace':
      return `npm:${alias}@${dependency.range === '' ? '*' : dependency.range}`
    case 'other':
      return dependency.value
  }
}
