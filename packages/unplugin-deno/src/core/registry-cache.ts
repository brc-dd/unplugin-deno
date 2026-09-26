/**
 * Read-only access to the registry metadata in Deno's global cache (`DENO_DIR`), which the
 * engines fill while they resolve: npm packuments (`npm/<registry>/<name>/registry.json`, with
 * `time` and `dist.integrity`) and JSR package metadata (`remote/<scheme>/<host>/<hash>` files of
 * `<registry>/<scope>/<name>/meta.json` and `<version>_meta.json`, whose sha256 is the integrity
 * `deno.lock` records). Used to explain versions the minimum dependency age held back and to
 * write a sidecar `deno.lock` for projects without one. Nothing is downloaded; missing or
 * unreadable files are `undefined`.
 *
 * @module
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitCacheFile } from '../engine/deno-cli/info.js'
import { sha256Hex } from '../utils/hash.js'

/** The parts of an npm packument the plugin reads. */
export interface CachedPackument {
  /** The packument file. */
  file: string
  versions: Readonly<Record<string, CachedNpmVersion>>
  /** Publish times by version (ISO dates), when the registry sent them. */
  time: Readonly<Record<string, string>>
}

/** One version of a {@link CachedPackument}. */
export interface CachedNpmVersion {
  dependencies: Readonly<Record<string, string>>
  optionalDependencies: Readonly<Record<string, string>>
  peerDependencies: Readonly<Record<string, string>>
  /** Names of peer dependencies marked `optional`. */
  optionalPeers: readonly string[]
  integrity: string | undefined
  tarball: string | undefined
}

/** The parts of a JSR package's `meta.json` the plugin reads. */
export interface CachedJsrMeta {
  /** Versions with their publish dates (`createdAt`) and whether they are yanked. */
  versions: Readonly<Record<string, { createdAt: string | undefined; yanked: boolean }>>
}

/**
 * The file Deno caches `url` in: `<DENO_DIR>/remote/<scheme>/<host>[_PORT<port>]/<sha256 of the
 * path and query>` (`deno_cache_dir`'s `url_to_filename`).
 */
export function remoteCacheFile(denoDir: string, url: string): string | undefined {
  const parsed = URL.parse(url)
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return undefined
  }
  const host = parsed.port === '' ? parsed.hostname : `${parsed.hostname}_PORT${parsed.port}`
  const rest = `${parsed.pathname}${parsed.search}`
  return join(denoDir, 'remote', parsed.protocol.slice(0, -1), host, sha256Hex(rest))
}

/** The content of a cached remote file (Deno's metadata line removed), or `undefined`. */
export function readCachedRemote(denoDir: string, url: string): Uint8Array | undefined {
  const file = remoteCacheFile(denoDir, url)
  if (file === undefined) return undefined
  let bytes: Uint8Array
  try {
    bytes = readFileSync(file)
  } catch {
    return undefined
  }
  return splitCacheFile(bytes)?.content
}

/** The cached `meta.json` of the JSR package `name` (`@scope/name`) of `registry`. */
export function cachedJsrMeta(
  denoDirs: readonly string[],
  registry: string,
  name: string,
): CachedJsrMeta | undefined {
  for (const denoDir of denoDirs) {
    const bytes = readCachedRemote(denoDir, new URL(`${name}/meta.json`, registry).href)
    const value = bytes === undefined ? undefined : parseJson(bytes)
    if (!isRecord(value) || !isRecord(value.versions)) continue
    const versions: Record<string, { createdAt: string | undefined; yanked: boolean }> = {}
    for (const [version, info] of Object.entries(value.versions)) {
      const record = isRecord(info) ? info : {}
      versions[version] = {
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
        yanked: record.yanked === true,
      }
    }
    return { versions }
  }
  return undefined
}

/**
 * The integrity `deno.lock` records for a JSR package version: the sha256 of its cached
 * `<version>_meta.json`, or `undefined` when it is not cached.
 */
export function cachedJsrIntegrity(
  denoDirs: readonly string[],
  registry: string,
  name: string,
  version: string,
): string | undefined {
  for (const denoDir of denoDirs) {
    const url = new URL(`${name}/${version}_meta.json`, registry).href
    const bytes = readCachedRemote(denoDir, url)
    if (bytes !== undefined) return sha256Hex(bytes)
  }
  return undefined
}

/**
 * The cached packument of the npm package `name`, from any registry directory of
 * `<DENO_DIR>/npm/` (`registry.npmjs.org`, `npm.jsr.io`, `<host>_<port>`, …; `registryDir` is
 * tried first when given).
 */
export function cachedPackument(
  denoDirs: readonly string[],
  name: string,
  registryDir?: string,
): CachedPackument | undefined {
  for (const denoDir of denoDirs) {
    const root = join(denoDir, 'npm')
    let registries: string[]
    try {
      registries = readdirSync(root)
    } catch {
      continue
    }
    const ordered =
      registryDir === undefined
        ? registries
        : [registryDir, ...registries.filter((dir) => dir !== registryDir)]
    for (const registry of ordered) {
      const file = join(root, registry, ...name.split('/'), 'registry.json')
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const packument = parsePackument(text, file)
      if (packument !== undefined) return packument
    }
  }
  return undefined
}

function parsePackument(text: string, file: string): CachedPackument | undefined {
  const value = parseJson(new TextEncoder().encode(text))
  if (!isRecord(value) || !isRecord(value.versions)) return undefined
  const versions: Record<string, CachedNpmVersion> = {}
  for (const [version, info] of Object.entries(value.versions)) {
    const record = isRecord(info) ? info : {}
    const dist = isRecord(record.dist) ? record.dist : {}
    const peersMeta = isRecord(record.peerDependenciesMeta) ? record.peerDependenciesMeta : {}
    versions[version] = {
      dependencies: stringRecord(record.dependencies),
      optionalDependencies: stringRecord(record.optionalDependencies),
      peerDependencies: stringRecord(record.peerDependencies),
      optionalPeers: Object.entries(peersMeta)
        .filter(([, meta]) => isRecord(meta) && meta.optional === true)
        .map(([peer]) => peer),
      integrity: typeof dist.integrity === 'string' ? dist.integrity : undefined,
      tarball: typeof dist.tarball === 'string' ? dist.tarball : undefined,
    }
  }
  return { file, versions, time: stringRecord(value.time) }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}
