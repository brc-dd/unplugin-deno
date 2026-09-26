/**
 * The `deno` engine's module graph: the union of the `deno info --json` outputs it has seen
 * (docs/architecture.md §4.3). A later output replaces the modules it contains, so a local file
 * that was edited gets its new imports when it is queried again.
 *
 * @module
 */
import { posix, win32 } from 'node:path'
import type { PathFlavor } from '../../utils/path.js'
import { HOST_PATH_FLAVOR } from '../../utils/path.js'
import type {
  DenoInfoDependency,
  DenoInfoModule,
  DenoInfoNpmPackage,
  DenoInfoOutput,
} from './info.js'

/** A module of the graph, with its dependencies by specifier. */
export interface GraphModule extends DenoInfoModule {
  /** {@link DenoInfoModule.dependencies} by the specifier as written. */
  readonly bySpecifier: ReadonlyMap<string, DenoInfoDependency>
}

/** How many redirects {@link InfoGraph.redirect} follows before giving up (Deno's limit). */
const MAX_REDIRECTS = 10

/** The union of `deno info` outputs. */
export class InfoGraph {
  /** Modules added as entrypoints. */
  readonly roots = new Set<string>()
  readonly #modules = new Map<string, GraphModule>()
  /** The run that last recorded each module (see {@link InfoGraph.recordedBy}). */
  readonly #runs = new Map<string, number>()
  readonly #redirects = new Map<string, string>()
  readonly #packages = new Map<string, string>()
  readonly #npmPackages = new Map<string, DenoInfoNpmPackage>()
  /** `npmPackages` by `localPath` (see {@link InfoGraph.#pathKey}). */
  readonly #npmByPath = new Map<string, DenoInfoNpmPackage>()
  readonly #path: typeof posix
  readonly #flavor: PathFlavor

  constructor(flavor: PathFlavor = HOST_PATH_FLAVOR) {
    this.#flavor = flavor
    this.#path = flavor === 'win32' ? win32 : posix
  }

  /** A path as a map key: normalised, and case-insensitive on Windows. */
  #pathKey(path: string): string {
    const normalized = this.#path.normalize(path)
    return this.#flavor === 'win32' ? normalized.toLowerCase() : normalized
  }

  /**
   * Adds the output of run `run`; `exclude` names modules not to record (the engine's synthetic
   * roots).
   */
  merge(output: DenoInfoOutput, run: number, exclude: ReadonlySet<string> = new Set()): void {
    for (const module of output.modules) {
      if (exclude.has(module.specifier)) continue
      this.#modules.set(module.specifier, {
        ...module,
        bySpecifier: new Map(
          module.dependencies.map((dependency) => [dependency.specifier, dependency]),
        ),
      })
      this.#runs.set(module.specifier, run)
    }
    for (const [from, to] of Object.entries(output.redirects)) this.#redirects.set(from, to)
    for (const [requirement, id] of Object.entries(output.packages)) {
      this.#packages.set(requirement, id)
    }
    for (const [id, npmPackage] of Object.entries(output.npmPackages)) {
      this.#npmPackages.set(id, npmPackage)
      if (npmPackage.localPath !== undefined) {
        this.#npmByPath.set(this.#pathKey(npmPackage.localPath), npmPackage)
      }
    }
  }

  /** The module recorded for `specifier` (no redirects applied). */
  module(specifier: string): GraphModule | undefined {
    return this.#modules.get(specifier)
  }

  /**
   * The run that last recorded `specifier` (no redirects applied): errors recorded by an earlier
   * run may be stale (a package installed since, a network error).
   */
  recordedBy(specifier: string): number | undefined {
    return this.#runs.get(specifier)
  }

  /**
   * `specifier` after following the recorded redirects (at most 10, cycles stop), or `specifier`
   * itself.
   */
  redirect(specifier: string): string {
    let current = specifier
    const seen = new Set<string>([current])
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const next = this.#redirects.get(current)
      if (next === undefined || seen.has(next)) return current
      seen.add(next)
      current = next
    }
    return current
  }

  /** Whether a redirect is recorded for `specifier`. */
  hasRedirect(specifier: string): boolean {
    return this.#redirects.has(specifier)
  }

  /** The dependency `specifier` of the module `referrer` (after redirects), if recorded. */
  dependency(referrer: string, specifier: string): DenoInfoDependency | undefined {
    return this.module(this.redirect(referrer))?.bySpecifier.get(specifier)
  }

  /** The npm package with this id. */
  npmPackage(id: string): DenoInfoNpmPackage | undefined {
    return this.#npmPackages.get(id)
  }

  /** npm packages with this name and exact version (several with different peer dependencies). */
  npmPackagesByVersion(name: string, version: string): DenoInfoNpmPackage[] {
    return [...this.#npmPackages.values()].filter(
      (npmPackage) => npmPackage.name === name && npmPackage.version === version,
    )
  }

  /** npm packages named `name`, highest version first (Deno's fallback for undeclared imports). */
  npmPackagesNamed(name: string): DenoInfoNpmPackage[] {
    return [...this.#npmPackages.values()]
      .filter((npmPackage) => npmPackage.name === name)
      .toSorted((a, b) => compareLoose(b.version, a.version))
  }

  /** The npm package whose `localPath` contains `path` (the innermost one). */
  npmPackageContaining(path: string): DenoInfoNpmPackage | undefined {
    let current = this.#path.normalize(path)
    for (;;) {
      const found = this.#npmByPath.get(this.#pathKey(current))
      if (found !== undefined) return found
      const parent = this.#path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }

  /**
   * The modules reachable from `starts` through runtime imports (`code` dependencies, after
   * redirects), `starts` included; dynamic imports are followed only with `dynamic`.
   */
  reachable(starts: Iterable<string>, dynamic: boolean): Set<string> {
    const seen = new Set<string>()
    const queue = [...starts].map((start) => this.redirect(start))
    for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
      if (seen.has(item)) continue
      seen.add(item)
      for (const dependency of this.module(item)?.dependencies ?? []) {
        const target = dependency.code?.specifier
        if (target === undefined || (dependency.isDynamic === true && !dynamic)) continue
        queue.push(this.redirect(target))
      }
    }
    return seen
  }

  /** The graph in `deno info --json` shape, for diagnostics. */
  toJSON(): unknown {
    return {
      roots: [...this.roots],
      modules: [...this.#modules.values()].map((module) => ({
        specifier: module.specifier,
        kind: module.kind,
        local: module.local,
        mediaType: module.mediaType,
        error: module.error,
        npmPackage: module.npmPackage,
        dependencies: module.dependencies,
      })),
      redirects: Object.fromEntries(this.#redirects),
      packages: Object.fromEntries(this.#packages),
      npmPackages: Object.fromEntries(this.#npmPackages),
    }
  }
}

/** `major.minor.patch-pre` as numbers and the prerelease. */
function parseVersion(version: string): [number[], string] {
  const [core = '', pre = ''] = version.split('-', 2)
  return [core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre]
}

/** Compares `major.minor.patch[-pre]` versions; prereleases sort before their release. */
function compareLoose(a: string, b: string): number {
  const [left, leftPre] = parseVersion(a)
  const [right, rightPre] = parseVersion(b)
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (leftPre === rightPre) return 0
  if (leftPre === '') return 1
  if (rightPre === '') return -1
  return leftPre < rightPre ? -1 : 1
}
