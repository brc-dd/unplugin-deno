import { readFile } from 'node:fs/promises'
import { DenoPluginError } from '../diagnostics/errors.js'
import { parseJsrSpecifier, parseNpmSpecifier } from '../core/specifier.js'
import { parseJsonc } from '../utils/fs.js'
import { normalizeVersionReq, parseSpecifierVersionReq } from './version-req.js'

/** A `jsr` entry of `deno.lock` (key: `@scope/name@version`). */
export interface JsrLockEntry {
  /** sha256 hex of the package's version metadata. */
  integrity: string | undefined
  /** `jsr:`/`npm:` requirements, e.g. `jsr:@std/internal`. */
  dependencies: string[]
}

/** An `npm` entry of `deno.lock` (key: `name@version`, plus `_peer@version` suffixes). */
export interface NpmLockEntry {
  /** Subresource integrity of the tarball (`sha512-…`). */
  integrity: string | undefined
  /** Dependency names (or `name@version` when ambiguous), resolved within the lockfile. */
  dependencies: string[]
  optionalDependencies: string[]
  optionalPeers: string[]
  /** Tarball URL for non-npmjs registries (e.g. `https://npm.jsr.io/~/11/@jsr/std__fmt/1.0.10.tgz`). */
  tarball: string | undefined
}

/** Dependencies recorded for the workspace root or a member. */
export interface LockfileWorkspaceDependencies {
  /** From deno.json `imports` (normalised requirements, e.g. `jsr:@std/path@1`). */
  dependencies: string[]
  /** From package.json. */
  packageJsonDependencies: string[]
}

/** A parsed `deno.lock` version 5. */
export interface Lockfile {
  path: string
  version: '5'
  unsupported: false
  /** Normalised requirement → resolved version, e.g. `jsr:@std/path@1` → `1.1.6`. */
  specifiers: Readonly<Record<string, string>>
  jsr: Readonly<Record<string, JsrLockEntry>>
  npm: Readonly<Record<string, NpmLockEntry>>
  /** Remote URL → sha256 hex of its content. */
  remote: Readonly<Record<string, string>>
  /** Redirected URL → target URL. */
  redirects: Readonly<Record<string, string>>
  workspace: LockfileWorkspaceDependencies & {
    /** Keyed by member directory relative to the workspace root (`packages/ui`). */
    members: Readonly<Record<string, LockfileWorkspaceDependencies>>
  }
  /**
   * The exact version the lockfile pins for a `jsr:`/`npm:` specifier, with the subpath kept:
   * `jsr:@std/path@^1/join` → `jsr:@std/path@1.1.6/join`, `npm:kleur@^4` → `npm:kleur@4.1.5`.
   * Requirements are matched the way Deno writes them (`^1` → `1`). Returns `null` when the
   * specifier is not a `jsr:`/`npm:` specifier or is not in the lockfile.
   */
  pin(specifier: string): string | null
  /** Whether a `jsr:`/`npm:` specifier is pinned, or a remote URL is recorded. */
  has(specifierOrUrl: string): boolean
  /** Whether the lockfile contains the package version (npm peer variants included). */
  hasPackage(kind: 'jsr' | 'npm', name: string, version: string): boolean
  /** The recorded sha256 of a remote module, following `redirects`. */
  remoteIntegrity(url: string): string | null
  /** The dependencies of an npm package version (`name@version`), or `null` when not locked. */
  npmDependencies(nameVersion: string): string[] | null
}

/** A lockfile in a format older than version 5; callers warn and treat it as absent. */
export interface UnsupportedLockfile {
  path: string
  version: string
  unsupported: true
}

/**
 * Reads `deno.lock`. Returns `null` when the file does not exist or is empty.
 *
 * @throws {DenoPluginError} `LOCKFILE_INVALID` when it cannot be read or parsed as JSON.
 */
export async function readLockfile(path: string): Promise<Lockfile | UnsupportedLockfile | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw new DenoPluginError('LOCKFILE_INVALID', `Cannot read ${path}.`, { cause: error })
  }
  if (text.trim() === '') return null
  return parseLockfile(text, path)
}

/**
 * Parses the text of a `deno.lock` (see {@link readLockfile}). Unknown fields and entries with
 * unexpected shapes are ignored.
 */
