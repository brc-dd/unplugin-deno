/**
 * npm installs for `nodeModulesDir: "auto"` in Vite. The engine installs packages into
 * `node_modules/.deno` when entrypoints are added to its graph, not when it resolves a specifier,
 * and a resolution that failed because a package was not installed yet keeps failing on that
 * engine. Rolldown, Rollup and esbuild seed the engine with their inputs at the build start; a
 * Vite app's inputs are HTML files, and its dev server meets modules one request at a time. So
 * before an `npm:` specifier (or an import-map key mapped to one) is resolved for the first time,
 * its requirement is added as an entrypoint, which installs the package and its dependencies.
 * Requirements met in the same tick are added together; additions are serialised.
 *
 * @module
 */
import { isNodeModulesPath } from '../../core/npm.js'
import type { ResolveTarget } from '../../core/resolve.js'
import { parseSpecifier } from '../../core/specifier.js'
import type { PluginState } from '../../core/state.js'
import { toFileUrl } from '../../utils/path.js'

/** Installs the npm package of an import before it is resolved (see the module documentation). */
export type PackageInstaller = (
  source: string,
  importer: string | undefined,
  target: ResolveTarget | undefined,
) => Promise<void>

/** Requirements added to one target's engine together. */
interface Batch {
  requirements: Set<string>
  done: Promise<void>
}

/** Creates the {@link PackageInstaller} of a plugin instance. */
export function packageInstaller(state: PluginState): PackageInstaller {
  /** Requirements added (or being added), by target; reset when the project is reloaded. */
  let added = new Map<string, Promise<void>>()
  let generation = ''
  const open = new Map<string, Batch>()
  let queue: Promise<void> = Promise.resolve()

  const enqueue = (targetKey: string, target: ResolveTarget | undefined): Batch => {
    let batch = open.get(targetKey)
    if (batch === undefined) {
      const requirements = new Set<string>()
      const done = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
        open.delete(targetKey)
        const run = queue.then(() => state.addEntrypoints(target, [...requirements]))
        queue = run.catch(() => {})
        return run
      })
      batch = { requirements, done }
      open.set(targetKey, batch)
    }
    return batch
  }

  return async (source, importer, target) => {
    if (state.project.nodeModules.mode !== 'auto') return
    const requirement = npmRequirement(state, source, importer)
    if (requirement === null) return
    if (generation !== state.generation) {
      generation = state.generation
      added = new Map()
    }
    const targetKey = JSON.stringify(target ?? null)
    const key = `${targetKey}\0${requirement}`
    let install = added.get(key)
    if (install === undefined) {
      const batch = enqueue(targetKey, target)
      batch.requirements.add(requirement)
      install = batch.done
      added.set(key, install)
      install.catch(() => {
        if (added.get(key) === install) added.delete(key)
      })
    }
    // A failed install is not the import's error: resolving it reports what is wrong.
    await install.catch((error: unknown) => {
      state.logger.debug(`[vite] cannot install ${requirement}: ${String(error)}`)
    })
  }
}

/**
 * The npm requirement an import resolves through: an `npm:` specifier (without a query), or the
 * `npm:` target of an import-map key for the importer. Bare imports inside `node_modules` are the
 * host's (Node resolution), so they have none.
 */
function npmRequirement(
  state: PluginState,
  source: string,
  importer: string | undefined,
): string | null {
  const { kind, base } = parseSpecifier(source)
  if (kind === 'npm') return base
  if (kind !== 'bare' || state.project.disabled) return null
  const local = importer !== undefined && parseSpecifier(importer).kind === 'absolute'
  if (local && isNodeModulesPath(importer, state.flavor)) return null
  const referrer = local ? toFileUrl(parseSpecifier(importer).base, state.flavor) : undefined
  let mapped: string | undefined
  try {
    mapped = state.project.importMap.resolve(base, referrer)?.mapped
  } catch {
    // The resolution reports invalid import-map entries.
    return null
  }
  return mapped !== undefined && parseSpecifier(mapped).kind === 'npm' ? mapped : null
}
