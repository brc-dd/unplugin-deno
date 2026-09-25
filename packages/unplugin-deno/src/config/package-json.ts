import { readFile } from 'node:fs/promises'
import { DenoPluginError } from '../diagnostics/errors.js'
import { locateJsonValue, parseJsonc } from '../utils/fs.js'
import { readError } from './deno-config.js'

/** The `package.json` fields the config layer reads. */
export interface PackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  /** npm/yarn workspaces (`["packages/*"]`, or yarn's `{ "packages": [...] }`). */
  workspaces?: string[]
  /** Raw `exports` (resolved by the host with Node rules, never here). */
  exports?: unknown
  main?: string
  /** Default catalog for `catalog:` dependencies (Deno reads it from the root `package.json`). */
  catalog?: Record<string, string>
  catalogs?: Record<string, Record<string, string>>
}

/**
 * Reads and validates a `package.json`.
 *
 * @throws {DenoPluginError} `CONFIG_NOT_FOUND` when missing, `CONFIG_INVALID` for syntax errors
 *   and invalid field types (with `file:line:column`).
 */
export async function readPackageJson(path: string): Promise<PackageJson> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw readError(path, error)
  }
  return parsePackageJson(text, path)
}

/** Parses and validates the text of a `package.json` (see {@link readPackageJson}). */
export function parsePackageJson(text: string, file: string): PackageJson {
  const value = parseJsonc(text, file)
  const fail = (path: Array<string | number>, expected: string): never => {
    const position = locateJsonValue(text, path) ?? { line: 1, column: 1 }
    const field = path.length === 0 ? 'The package.json' : `"${path.join('.')}"`
    throw new DenoPluginError(
      'CONFIG_INVALID',
      `${file}:${position.line}:${position.column}: ${field} must be ${expected}.`,
      { hint: 'Fix the package.json field or remove it.' },
    )
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail([], 'a JSON object')
  }
  const raw = value as Record<string, unknown>
  const result: PackageJson = {}
  for (const key of ['name', 'version', 'main'] as const) {
    const item = raw[key]
    if (item === undefined || item === null) continue
    if (typeof item !== 'string') fail([key], 'a string')
    result[key] = item as string
  }
  for (const key of ['dependencies', 'devDependencies', 'catalog'] as const) {
    const record = stringRecord(raw[key], [key], fail)
    if (record !== undefined) result[key] = record
  }
  const catalogs = raw.catalogs
  if (catalogs !== undefined && catalogs !== null) {
    if (typeof catalogs !== 'object' || Array.isArray(catalogs)) fail(['catalogs'], 'an object')
    result.catalogs = Object.fromEntries(
      Object.entries(catalogs as Record<string, unknown>).map(([name, entries]) => [
        name,
        stringRecord(entries, ['catalogs', name], fail) ?? {},
      ]),
    )
  }
  const workspaces = normalizeWorkspaces(raw.workspaces)
  if (workspaces === null) fail(['workspaces'], 'an array of strings or { "packages": [...] }')
  else if (workspaces !== undefined) result.workspaces = workspaces
  if (raw.exports !== undefined) result.exports = raw.exports
  return result
}

function stringRecord(
  value: unknown,
  path: string[],
  fail: (path: Array<string | number>, expected: string) => never,
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return fail(path, 'an object')
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') fail([...path, key], 'a string')
  }
  return value as Record<string, string>
}

function normalizeWorkspaces(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined
  const list: unknown = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? (value as { packages?: unknown }).packages
      : null
  if (list === undefined) return []
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) return null
  return [...(list as string[])]
}

/**
 * A `package.json` dependency value, classified like Deno's `PackageJsonDepValue`:
 * - `npm`: a version range or tag (`^1.3.0`, `latest`, `""` = `*`), or an alias
 *   (`npm:other@^1` → `name: 'other'`);
 * - `jsr`: `jsr:@scope/name@range` (Deno 2.7+);
 * - `workspace`: `workspace:*`/`workspace:^1` (a workspace member);
 * - `catalog`: `catalog:` or `catalog:<name>`;
 * - `other`: `file:`, `link:`, git and tarball URLs (not resolvable to a registry version).
 */
export type PackageJsonDependency =
  | { kind: 'npm'; name: string; range: string }
  | { kind: 'jsr'; specifier: string }
  | { kind: 'workspace'; range: string }
  | { kind: 'catalog'; catalog: string }
  | { kind: 'other'; value: string }

/** Classifies the dependency `alias: value` (see {@link PackageJsonDependency}). */
export function parseDependency(alias: string, value: string): PackageJsonDependency {
  const text = value.trim()
  if (text.startsWith('workspace:')) return { kind: 'workspace', range: text.slice(10) }
  if (text.startsWith('catalog:')) return { kind: 'catalog', catalog: text.slice(8) || 'default' }
  if (text.startsWith('jsr:')) return { kind: 'jsr', specifier: text }
  if (text.startsWith('npm:')) {
    const target = text.slice(4)
    const at = target.lastIndexOf('@')
    return at > 0
      ? { kind: 'npm', name: target.slice(0, at), range: target.slice(at + 1) || '*' }
      : { kind: 'npm', name: target, range: '*' }
  }
  if (
    /^(?:file|link|git|git\+[a-z]+|https?|github|gitlab|bitbucket):/.test(text) ||
    text.includes('/')
  ) {
    return { kind: 'other', value }
  }
  return { kind: 'npm', name: alias, range: text === '' ? '*' : text }
}

/**
 * The dependencies Deno resolves bare specifiers against (`dependencies`, then
 * `devDependencies`; the first entry for a name wins), in declaration order.
 */
export function packageJsonDependencies(pkg: PackageJson): Array<[alias: string, value: string]> {
  const seen = new Set<string>()
  const result: Array<[string, string]> = []
  for (const record of [pkg.dependencies, pkg.devDependencies]) {
    for (const [alias, value] of Object.entries(record ?? {})) {
      if (seen.has(alias)) continue
      seen.add(alias)
      result.push([alias, value])
    }
  }
  return result
}

/**
 * The catalogs of a workspace (Deno's `Workspace::new`): the root `package.json`'s `catalog`/
 * `catalogs` when it has either, otherwise the root `deno.json`'s. The default catalog is named
 * `default`.
 */
export function workspaceCatalogs(
  rootPackageJson: PackageJson | undefined,
  rootDenoCatalog:
    | { catalog?: Record<string, string>; catalogs?: Record<string, Record<string, string>> }
    | undefined,
): Map<string, Record<string, string>> {
  const source =
    rootPackageJson !== undefined &&
    (rootPackageJson.catalog !== undefined || rootPackageJson.catalogs !== undefined)
      ? rootPackageJson
      : rootDenoCatalog
  const result = new Map<string, Record<string, string>>()
  if (source?.catalog !== undefined) result.set('default', source.catalog)
  for (const [name, entries] of Object.entries(source?.catalogs ?? {})) result.set(name, entries)
  return result
}