export function parseLockfile(text: string, path: string): Lockfile | UnsupportedLockfile {
  const value = parseJsonc(text, path, 'LOCKFILE_INVALID')
  if (!isRecord(value)) {
    throw new DenoPluginError(
      'LOCKFILE_INVALID',
      `${path} is not a lockfile (expected a JSON object).`,
      {
        hint: 'Delete it and run `deno install` to create a new one.',
      },
    )
  }
  const lockVersion = typeof value.version === 'string' ? value.version : '1'
  if (lockVersion !== '5') return { path, version: lockVersion, unsupported: true }
  const specifiers = stringRecord(value.specifiers)
  const jsr = mapRecord(value.jsr, (entry) => ({
    integrity: optionalString(entry.integrity),
    dependencies: strings(entry.dependencies),
  }))
  const npm = mapRecord(value.npm, (entry) => ({
    integrity: optionalString(entry.integrity),
    dependencies: strings(entry.dependencies),
    optionalDependencies: strings(entry.optionalDependencies),
    optionalPeers: strings(entry.optionalPeers),
    tarball: optionalString(entry.tarball),
  }))
  const remote = stringRecord(value.remote)
  const redirects = stringRecord(value.redirects)
  const workspaceValue = isRecord(value.workspace) ? value.workspace : {}
  const workspace = {
    ...workspaceDependencies(workspaceValue),
    members: mapRecord(workspaceValue.members, workspaceDependencies),
  }
  const remoteIntegrity = (url: string): string | null => {
    let current = url
    for (let hops = 0; hops < 10 && remote[current] === undefined; hops++) {
      const next = redirects[current]
      if (next === undefined) break
      current = next
    }
    return remote[current] ?? null
  }
  const npmEntry = (nameVersion: string): NpmLockEntry | undefined =>
    npm[nameVersion] ?? Object.entries(npm).find(([key]) => key.startsWith(`${nameVersion}_`))?.[1]
  const pin = (specifier: string): string | null => pinSpecifier(specifiers, specifier)
  return {
    path,
    version: '5',
    unsupported: false,
    specifiers,
    jsr,
    npm,
    remote,
    redirects,
    workspace,
    pin,
    has: (specifierOrUrl) =>
      /^(?:jsr|npm):/.test(specifierOrUrl)
        ? pin(specifierOrUrl) !== null
        : remoteIntegrity(specifierOrUrl) !== null || redirects[specifierOrUrl] !== undefined,
    hasPackage: (kind, name, version) =>
      kind === 'jsr'
        ? jsr[`${name}@${version}`] !== undefined
        : npmEntry(`${name}@${version}`) !== undefined,
    remoteIntegrity,
    npmDependencies: (nameVersion) => npmEntry(nameVersion)?.dependencies ?? null,
  }
}

function pinSpecifier(specifiers: Record<string, string>, specifier: string): string | null {
  const kind = specifier.startsWith('jsr:') ? 'jsr' : specifier.startsWith('npm:') ? 'npm' : null
  if (kind === null) return null
  const parsed = kind === 'jsr' ? parseJsrSpecifier(specifier) : parseNpmSpecifier(specifier)
  if (parsed === null) return null
  const range = parsed.range ?? '*'
  const req = parseSpecifierVersionReq(range)
  const keys = [`${kind}:${parsed.name}@${range}`]
  if (req !== null) keys.push(`${kind}:${parsed.name}@${normalizeVersionReq(req)}`)
  for (const key of keys) {
    const resolved = specifiers[key]
    if (resolved !== undefined) {
      // npm versions may carry peer-dependency suffixes: `6.5.11_preact@10.24.3`.
      const pinned = resolved.split('_')[0] ?? resolved
      return `${kind}:${parsed.name}@${pinned}${parsed.subpath}`
    }
  }
  return null
}

function workspaceDependencies(value: unknown): LockfileWorkspaceDependencies {
  const record = isRecord(value) ? value : {}
  const packageJson = isRecord(record.packageJson) ? record.packageJson : {}
  return {
    dependencies: strings(record.dependencies),
    packageJsonDependencies: strings(packageJson.dependencies),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function mapRecord<T>(
  value: unknown,
  map: (entry: Record<string, unknown>) => T,
): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, map(isRecord(entry) ? entry : {})]),
  )
}
