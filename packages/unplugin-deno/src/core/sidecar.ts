/**
 * Sidecar `deno.json` and `deno.lock` for Deno platform output (docs/architecture.md §5.6; plan
 * S3): the output of a `platform: 'deno'` build keeps its `npm:`/`jsr:` imports external and
 * pinned, but a lockfile generated from the sources does not record them, so
 * `deno run --frozen --cached-only` of the output fails. With `emitDenoConfig`, the build writes
 * next to its output:
 *
 * - `deno.json`: `{ "lock": "./deno.lock", "nodeModulesDir": "none" }` (no `nodeModulesDir` when
 *   the output imports bare specifiers, which need a `node_modules` directory);
 * - `deno.lock` (version 5): the external packages and their dependencies, copied from the
 *   project's lockfile (`specifiers`, `jsr`, `npm`, and `remote` when a remote URL is external);
 *   packages the project's lockfile lacks (or all of them, without one) are read from Deno's cache
 *   (JSR version metadata and npm packuments, which hold the integrity) with the versions the
 *   engine resolves for their dependencies.
 *
 * Extra entries are harmless to `deno cache --frozen` and `deno run --frozen` (verified with Deno
 * 2.9.7), so the copy errs on the side of including requirements that point into the closure.
 * The resolver records the externals per platform ({@link ExternalRecorder}); hosts call
 * {@link writeSidecar} once the output is written (Rollup-family `writeBundle`, esbuild `onEnd`).
 *
 * @module
 */
import { join } from 'node:path'
import type { Lockfile, NpmLockEntry } from '../config/lockfile.js'
import { normalizeVersionReq, parseSpecifierVersionReq } from '../config/version-req.js'
import type { Logger } from '../diagnostics/logger.js'
import { parsePackageSpecifier } from '../engine/package-specifier.js'
import type { Engine, ResolvedModule } from '../engine/types.js'
import { writeFileAtomic } from '../utils/fs.js'
import { toFileUrl } from '../utils/path.js'
import { jsrPackageOfUrl } from './lockfile-policy.js'
import type { Platform } from './options.js'
import { cachedJsrIntegrity, cachedPackument, readCachedRemote } from './registry-cache.js'
import { parseSpecifier } from './specifier.js'
import type { PluginState } from './state.js'
import { isWatchedFile } from './watch.js'

/** An import a build keeps external. */
export interface ExternalRecord {
  /** The import as the output writes it: `npm:kleur@4.1.5`, `jsr:@std/path@1.1.6/posix`, `node:fs`. */
  id: string
  /** What the engine resolved it to (for pinned `npm:`/`jsr:` externals). */
  resolved?: ResolvedModule | undefined
}

/** The external imports of the builds of one plugin instance, per platform. */
export class ExternalRecorder {
  readonly #byPlatform = new Map<Platform, Map<string, ExternalRecord>>()

  /** Records an external import of a build for `platform`. */
  record(platform: Platform, record: ExternalRecord): void {
    let records = this.#byPlatform.get(platform)
    if (records === undefined) {
      records = new Map()
      this.#byPlatform.set(platform, records)
    }
    const known = records.get(record.id)
    if (known === undefined || (known.resolved === undefined && record.resolved !== undefined)) {
      records.set(record.id, record)
    }
  }

