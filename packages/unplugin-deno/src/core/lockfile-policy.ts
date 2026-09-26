/**
 * The `lockfile` option (docs/architecture.md §5.13; plan R5, X5): which mode applies to a build,
 * whether a resolution drifts from `deno.lock`, and the explanations of resolutions the lockfile
 * does not cover.
 *
 * - `frozen` (`lockfile: 'frozen'`, or `'auto'` with a lockfile and `CI` set or `"lock": {
 *   "frozen": true }`): an `npm:`/`jsr:` requirement that resolves to a version the lockfile does
 *   not record for it (or records differently), an npm or JSR package version missing from it,
 *   and a remote URL missing from its `remote` entries fail with `LOCKFILE_FROZEN_DRIFT`, like
 *   `deno install --frozen`. The engines honour the lockfile themselves; drift means the lockfile
 *   is out of date (a new import, a changed import map).
 * - `auto`: drift is allowed and explained in the debug output (`NOT_IN_LOCKFILE` for missing
 *   entries), with the versions the minimum dependency age held back.
 * - `off`: nothing is checked (the engines get no lockfile).
 *
 * Failures are explained too: a `CACHED_ONLY_MISS` for a requirement the lockfile lacks becomes
 * `NOT_IN_LOCKFILE`, and a `RESOLVE_CONSTRAINT` whose matching versions are all younger than the
 * minimum dependency age says so. Registry metadata comes from Deno's cache (`registry-cache.ts`).
 *
 * @module
 */
import type { Lockfile, MinimumDependencyAge, Project } from '../config/project.js'
import type { SemVer } from '../config/version-req.js'
import {
  compareVersions,
  formatVersion,
  parseSpecifierVersionReq,
  parseVersion,
  satisfies,
} from '../config/version-req.js'
import { DenoPluginError, isDenoPluginError } from '../diagnostics/errors.js'
import type { Logger } from '../diagnostics/logger.js'
import { parsePackageSpecifier } from '../engine/package-specifier.js'
import type { ResolvedModule } from '../engine/types.js'
import type { LockfileMode } from './options.js'
import { cachedJsrMeta, cachedPackument } from './registry-cache.js'

/** The mode a build uses (see the module documentation) and why. */
export interface LockfileModeDecision {
  mode: LockfileMode
  /** For messages: `` `CI` is set``, `` `lockfile: 'frozen'` ``, … */
  reason: string
}

/** Whether `CI` is set to something other than `''`, `0`, `false`, `no` or `off`. */
export function isCiEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.CI
  return value !== undefined && !/^(?:|0|false|no|off)$/i.test(value.trim())
}

/** The mode for the `lockfile` option, the project and the environment. */
export function lockfileModeFor(
  option: LockfileMode,
  project: Pick<Project, 'lockfile' | 'lockfileFrozen'>,
  env: Readonly<Record<string, string | undefined>>,
): LockfileModeDecision {
  if (option === 'off') return { mode: 'off', reason: "`lockfile: 'off'`" }
  if (option === 'frozen') return { mode: 'frozen', reason: "`lockfile: 'frozen'`" }
  if (project.lockfile === null) return { mode: 'auto', reason: 'no deno.lock' }
  if (isCiEnvironment(env)) return { mode: 'frozen', reason: '`CI` is set' }
  if (project.lockfileFrozen) {
    return { mode: 'frozen', reason: '`"lock": { "frozen": true }` in deno.json' }
  }
  return { mode: 'auto', reason: "`lockfile: 'auto'`" }
}

/** A resolution to compare with the lockfile. */
export interface LockCheck {
  /**
   * What was resolved: an `npm:`/`jsr:` requirement (after import-map mapping), a URL, a bare
   * name inside an npm package, a relative import of a remote module.
   */
  specifier: string
  resolved: ResolvedModule
  /** The import is inside an npm package: only the package version is locked, not the name. */
  transitive?: boolean | undefined
}

/** How a resolution differs from the lockfile. */
export interface Drift {
  /** `npm:<name>@<version>`, `jsr:<name>@<version>` or the URL that was resolved. */
  resolved: string
  /** The version the lockfile records for the requirement, `undefined` when it has none. */
  locked: string | undefined
  /** One sentence fragment: `npm:kleur@^4 resolved to 4.1.6, deno.lock has 4.1.5`. */
  message: string
}

/** Options of {@link lockfileDrift}. */
export interface DriftOptions {
  /** URLs of the JSR registries (their files are locked by package, not in `remote`). */
  jsrRegistries: readonly string[]
  /**
   * Whether npm packages are locked: not with `nodeModulesDir: "manual"`, where the project's
   * package manager installs them.
   */
  npm: boolean
}

