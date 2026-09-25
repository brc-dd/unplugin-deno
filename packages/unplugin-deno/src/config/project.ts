import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256Hex } from '../utils/hash.js'
import type { DenoConfig, JsxSettings, MinimumDependencyAge } from './deno-config.js'
import {
  DEFAULT_MINIMUM_DEPENDENCY_AGE_MINUTES,
  jsxSettings,
  normalizeLock,
  resolveMinimumDependencyAge,
} from './deno-config.js'
import type { ConfigWarning, DiscoverOptions, Discovery } from './discover.js'
import { discoverProject } from './discover.js'
import type { ImportMapResolver } from './import-map.js'
import { createImportMapResolver } from './import-map.js'
import type { Lockfile, UnsupportedLockfile } from './lockfile.js'
import { readLockfile } from './lockfile.js'
import type { NodeModulesInfo } from './node-modules.js'
import { detectNodeModules } from './node-modules.js'

export type {
  ConfigFolder,
  ConfigWarning,
  DenoJsonFile,
  DiscoverOptions,
  Discovery,
  ImportMapSource,
  LinkFolder,
  PackageJsonFile,
} from './discover.js'
export type { DenoConfig, JsxSettings, MinimumDependencyAge } from './deno-config.js'
export type { ImportMapMatch, ImportMapResolver } from './import-map.js'
export type { Lockfile, UnsupportedLockfile } from './lockfile.js'
export type { NodeModulesInfo, NodeModulesLayout } from './node-modules.js'

/** Options of {@link loadProject}. */
export interface LoadProjectOptions extends DiscoverOptions {
  /** `'off'` skips `deno.lock` (the `lockfile` plugin option); default `'auto'`. */
  lockfile?: 'auto' | 'frozen' | 'off' | undefined
  /** The current time, for `minimumDependencyAge` (tests pass a fixed date). */
  now?: Date | undefined
}

/** The assembled view of a Deno project (docs/architecture.md §3.1 "Output"). */
export interface Project extends Discovery {
  /** The config at {@link Discovery.configPath}. */
  config: DenoConfig | null
  /** The workspace root's `deno.json(c)`, when it has one. */
  workspaceConfig: DenoConfig | null
  nodeModules: NodeModulesInfo
  /** Where Deno reads the lockfile (root config `lock`, default `<root>/deno.lock`), if enabled. */
  lockfilePath: string | null
  /** The parsed lockfile, `null` when absent, disabled or unsupported. */
  lockfile: Lockfile | null
  /** Set when `deno.lock` has a version other than 5 (treated as absent, with a warning). */
  unsupportedLockfile: UnsupportedLockfile | null
  /** `lock.frozen` in the root config. */
  lockfileFrozen: boolean
  /**
   * JSX settings of the nearest config (a member's `compilerOptions` override the root's), with
   * Deno's defaults.
   */
  jsx: JsxSettings
  /** The root config's `unstable` features (e.g. `raw-imports`). */
  unstable: string[]
  /** The root config's `vendor`. */
  vendor: boolean
  /** `jsrDepsInNodeModules` in effect (it requires a `node_modules` directory mode). */
  jsrDepsInNodeModules: boolean
  /** The minimum dependency age in effect (Deno 2.9 defaults to 24 h). */
  minimumDependencyAge: MinimumDependencyAge & { source: 'config' | 'default' }
  importMap: ImportMapResolver
}

/**
 * Discovers and assembles a project: config discovery, `node_modules` detection, the lockfile,
 * JSX settings, the import-map resolver and the files to watch (docs/architecture.md §3).
 *
 * @throws {DenoPluginError} From discovery, config parsing, import maps and the lockfile.
 */
export async function loadProject(
  root: string,
  options: LoadProjectOptions = {},
): Promise<Project> {
  const discovery = await discoverProject(root, options)
  const warnings: ConfigWarning[] = [...discovery.warnings]
  const rootDenoJson = discovery.rootFolder?.denoJson ?? null
  const workspaceConfig = rootDenoJson?.config ?? null
  const nearest = [discovery.rootFolder, ...discovery.members].find(
    (folder) => folder?.denoJson?.path === discovery.configPath,
  )
  const config = nearest?.denoJson?.config ?? workspaceConfig
  const nodeModules = await detectNodeModules(discovery)

  const lock = lockSettings(discovery, options)
  const watchFiles = [...discovery.watchFiles]
  let lockfile: Lockfile | null = null
  let unsupportedLockfile: UnsupportedLockfile | null = null
  if (lock.path !== null) {
    watchFiles.push(lock.path)
    const read = await readLockfile(lock.path)
    if (read?.unsupported === true) {
      unsupportedLockfile = read
      warnings.push({
        file: lock.path,
        message: `deno.lock version ${read.version} is not supported (expected 5), so it is ignored; run \`deno install\` to upgrade it.`,
      })
    } else {
      lockfile = read ?? null
    }
  }

  const now = options.now ?? new Date()
  const configuredAge =
    rootDenoJson === null
      ? undefined
      : resolveMinimumDependencyAge(workspaceConfig?.minimumDependencyAge, now, rootDenoJson.path)
  const minimumDependencyAge = configuredAge
    ? { ...configuredAge, source: 'config' as const }
    : {
        newestDependencyDate: new Date(
          now.getTime() - DEFAULT_MINIMUM_DEPENDENCY_AGE_MINUTES * 60_000,
        ),
        exclude: [],
        source: 'default' as const,
      }

  return {
    ...discovery,
    watchFiles: [...new Set(watchFiles)].toSorted(),
    warnings,
    config,
    workspaceConfig,
    nodeModules,
    lockfilePath: lock.path,
    lockfile,
    unsupportedLockfile,
    lockfileFrozen: lock.frozen,
    jsx: jsxSettings({
      compilerOptions: { ...workspaceConfig?.compilerOptions, ...config?.compilerOptions },
    }),
    unstable: workspaceConfig?.unstable ?? [],
    vendor: workspaceConfig?.vendor === true,
    jsrDepsInNodeModules:
      workspaceConfig?.jsrDepsInNodeModules === true && nodeModules.mode !== 'none',
    minimumDependencyAge,
    importMap: createImportMapResolver(discovery),
  }
}

/**
 * The lockfile location Deno uses (`Workspace::resolve_lockfile_path`): the root deno.json's
 * `lock` setting, or `deno.lock` next to a root package.json; nothing for `lockfile: 'off'`.
 */
function lockSettings(
  discovery: Discovery,
  options: LoadProjectOptions,
): { path: string | null; frozen: boolean } {
  if (options.lockfile === 'off' || discovery.rootFolder === null)
    return { path: null, frozen: false }
  const { denoJson, packageJson } = discovery.rootFolder
  if (denoJson !== null) {
    const settings = normalizeLock(denoJson.config, denoJson.path)
    return { path: settings.path, frozen: settings.frozen }
  }
  return packageJson === null
    ? { path: null, frozen: false }
    : { path: join(dirname(packageJson.path), 'deno.lock'), frozen: false }
}

/**
 * A hash of the contents of every watched file (configs, import maps, package.json files and the
 * lockfile; missing files count as missing). Changes whenever resolution inputs change; the core
 * derives the mirror generation from it (docs/architecture.md §5.3).
 */
export async function configGeneration(project: Pick<Project, 'watchFiles'>): Promise<string> {
  const files = [...new Set(project.watchFiles)].toSorted()
  const parts = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file, 'utf8').catch(() => null)
      return `${file}\0${content === null ? 'missing' : `=${content}`}\0`
    }),
  )
  return sha256Hex(parts.join(''))
}
