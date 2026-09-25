/**
 * The npm strategy (docs/architecture.md §5.4): npm files the engine resolved under a
 * `node_modules` directory are handed back to the host resolver ("redirect", so the host applies
 * `exports` conditions, the `browser` field, `sideEffects` and CommonJS interop); files in Deno's
 * global npm cache (`nodeModulesDir: "none"`) are loaded as paths and their imports come back to
 * the plugin.
 *
 * @module
 */
import { posix, win32 } from 'node:path'
import type { NodeModulesDirMode } from '../config/deno-config.js'
import { realpathMaybeMissing } from '../engine/npm-package.js'
import { parsePackageSpecifier } from '../engine/package-specifier.js'
import type { ResolvedModule } from '../engine/types.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR, isSubpath, toPath } from '../utils/path.js'

/**
 * Where npm packages come from for a build: the project's `node_modules` (resolved by the host)
 * or Deno's global cache (resolved by the engine, including the imports inside the packages).
 */
export type NpmStrategy = 'node_modules' | 'deno-cache'

/**
 * The effective npm strategy. `auto` follows where Deno puts packages: the global cache for
 * `nodeModulesDir: "none"`, `node_modules` otherwise (`auto` installs into `node_modules/.deno`
 * on the first resolution, so the directory need not exist yet).
 */
export function npmStrategyFor(
  option: 'auto' | NpmStrategy,
  nodeModulesDir: NodeModulesDirMode,
): NpmStrategy {
  if (option !== 'auto') return option
  return nodeModulesDir === 'none' ? 'deno-cache' : 'node_modules'
}

/** Hand the request to the host resolver from inside the package (§5.4). */
export interface NpmRedirectOutcome {
  type: 'npm-redirect'
  /** `name + subpath`, e.g. `kleur/colors`. */
  request: string
  /** The package directory; the host resolves {@link NpmRedirectOutcome.request} from here. */
  resolveDir: string
  /** The package's `package.json`, used as the importer of the redirected request. */
  packageJsonPath: string
  /** The specifier as the engine received it (`npm:kleur@^4/colors`). */
  rawSpecifier: string
  /** The file the engine resolved, used when the host cannot resolve the request. */
  fallbackPath: string
  /** The query of the original id (`?raw`), appended to the host's result. */
  query: string
  /** The package's `sideEffects` flag when it is a boolean. */
  sideEffects?: boolean | null
}

/** A file the host loads itself. */
export interface PathOutcome {
  type: 'path'
  /** OS path, with the original query appended. */
  path: string
  /** `false` lets the host drop the module when unused (package `sideEffects: false`). */
  sideEffects?: boolean | null
}

/**
 * Whether `path` lies inside a `node_modules` directory (any layout: isolated `.deno/`, pnpm,
 * hoisted).
 */
export function isNodeModulesPath(path: string, flavor: PathFlavor = HOST_PATH_FLAVOR): boolean {
  const segments = path.split(flavor === 'win32' ? /[\\/]/ : /\//)
  const index = segments.lastIndexOf('node_modules')
  return index >= 0 && index < segments.length - 1
}

/**
 * The spellings of a `DENO_DIR` that paths may use: as configured and with symlinks resolved
 * (the engine reports canonical paths; `/var` → `/private/var` on macOS).
 */
export function denoDirVariants(denoDir: string | undefined): string[] {
  if (denoDir === undefined) return []
  const real = realpathMaybeMissing(denoDir)
  return real === denoDir ? [denoDir] : [denoDir, real]
}

/** Whether `path` is a file of Deno's global npm cache (`<DENO_DIR>/npm/…`). */
export function isGlobalCachePath(
  path: string,
  denoDir: string | readonly string[] | undefined,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): boolean {
  if (denoDir === undefined) return false
  const syntax = flavor === 'win32' ? win32 : posix
  const dirs = typeof denoDir === 'string' ? [denoDir] : denoDir
  return dirs.some((dir) => {
    const root = syntax.join(dir, 'npm')
    return path !== root && isSubpath(root, path, flavor)
  })
}

/** What {@link npmOutcome} needs besides the resolution. */
export interface NpmOutcomeContext {
  strategy: NpmStrategy
  /** `DENO_DIR` spellings (see {@link denoDirVariants}). */
  denoDirs: readonly string[]
  /** The query of the original id, kept on the result. */
  query: string
  flavor?: PathFlavor
}

/**
 * The outcome for an npm file the engine resolved (§5.4): a redirect when the file is under a
 * `node_modules` directory, the strategy is `node_modules` and `rawSpecifier` names the package
 * (so `name + subpath` is a request the host can resolve); otherwise the file itself.
 */
export function npmOutcome(
  resolved: ResolvedModule,
  rawSpecifier: string,
  context: NpmOutcomeContext,
): NpmRedirectOutcome | PathOutcome {
  const flavor = context.flavor ?? HOST_PATH_FLAVOR
  const path = resolved.path ?? toPath(resolved.url, flavor)
  const info = resolved.npm
  const sideEffects = resolved.sideEffects ?? null
  const redirect =
    context.strategy === 'node_modules' &&
    info !== undefined &&
    isNodeModulesPath(path, flavor) &&
    !isGlobalCachePath(path, context.denoDirs, flavor) &&
    parsePackageSpecifier(rawSpecifier)?.name === info.name
  if (!redirect) return { type: 'path', path: `${path}${context.query}`, sideEffects }
  return {
    type: 'npm-redirect',
    request: `${info.name}${info.subpath}`,
    resolveDir: info.packageDir,
    packageJsonPath: info.packageJsonPath,
    rawSpecifier,
    fallbackPath: path,
    query: context.query,
    sideEffects,
  }
}