/** The JSR package of a registry URL (`<registry>/@scope/name/<version>/…`), if it is one. */
export function jsrPackageOfUrl(
  url: string,
  registries: readonly string[],
): { name: string; version: string } | undefined {
  for (const registry of registries) {
    if (!url.startsWith(registry)) continue
    const [scope, name, version, ...file] = url.slice(registry.length).split('/')
    if (scope?.startsWith('@') !== true || name === undefined || version === undefined) continue
    if (name === '' || version === '' || file.length === 0) continue
    return { name: `${scope}/${name}`, version: decodeURIComponent(version) }
  }
  return undefined
}

/**
 * Compares one resolution with `lockfile` (`null`: there is none). Returns `null` when the
 * lockfile covers it (or does not lock it at all: local files, `data:` URLs, builtins, files of a
 * JSR package reached by relative imports).
 */
export function lockfileDrift(
  lockfile: Lockfile | null,
  check: LockCheck,
  options: DriftOptions,
): Drift | null {
  const { specifier, resolved } = check
  const requested = parsePackageSpecifier(specifier)
  if (resolved.kind === 'npm') {
    const info = resolved.npm
    if (!options.npm || info === undefined || info.version === '') return null
    const topLevel =
      check.transitive !== true && requested?.scheme === 'npm' && requested.name === info.name
    return packageDrift(lockfile, 'npm', info.name, info.version, topLevel ? specifier : undefined)
  }
  if (resolved.kind !== 'remote') return null
  const jsr = jsrPackageOfUrl(resolved.url, options.jsrRegistries)
  if (jsr !== undefined) {
    // Relative imports between the files of a JSR package are locked with the package.
    if (requested?.scheme !== 'jsr' || requested.name !== jsr.name) return null
    return packageDrift(lockfile, 'jsr', jsr.name, jsr.version, specifier)
  }
  if (requested !== undefined) return null
  if (lockfile !== null && lockfile.remoteIntegrity(resolved.url) !== null) return null
  return {
    resolved: resolved.url,
    locked: undefined,
    message: lockfile === null ? resolved.url : `${resolved.url} is not in deno.lock`,
  }
}

function packageDrift(
  lockfile: Lockfile | null,
  kind: 'npm' | 'jsr',
  name: string,
  version: string,
  requirement: string | undefined,
): Drift | null {
  const resolved = `${kind}:${name}@${version}`
  if (lockfile === null) {
    return {
      resolved,
      locked: undefined,
      message: `${requirement ?? resolved} resolved to ${version}`,
    }
  }
  if (requirement !== undefined) {
    const pinned = lockfile.pin(requirement)
    const locked = pinned === null ? undefined : parsePackageSpecifier(pinned)?.version
    if (locked === undefined) {
      const others = lockedVersions(lockfile, kind, name)
      const note = others.length === 0 ? '' : ` (it locks ${name} ${others.join(', ')})`
      return {
        resolved,
        locked: undefined,
        message: `${requirement} resolved to ${version}, but deno.lock has no entry for it${note}`,
      }
    }
    if (locked !== version) {
      return {
        resolved,
        locked,
        message: `${requirement} resolved to ${version}, but deno.lock has ${locked}`,
      }
    }
  }
  if (lockfile.hasPackage(kind, name, version)) return null
  return { resolved, locked: undefined, message: `${resolved} is not in deno.lock` }
}

/** The versions of the package `name` the lockfile has, sorted. */
function lockedVersions(lockfile: Lockfile, kind: 'npm' | 'jsr', name: string): string[] {
  const keys = Object.keys(kind === 'npm' ? lockfile.npm : lockfile.jsr)
  const versions = new Set<string>()
  for (const key of keys) {
    if (!key.startsWith(`${name}@`)) continue
    const version = key.slice(name.length + 1).split('_')[0] ?? ''
    if (version !== '') versions.add(version)
  }
  return [...versions].toSorted()
}

/** Versions a range allows that the minimum dependency age holds back. */
export interface WithheldVersions {
  /** Versions satisfying the range, published after {@link WithheldVersions.cutoff}, newest first. */
  versions: Array<{ version: string; published: string }>
  cutoff: Date
}

/** Where the registry metadata for {@link withheldVersions} is. */
export interface RegistryLookup {
  /** `DENO_DIR` spellings. */
  denoDirs: readonly string[]
  /** The JSR registries whose metadata Deno may have cached. */
  jsrRegistries: readonly string[]
}

/**
 * The versions of `kind:name` that satisfy `range` but were published after the minimum
 * dependency age's cutoff (so the engine could not pick them), newer than `below` when given.
 * `undefined` when the age is disabled or excludes the package, or the metadata is not cached.
 */
