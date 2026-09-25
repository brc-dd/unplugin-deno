/**
 * Watching and invalidation (docs/architecture.md §5.7): the files whose changes affect resolution
 * (configs, import maps, package.json files, the lockfile), and the orchestration when one of
 * them changes: flush the mirror manifest, dispose the engines, reload the project and recompute
 * the generation (the mirror is rewritten lazily under the new generation).
 *
 * @module
 */
import { posix, win32 } from 'node:path'
import type { Project } from '../config/project.js'
import type { Logger } from '../diagnostics/logger.js'
import type { PathFlavor } from '../utils/path.js'
import { HOST_PATH_FLAVOR } from '../utils/path.js'
import { splitQuery } from './id.js'

/** The files a host watches for a project: configs, import maps, package.json files, lockfile. */
export function watchFiles(project: Pick<Project, 'watchFiles'>): string[] {
  return [...project.watchFiles]
}

/** Whether `file` (a host id; its query is ignored) is one of the project's watch files. */
export function isWatchedFile(
  project: Pick<Project, 'watchFiles'>,
  file: string,
  flavor: PathFlavor = HOST_PATH_FLAVOR,
): boolean {
  const syntax = flavor === 'win32' ? win32 : posix
  const normalize = (path: string): string => {
    const normalized = syntax.normalize(path)
    return flavor === 'win32' ? normalized.toLowerCase() : normalized
  }
  const target = normalize(splitQuery(file).base)
  return project.watchFiles.some((watched) => normalize(watched) === target)
}

/** What {@link invalidateProject} drives (implemented by the plugin state). */
export interface InvalidationTarget {
  readonly logger: Logger
  /** Persists what the current generation has written. */
  flush(): Promise<void>
  /** Disposes every engine (they cache the old config and lockfile). */
  disposeEngines(): Promise<void>
  /** Discovers and loads the project again. */
  loadProject(): Promise<Project>
  /** Derives platform, generation, mirror and resolver from a (re)loaded project. */
  configure(project: Project): Promise<void>
}

/**
 * Reloads everything that depends on the project after `changed` (a watched file) changed. Local
 * source edits need nothing: hosts load local files themselves.
 */
export async function invalidateProject(
  target: InvalidationTarget,
  changed: string,
): Promise<Project> {
  target.logger.debug(`[watch] ${changed} changed; reloading the project`)
  await target.flush()
  await target.disposeEngines()
  const project = await target.loadProject()
  await target.configure(project)
  return project
}
