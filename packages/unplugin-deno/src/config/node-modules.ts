import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { NodeModulesDirMode } from './deno-config.js'
import { normalizeNodeModulesDir } from './deno-config.js'
import type { Discovery } from './discover.js'

/**
 * How packages are laid out in `node_modules`:
 * - `isolated`: Deno's default linker (`node_modules/.deno/<name>@<version>/node_modules/<name>`
 *   plus top-level symlinks);
 * - `pnpm`: a pnpm store (`node_modules/.pnpm/`);
 * - `hoisted`: real package directories at the top level (npm, Yarn, Bun, Deno's `hoisted` linker).
 */
export type NodeModulesLayout = 'isolated' | 'hoisted' | 'pnpm'

/** The `nodeModulesDir` mode and the `node_modules` directory found on disk. */
export interface NodeModulesInfo {
  /** Deno's effective `nodeModulesDir` mode. */
  mode: NodeModulesDirMode
  /** Whether the mode comes from the root config's `nodeModulesDir` (otherwise derived). */
  explicit: boolean
  /** `<workspace root>/node_modules` when that directory exists, otherwise `null`. */
  dir: string | null
  /** The detected layout of {@link NodeModulesInfo.dir}, `null` when it holds no packages. */
  layout: NodeModulesLayout | null
  /**
   * Whether `node_modules/@jsr/` holds packages: `jsr:` dependencies installed from JSR's npm
   * registry (Deno 2.9 `jsrDepsInNodeModules`, or pnpm/Yarn/npm installs of JSR packages).
   */
  hasJsrDeps: boolean
}

/**
 * Determines the `nodeModulesDir` mode as Deno 2.9 does (`raw_node_modules_dir_mode`): the root
 * config's `nodeModulesDir` (legacy booleans mapped) wins; otherwise `manual` when the workspace
 * root has a `package.json`, `auto` when the root config sets `vendor: true`, else `none`. Then
 * probes `<workspace root>/node_modules` (Deno always places it at the workspace root) for its
 * layout (docs/architecture.md §3.1 step 6).
 */
export async function detectNodeModules(
  discovery: Pick<Discovery, 'rootFolder' | 'workspaceRoot'>,
): Promise<NodeModulesInfo> {
  const rootConfig = discovery.rootFolder?.denoJson?.config
  const configured = normalizeNodeModulesDir(rootConfig?.nodeModulesDir)
  const mode: NodeModulesDirMode =
    configured ??
    (discovery.rootFolder?.packageJson ? 'manual' : rootConfig?.vendor === true ? 'auto' : 'none')
  const candidate = join(discovery.workspaceRoot, 'node_modules')
  const dir = (await isDirectory(candidate)) ? candidate : null
  return {
    mode,
    explicit: configured !== undefined,
    dir,
    layout: dir === null ? null : await probeLayout(dir),
    hasJsrDeps: dir !== null && (await hasVisibleEntries(join(dir, '@jsr'))),
  }
}

async function probeLayout(dir: string): Promise<NodeModulesLayout | null> {
  const entries = await readdir(dir).catch(() => [] as string[])
  if (entries.includes('.pnpm')) return 'pnpm'
  if (entries.includes('.deno') && (await hasVisibleEntries(join(dir, '.deno')))) return 'isolated'
  return entries.some((entry) => !entry.startsWith('.')) ? 'hoisted' : null
}

/** Whether `dir` is a directory with at least one entry not starting with `.`. */
async function hasVisibleEntries(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.some((entry) => !entry.startsWith('.'))
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