export function withheldVersions(
  kind: 'npm' | 'jsr',
  name: string,
  range: string | undefined,
  age: MinimumDependencyAge,
  lookup: RegistryLookup,
  below?: string,
): WithheldVersions | undefined {
  const cutoff = age.newestDependencyDate
  if (cutoff === null || isExcluded(`${kind}:${name}`, name, age.exclude)) return undefined
  const req = parseSpecifierVersionReq(range ?? '*')
  if (req === null) return undefined
  const floor: SemVer | null = below === undefined ? null : parseVersion(below)
  const published = new Map<string, string>()
  if (kind === 'npm') {
    const packument = cachedPackument(lookup.denoDirs, name)
    if (packument === undefined) return undefined
    for (const version of Object.keys(packument.versions)) {
      const time = packument.time[version]
      if (time !== undefined) published.set(version, time)
    }
  } else {
    const meta = lookup.jsrRegistries
      .map((registry) => cachedJsrMeta(lookup.denoDirs, registry, name))
      .find((found) => found !== undefined)
    if (meta === undefined) return undefined
    for (const [version, info] of Object.entries(meta.versions)) {
      if (!info.yanked && info.createdAt !== undefined) published.set(version, info.createdAt)
    }
  }
  const versions: Array<{ version: SemVer; published: string }> = []
  for (const [text, time] of published) {
    const version = parseVersion(text)
    const date = new Date(time)
    if (version === null || Number.isNaN(date.getTime()) || date <= cutoff) continue
    if (!satisfies(version, req)) continue
    if (floor !== null && compareVersions(version, floor) <= 0) continue
    versions.push({ version, published: date.toISOString() })
  }
  if (versions.length === 0) return undefined
  return {
    cutoff,
    versions: versions
      .toSorted((a, b) => compareVersions(b.version, a.version))
      .map((item) => ({ version: formatVersion(item.version), published: item.published })),
  }
}

function isExcluded(specifier: string, name: string, exclude: readonly string[]): boolean {
  return exclude.some((pattern) => {
    const target = /^(?:npm|jsr):/.test(pattern) ? specifier : name
    return pattern.endsWith('*') ? target.startsWith(pattern.slice(0, -1)) : target === pattern
  })
}

/** How the minimum dependency age is set, for messages. */
function ageSource(project: Pick<Project, 'minimumDependencyAge'>): string {
  return project.minimumDependencyAge.source === 'default'
    ? "Deno's default minimum dependency age of 24 hours"
    : '`minimumDependencyAge` in deno.json'
}

/** Options of {@link LockfilePolicy}. */
export interface LockfilePolicyOptions {
  decision: LockfileModeDecision
  project: Pick<Project, 'lockfile' | 'minimumDependencyAge' | 'nodeModules'>
  /** `checks.lockfile`: explain drift, missing entries and held-back versions. */
  explain: boolean
  logger: Logger
  jsrRegistries: readonly string[]
  /** `DENO_DIR` spellings, for registry metadata. */
  denoDirs: readonly string[]
}

/** The lockfile policy of one build; see the module documentation. */
export class LockfilePolicy {
  readonly mode: LockfileMode
  readonly reason: string
  readonly #options: LockfilePolicyOptions
  readonly #explained = new Set<string>()
  /** Requirements whose held-back versions were looked up. */
  readonly #ageChecked = new Set<string>()

  constructor(options: LockfilePolicyOptions) {
    this.mode = options.decision.mode
    this.reason = options.decision.reason
    this.#options = options
  }