  /** The externals recorded for `platform`, sorted by id. */
  list(platform: Platform): ExternalRecord[] {
    return [...(this.#byPlatform.get(platform)?.values() ?? [])].toSorted((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
  }

  /** Forgets every record (the project was reloaded). */
  clear(): void {
    this.#byPlatform.clear()
  }
}

/** An `npm` entry of a `deno.lock` as JSON. */
export interface NpmLockJson {
  integrity?: string
  dependencies?: string[]
  optionalDependencies?: string[]
  optionalPeers?: string[]
  tarball?: string
}

/** A `deno.lock` version 5 as JSON (the sections a sidecar uses). */
export interface LockfileJson {
  version: '5'
  specifiers?: Record<string, string>
  jsr?: Record<string, { integrity?: string; dependencies?: string[] }>
  npm?: Record<string, NpmLockJson>
  redirects?: Record<string, string>
  remote?: Record<string, string>
}

/** The sidecar files of a build. */
export interface Sidecar {
  denoJson: { lock: string; nodeModulesDir?: 'none' }
  lockfile: LockfileJson
  /** Packages the sidecar lockfile could not describe (not in the lockfile, not cached). */
  missing: string[]
  /** Bare external imports (they need a `node_modules` directory or an import map). */
  bare: string[]
  /** Packages read from Deno's cache because the project's lockfile lacks them. */
  fromCache: string[]
}

/** What {@link buildSidecar} reads besides the externals. */
export interface SidecarContext {
  /** The project's lockfile, if any. */
  lockfile: Pick<Lockfile, 'specifiers' | 'jsr' | 'npm' | 'remote' | 'redirects' | 'pin'> | null
  /** `DENO_DIR` spellings, for the registry metadata of packages the lockfile lacks. */
  denoDirs: readonly string[]
  /** The JSR registries (`https://jsr.io/`, `JSR_URL`). */
  jsrRegistries: readonly string[]
  /** The engine that resolves the dependencies of packages the lockfile lacks. */
  engine?: (() => Promise<Engine>) | undefined
  logger: Logger
}

type PackageKind = 'npm' | 'jsr'

/** A package of the closure: `jsr` keys are `name@version`, `npm` keys lockfile keys. */
interface Pending {
  kind: PackageKind
  key: string
  name: string
  version: string
  /** For packages outside the project's lockfile: where the package is installed. */
  resolved?: ResolvedModule | undefined
}

/**
 * The sidecar files for `externals` (see the module documentation). Never throws for missing
 * data: what cannot be described is listed in {@link Sidecar.missing}.
 */
export async function buildSidecar(
  externals: readonly ExternalRecord[],
  context: SidecarContext,
): Promise<Sidecar> {
  const builder = new LockBuilder(context)
  const bare: string[] = []
  let remote = false
  for (const external of externals) {
    const spec = parseSpecifier(external.id)
    if (spec.kind === 'npm' || spec.kind === 'jsr') await builder.addExternal(external)
    else if (spec.kind === 'https' || spec.kind === 'http') remote = true
    else if (spec.kind === 'bare') bare.push(external.id)
  }
  await builder.complete()
  if (remote) builder.addRemote()
  const denoJson: Sidecar['denoJson'] =
    bare.length === 0 ? { lock: './deno.lock', nodeModulesDir: 'none' } : { lock: './deno.lock' }
  return {
    denoJson,
    lockfile: builder.toJson(),
    missing: builder.missing,
    bare,
    fromCache: builder.fromCache,
  }
}

class LockBuilder {
  readonly missing: string[] = []
  readonly fromCache: string[] = []
  readonly #context: SidecarContext
  readonly #specifiers = new Map<string, string>()
  readonly #jsr = new Map<string, { integrity?: string; dependencies?: string[] }>()
  readonly #npm = new Map<string, NpmLockJson>()
  readonly #remote = new Map<string, string>()
  readonly #redirects = new Map<string, string>()
  readonly #queue: Pending[] = []
  readonly #seen = new Set<string>()

  constructor(context: SidecarContext) {
    this.#context = context
  }

  async addExternal(external: ExternalRecord): Promise<void> {
    const parsed = parsePackageSpecifier(external.id)
    if (parsed === undefined || parsed.scheme === 'bare') return
    const kind = parsed.scheme
    const requirementKey = requirementKeyOf(kind, parsed.name, parsed.version)
    const lockfile = this.#context.lockfile
    // The version the output runs: exact pins, the lockfile's pin, or what the engine resolved.
    const version =
      exactVersion(parsed.version) ??
      versionOf(lockfile?.pin(external.id) ?? undefined) ??
      resolvedVersion(external.resolved, parsed.name, this.#context.jsrRegistries)
    if (version === undefined) {
      this.missing.push(external.id)
      return
    }
    const key =
      kind === 'npm'
        ? (npmKeyFor(lockfile, parsed.name, version) ?? `${parsed.name}@${version}`)
        : `${parsed.name}@${version}`
    this.#specifiers.set(
      requirementKey,
      kind === 'npm' ? key.slice(parsed.name.length + 1) : version,
    )
    this.#enqueue({ kind, key, name: parsed.name, version, resolved: external.resolved })
  }

  /** Adds the closure of every queued package. */
  async complete(): Promise<void> {
    for (let pending = this.#queue.shift(); pending !== undefined; pending = this.#queue.shift()) {
      if (pending.kind === 'jsr') await this.#addJsr(pending)
      else await this.#addNpm(pending)
    }
  }

  /** Copies the `remote` entries and `redirects` of the project's lockfile. */
  addRemote(): void {
    const lockfile = this.#context.lockfile
    if (lockfile === null) return
    for (const [url, hash] of Object.entries(lockfile.remote)) this.#remote.set(url, hash)
    for (const [from, to] of Object.entries(lockfile.redirects)) this.#redirects.set(from, to)
  }

  toJson(): LockfileJson {
    const json: LockfileJson = { version: '5' }
    if (this.#specifiers.size > 0) json.specifiers = sortedRecord(this.#specifiers)
    if (this.#jsr.size > 0) json.jsr = sortedRecord(this.#jsr)
    if (this.#npm.size > 0) json.npm = sortedRecord(this.#npm)
    if (this.#redirects.size > 0) json.redirects = sortedRecord(this.#redirects)
    if (this.#remote.size > 0) json.remote = sortedRecord(this.#remote)
    return json
  }

  #enqueue(pending: Pending): void {
    const id = `${pending.kind}:${pending.key}`
    if (this.#seen.has(id)) return
    this.#seen.add(id)
    this.#queue.push(pending)
  }

  async #addJsr(pending: Pending): Promise<void> {
    const lockfile = this.#context.lockfile
    const locked = lockfile?.jsr[pending.key]
    if (locked !== undefined) {
      const entry: { integrity?: string; dependencies?: string[] } = {}
      if (locked.integrity !== undefined) entry.integrity = locked.integrity
      if (locked.dependencies.length > 0) entry.dependencies = [...locked.dependencies]
      this.#jsr.set(pending.key, entry)
      this.#copyRequirements('jsr', pending.name, pending.version)
      for (const dependency of locked.dependencies) this.#lockedDependency(dependency)
      return
    }
    // Not in the project's lockfile: the cached version metadata and the engine.
    const { denoDirs, jsrRegistries } = this.#context
    let integrity: string | undefined
    let registry: string | undefined
    for (const candidate of jsrRegistries) {
      integrity = cachedJsrIntegrity(denoDirs, candidate, pending.name, pending.version)
      if (integrity !== undefined) {
        registry = candidate
        break
      }
    }
    if (integrity === undefined || registry === undefined) {
      this.missing.push(`jsr:${pending.name}@${pending.version}`)
      return
    }
    this.fromCache.push(`jsr:${pending.name}@${pending.version}`)
    const requirements = jsrRequirements(denoDirs, registry, pending.name, pending.version)
    const dependencies = new Set<string>()
    for (const requirement of requirements) {
      const parsed = parsePackageSpecifier(requirement)
      if (parsed === undefined || parsed.scheme === 'bare') continue
      dependencies.add(`${parsed.scheme}:${parsed.name}`)
      await this.#resolveRequirement(requirement, undefined)
    }
    const entry: { integrity?: string; dependencies?: string[] } = { integrity }
    if (dependencies.size > 0) entry.dependencies = [...dependencies].toSorted()
    this.#jsr.set(pending.key, entry)
  }

  async #addNpm(pending: Pending): Promise<void> {
    const lockfile = this.#context.lockfile
    const locked = lockfile?.npm[pending.key]
    if (locked !== undefined) {
      this.#npm.set(pending.key, npmJson(locked))
      this.#copyRequirements('npm', pending.name, pending.key.slice(pending.name.length + 1))
      for (const dependency of [
        ...locked.dependencies,
        ...locked.optionalDependencies,
        ...locked.optionalPeers,
      ]) {
        const key = npmDependencyKey(lockfile, dependency)
        if (key !== undefined) this.#enqueueNpmKey(key)
      }
      return
    }
    const packument = cachedPackument(this.#context.denoDirs, pending.name)
    const info = packument?.versions[pending.version]
    if (info === undefined || info.integrity === undefined) {
      this.missing.push(`npm:${pending.name}@${pending.version}`)
      return
    }
    this.fromCache.push(`npm:${pending.name}@${pending.version}`)
    const entry: NpmLockJson = { integrity: info.integrity }
    const dependencies: string[] = []
    const optional: string[] = []
    const referrer = pending.resolved?.npm?.packageJsonPath
    for (const [dependency, optionalDependency] of [
      ...Object.keys(info.dependencies).map((key) => [key, false] as const),
      ...Object.keys(info.optionalDependencies).map((key) => [key, true] as const),
    ]) {
      const resolved =
        referrer === undefined
          ? undefined
          : await this.#resolveFrom(dependency, toFileUrl(referrer))
      if (resolved?.npm === undefined) {
        if (!optionalDependency) {
          this.missing.push(`npm:${dependency} (a dependency of ${pending.name})`)
        }
        continue
      }
      ;(optionalDependency ? optional : dependencies).push(resolved.npm.name)
      this.#enqueue({
        kind: 'npm',
        key: `${resolved.npm.name}@${resolved.npm.version}`,
        name: resolved.npm.name,
        version: resolved.npm.version,
        resolved,
      })
    }
    if (dependencies.length > 0) entry.dependencies = dependencies.toSorted()
    if (optional.length > 0) entry.optionalDependencies = optional.toSorted()
    if (
      info.tarball !== undefined &&
      !isDefaultTarball(info.tarball, pending.name, pending.version)
    ) {
      entry.tarball = info.tarball
    }
    this.#npm.set(pending.key, entry)
  }

  /** A `dependencies` entry of a locked JSR package (`jsr:@std/internal`, `npm:foo`). */
  #lockedDependency(dependency: string): void {
    const lockfile = this.#context.lockfile
    const parsed = parsePackageSpecifier(dependency)
    if (lockfile === null || parsed === undefined || parsed.scheme === 'bare') return
    let found = false
    for (const [requirement, resolved] of Object.entries(lockfile.specifiers)) {
      const candidate = parsePackageSpecifier(requirement)
      if (candidate?.scheme !== parsed.scheme || candidate.name !== parsed.name) continue
      found = true
      this.#specifiers.set(requirement, resolved)
      if (parsed.scheme === 'jsr') {
        this.#enqueue({
          kind: 'jsr',
          key: `${parsed.name}@${resolved}`,
          name: parsed.name,
          version: resolved,
        })
      } else {
        this.#enqueueNpmKey(`${parsed.name}@${resolved}`)
      }
    }
    if (found) return
    // No requirement recorded: every locked version of the package.
    const keys = Object.keys(parsed.scheme === 'jsr' ? lockfile.jsr : lockfile.npm)
    for (const key of keys) {
      if (packageNameOfKey(key) !== parsed.name) continue
      if (parsed.scheme === 'jsr') {
        this.#enqueue({
          kind: 'jsr',
          key,
          name: parsed.name,
          version: key.slice(parsed.name.length + 1),
        })
      } else {
        this.#enqueueNpmKey(key)
      }
    }
  }

  #enqueueNpmKey(key: string): void {
    const name = packageNameOfKey(key)
    const version = key.slice(name.length + 1).split('_')[0] ?? ''
    this.#enqueue({ kind: 'npm', key, name, version })
  }

  /** Copies the project's `specifiers` entries that resolve to `name` at `resolved`. */
  #copyRequirements(kind: PackageKind, name: string, resolved: string): void {
    const lockfile = this.#context.lockfile
    if (lockfile === null) return
    for (const [requirement, value] of Object.entries(lockfile.specifiers)) {
      if (value !== resolved) continue
      const parsed = parsePackageSpecifier(requirement)
      if (parsed?.scheme === kind && parsed.name === name) this.#specifiers.set(requirement, value)
    }
  }

  /** Resolves a `jsr:`/`npm:` requirement of a package outside the lockfile with the engine. */
  async #resolveRequirement(requirement: string, referrer: string | undefined): Promise<void> {
    const parsed = parsePackageSpecifier(requirement)
    if (parsed === undefined || parsed.scheme === 'bare') return
    const base = `${parsed.scheme}:${parsed.name}${parsed.version === undefined ? '' : `@${parsed.version}`}`
    const resolved = await this.#resolveFrom(base, referrer)
    const version = resolvedVersion(resolved, parsed.name, this.#context.jsrRegistries)
    if (version === undefined) {
      this.missing.push(base)
      return
    }
    const key = requirementKeyOf(parsed.scheme, parsed.name, parsed.version)
    this.#specifiers.set(key, version)
    this.#enqueue({
      kind: parsed.scheme,
      key: `${parsed.name}@${version}`,
      name: parsed.name,
      version,
      resolved,
    })
  }

  async #resolveFrom(
    specifier: string,
    referrer: string | undefined,
  ): Promise<ResolvedModule | undefined> {
    const engine = this.#context.engine
    if (engine === undefined) return undefined
    try {
      return await (await engine()).resolve(specifier, referrer, 'import')
    } catch (error) {
      this.#context.logger.debug(
        `[sidecar] cannot resolve ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }
}

/** The `specifiers` key Deno writes for a requirement: `npm:kleur@^4` → `npm:kleur@4`. */
function requirementKeyOf(kind: PackageKind, name: string, range: string | undefined): string {
  const req = parseSpecifierVersionReq(range ?? '*')
  return `${kind}:${name}@${req === null ? (range ?? '*') : normalizeVersionReq(req)}`
}

/** `range` when it is an exact version (`4.1.5`, `1.0.0-rc.1`), else `undefined`. */
function exactVersion(range: string | undefined): string | undefined {
  return range !== undefined && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(range)
    ? range
    : undefined
}

/** The version of a pinned specifier (`npm:kleur@4.1.5/colors` → `4.1.5`). */
function versionOf(pinned: string | undefined): string | undefined {
  return pinned === undefined ? undefined : parsePackageSpecifier(pinned)?.version
}

/** The version of `name` a resolution names (npm package version, JSR URL version). */
function resolvedVersion(
  resolved: ResolvedModule | undefined,
  name: string,
  registries: readonly string[],
): string | undefined {
  if (resolved === undefined) return undefined
  if (resolved.kind === 'npm' && resolved.npm?.name === name && resolved.npm.version !== '') {
    return resolved.npm.version
  }
  if (resolved.kind === 'remote') {
    const jsr = jsrPackageOfUrl(resolved.url, registries)
    if (jsr?.name === name) return jsr.version
  }
  return undefined
}

/** The lockfile key of `name@version` (with a peer-dependency suffix when the lockfile has one). */
function npmKeyFor(
  lockfile: Pick<Lockfile, 'npm'> | null,
  name: string,
  version: string,
): string | undefined {
  if (lockfile === null) return undefined
  const exact = `${name}@${version}`
  if (lockfile.npm[exact] !== undefined) return exact
  return Object.keys(lockfile.npm).find((key) => key.startsWith(`${exact}_`))
}

/**
 * The lockfile key an npm `dependencies` entry refers to: a key itself (`name@version[_peers]`),
 * or the name of the only locked version of a package.
 */
function npmDependencyKey(
  lockfile: Pick<Lockfile, 'npm'> | null,
  dependency: string,
): string | undefined {
  if (lockfile === null) return undefined
  if (lockfile.npm[dependency] !== undefined) return dependency
  return Object.keys(lockfile.npm).find((key) => packageNameOfKey(key) === dependency)
}

/** The package name of a lockfile key (`@scope/name@1.0.0_peer@2` → `@scope/name`). */
function packageNameOfKey(key: string): string {
  const at = key.indexOf('@', key.startsWith('@') ? 1 : 0)
  return at === -1 ? key : key.slice(0, at)
}

function npmJson(entry: NpmLockEntry): NpmLockJson {
  const json: NpmLockJson = {}
  if (entry.integrity !== undefined) json.integrity = entry.integrity
  if (entry.dependencies.length > 0) json.dependencies = [...entry.dependencies]
  if (entry.optionalDependencies.length > 0) {
    json.optionalDependencies = [...entry.optionalDependencies]
  }
  if (entry.optionalPeers.length > 0) json.optionalPeers = [...entry.optionalPeers]
  if (entry.tarball !== undefined) json.tarball = entry.tarball
  return json
}

/** Whether `tarball` is npmjs.org's URL for the package (Deno omits those from the lockfile). */
function isDefaultTarball(tarball: string, name: string, version: string): boolean {
  const basename = name.split('/').at(-1) ?? name
  return tarball === `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`
}

/**
 * The `jsr:`/`npm:` requirements the modules of a JSR package version import (its cached
 * `<version>_meta.json` `moduleGraph2`/`moduleGraph1`), without subpaths.
 */
function jsrRequirements(
  denoDirs: readonly string[],
  registry: string,
  name: string,
  version: string,
): string[] {
  const url = new URL(`${name}/${version}_meta.json`, registry).href
  for (const denoDir of denoDirs) {
    const bytes = readCachedRemote(denoDir, url)
    if (bytes === undefined) continue
    let meta: unknown
    try {
      meta = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      return []
    }
    const graph = isRecord(meta) ? (meta.moduleGraph2 ?? meta.moduleGraph1) : undefined
    const requirements = new Set<string>()
    for (const module of Object.values(isRecord(graph) ? graph : {})) {
      const dependencies = isRecord(module) ? module.dependencies : undefined
      for (const dependency of Array.isArray(dependencies) ? dependencies : []) {
        const specifier: unknown = isRecord(dependency) ? dependency.specifier : undefined
        if (typeof specifier !== 'string') continue
        const parsed = parsePackageSpecifier(specifier)
        if (parsed === undefined || parsed.scheme === 'bare') continue
        requirements.add(
          `${parsed.scheme}:${parsed.name}${parsed.version === undefined ? '' : `@${parsed.version}`}`,
        )
      }
    }
    return [...requirements].toSorted()
  }
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortedRecord<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** Options of {@link writeSidecar}. */
export interface WriteSidecarOptions {
  /** The platform of the output (a Vite environment's); default: the build's. */
  platform?: Platform | undefined
  /** Dispose the engines afterwards (the build is over; not in watch mode). */
  dispose?: boolean | undefined
}

/**
 * Writes the sidecar `deno.json` and `deno.lock` of a Deno platform build (see the module
 * documentation): into the `emitDenoConfig` directory, or `entryDir` (the directory of the first
 * entry chunk) for `emitDenoConfig: true`. Does nothing unless `emitDenoConfig` is set and the
 * platform is `deno`; never overwrites the project's own config or lockfile. Returns the files
 * written.
 */
export async function writeSidecar(
  state: PluginState,
  entryDir: string,
  options: WriteSidecarOptions = {},
): Promise<string[]> {
  const setting = state.options.emitDenoConfig
  if (setting === false || !state.ready) return []
  const platform = options.platform ?? state.platform
  const { logger } = state
  if (platform !== 'deno') {
    logger.debug(`[sidecar] not writing deno.json/deno.lock for the ${platform} platform`)
    return []
  }
  const dir = typeof setting === 'string' ? setting : entryDir
  const files = [join(dir, 'deno.json'), join(dir, 'deno.lock')]
  const { project } = state
  const own = files.find((file) => isWatchedFile(project, file, state.flavor))
  if (own !== undefined) {
    logger.warn(
      `Not writing the sidecar deno.json and deno.lock into ${dir}: ${own} belongs to the project. Set \`emitDenoConfig\` to another directory (or write the output elsewhere).`,
    )
    return []
  }
  const externals = state.externals(platform)
  let usedEngine = false
  try {
    const sidecar = await buildSidecar(externals, {
      lockfile: project.lockfile,
      denoDirs: state.denoDirs,
      jsrRegistries: state.jsrRegistries,
      engine: () => {
        usedEngine = true
        return state.engine()
      },
      logger,
    })
    await writeFileAtomic(files[0] as string, `${JSON.stringify(sidecar.denoJson, null, 2)}\n`)
    await writeFileAtomic(files[1] as string, `${JSON.stringify(sidecar.lockfile, null, 2)}\n`)
    const packages =
      Object.keys(sidecar.lockfile.jsr ?? {}).length +
      Object.keys(sidecar.lockfile.npm ?? {}).length
    logger.debug(
      `[sidecar] wrote ${files.join(' and ')} (${externals.length} external import(s), ${packages} package(s)${sidecar.fromCache.length === 0 ? '' : `, ${sidecar.fromCache.length} from Deno's cache`})`,
    )
    if (sidecar.missing.length > 0) {
      logger.warn(
        `The sidecar deno.lock in ${dir} lacks ${sidecar.missing.join(', ')} (not in the project's deno.lock or Deno's cache): run \`deno install\` in the project, or \`deno cache\` without --frozen in ${dir}, to complete it.`,
      )
    }
    if (sidecar.bare.length > 0) {
      logger.warn(
        `The output in ${dir} imports ${sidecar.bare.map((id) => `\`${id}\``).join(', ')} as bare specifiers, which Deno resolves only with a node_modules directory or an import map; the sidecar deno.json does not set "nodeModulesDir": "none".`,
      )
    }
    return files
  } finally {
    if (usedEngine && options.dispose === true) await state.disposeEngines()
  }
}