  get #lockfile(): Lockfile | null {
    return this.#options.project.lockfile
  }

  /** A one-line description for the debug summary. */
  describe(): string {
    const lockfile = this.#lockfile
    return `lockfile ${lockfile === null ? 'none' : lockfile.path}, mode ${this.mode} (${this.reason})`
  }

  /**
   * Compares a resolution with the lockfile: throws in `frozen` mode, explains it in the debug
   * output otherwise.
   *
   * @throws {DenoPluginError} `LOCKFILE_FROZEN_DRIFT`.
   */
  check(check: LockCheck, importer?: string): void {
    if (this.mode === 'off') return
    const { project } = this.#options
    const drift = lockfileDrift(this.#lockfile, check, {
      jsrRegistries: this.#options.jsrRegistries,
      npm: project.nodeModules.mode !== 'manual',
    })
    if (drift === null) return
    if (this.mode === 'frozen') {
      const lockfile = this.#lockfile
      throw new DenoPluginError(
        'LOCKFILE_FROZEN_DRIFT',
        lockfile === null
          ? `The lockfile is frozen, but there is no deno.lock: ${drift.message}.`
          : `deno.lock is out of date: ${drift.message}.`,
        {
          hint: `${lockfile === null ? 'Run `deno install` to create deno.lock' : 'Run `deno install` to update deno.lock'} and commit it (the lockfile is frozen: ${this.reason}).`,
          specifier: check.specifier,
          importer,
        },
      )
    }
    if (!this.#options.explain || this.#lockfile === null) {
      this.#explainAge(check)
      return
    }
    this.#once(
      `drift\0${drift.message}`,
      `[lockfile] ${drift.message}${drift.locked === undefined ? ' (NOT_IN_LOCKFILE)' : ''}; allowed by \`lockfile: 'auto'\`, run \`deno install\` to update deno.lock`,
    )
    if (drift.locked === undefined) this.#explainAge(check)
  }

  /**
   * A better error for a failed resolution of `requirement`: `NOT_IN_LOCKFILE` for a
   * `CACHED_ONLY_MISS` of a requirement the lockfile lacks, and the minimum dependency age on a
   * `RESOLVE_CONSTRAINT` whose matching versions are all too young. Other errors are returned
   * as they are.
   */
  explainFailure(error: unknown, requirement: string): unknown {
    if (!this.#options.explain || !isDenoPluginError(error)) return error
    const parsed = parsePackageSpecifier(requirement)
    if (parsed === undefined || parsed.scheme === 'bare') return error
    const lockfile = this.#lockfile
    if (error.code === 'CACHED_ONLY_MISS' && lockfile !== null && !lockfile.has(requirement)) {
      return new DenoPluginError(
        'NOT_IN_LOCKFILE',
        `${requirement} is not in deno.lock, so it cannot be resolved with \`cachedOnly\`: Deno's cache has what \`deno install\` downloaded for the lockfile.`,
        {
          hint: `Run \`deno install\` with network access to add ${requirement} to deno.lock and the cache, then build with \`cachedOnly\` again.`,
          specifier: error.specifier ?? requirement,
          importer: error.importer,
          cause: error,
        },
      )
    }
    if (error.code === 'RESOLVE_CONSTRAINT') {
      const { project } = this.#options
      const withheld = withheldVersions(
        parsed.scheme,
        parsed.name,
        parsed.version,
        project.minimumDependencyAge,
        this.#lookup(),
      )
      if (withheld === undefined) return error
      const listed = withheld.versions
        .slice(0, 3)
        .map((item) => `${item.version} (published ${item.published})`)
        .join(', ')
      return new DenoPluginError(error.code, error.message, {
        hint: `The versions of ${parsed.name} that satisfy ${parsed.version ?? '*'} (${listed}) are newer than ${withheld.cutoff.toISOString()}, the cutoff of ${ageSource(project)}: pin an older version, wait, or set "minimumDependencyAge" in deno.json (0 disables it; its "exclude" list exempts packages).`,
        specifier: error.specifier,
        importer: error.importer,
        cause: error.cause ?? error,
      })
    }
    return error
  }

  /** Debug output for versions of a newly resolved requirement the age held back. */
  #explainAge(check: LockCheck): void {
    // Debug output only: the registry metadata is read (once per requirement) only for it.
    const { explain, logger } = this.#options
    if (!explain || !logger.debugEnabled || check.transitive === true) return
    const requested = parsePackageSpecifier(check.specifier)
    if (requested === undefined || requested.scheme === 'bare') return
    const version =
      check.resolved.kind === 'npm'
        ? check.resolved.npm?.version
        : jsrPackageOfUrl(check.resolved.url, this.#options.jsrRegistries)?.version
    if (version === undefined || version === '') return
    const key = `age\0${requested.scheme}:${requested.name}@${requested.version ?? '*'}`
    if (this.#ageChecked.has(key)) return
    this.#ageChecked.add(key)
    const { project } = this.#options
    const withheld = withheldVersions(
      requested.scheme,
      requested.name,
      requested.version,
      project.minimumDependencyAge,
      this.#lookup(),
      version,
    )
    if (withheld === undefined) return
    const newest = withheld.versions[0]
    if (newest === undefined) return
    this.#once(
      key,
      `[lockfile] ${requested.scheme}:${requested.name}@${requested.version ?? '*'} resolved to ${version}, not ${newest.version} (published ${newest.published}): versions newer than ${withheld.cutoff.toISOString()} are held back by ${ageSource(project)}`,
    )
  }

  #lookup(): RegistryLookup {
    return { denoDirs: this.#options.denoDirs, jsrRegistries: this.#options.jsrRegistries }
  }

  #once(key: string, message: string): void {
    if (this.#explained.has(key)) return
    this.#explained.add(key)
    this.#options.logger.debug(message)
  }
}
