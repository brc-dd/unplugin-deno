/**
 * Host facts from esbuild's build options (docs/architecture.md §6.4): the root (`absWorkingDir`),
 * the platform hint, the export conditions and the entry points, plus the plugin options esbuild's
 * `packages: 'external'` implies.
 *
 * @module
 */
import type { BuildOptions } from 'esbuild'
import type { ResolvedOptions } from '../../core/options.js'
import type { StateHints } from '../../core/state.js'

/** The `external` patterns `packages: 'external'` adds (Deno packages stay imports). */
const PACKAGE_PATTERNS = ['npm:*', 'jsr:*'] as const

/** The entry points of a build as the core reads them: the `in` path of `{ in, out }` entries. */
export function entryInput(
  entryPoints: BuildOptions['entryPoints'],
): string[] | Record<string, string> {
  if (entryPoints === undefined) return []
  if (Array.isArray(entryPoints)) {
    return entryPoints.map((entry) => (typeof entry === 'string' ? entry : entry.in))
  }
  return { ...entryPoints }
}

/** The entry point paths of a build (the values of {@link entryInput}). */
export function entryList(entryPoints: BuildOptions['entryPoints']): string[] {
  const input = entryInput(entryPoints)
  return Array.isArray(input) ? input : Object.values(input)
}

/**
 * The state hints of a build: the root is `absWorkingDir` (esbuild's default is the process's
 * working directory); esbuild's `platform` is the platform hint — `browser` (esbuild's default
 * when unset) gives the browser platform, `node` and `neutral` give `deno` for projects with a
 * `deno.json` and `node` otherwise (docs/architecture.md §5.6; the `platform` option wins).
 */
export function hintsFor(options: BuildOptions, version: string | undefined): StateHints {
  return {
    root: options.absWorkingDir ?? process.cwd(),
    platform: options.platform ?? 'browser',
    conditions: options.conditions,
    input: entryInput(options.entryPoints),
    version,
    command: 'build',
  }
}

/**
 * Identifies the build options a loaded project depends on: the root, the platform, the
 * conditions and `packages`. Builds sharing one plugin instance must agree on them.
 */
export function settingsKey(options: BuildOptions): string {
  return JSON.stringify([
    options.absWorkingDir ?? process.cwd(),
    options.platform ?? null,
    options.conditions ?? null,
    options.packages === 'external',
  ])
}

/**
 * The plugin options for a build: with `packages: 'external'`, `npm:` and `jsr:` specifiers (and
 * bare names the import map maps to them) are kept external and pinned, as for the Deno platform
 * (§5.6); explicit `pinExternals` wins. `base` is the core's resolution of the user options.
 */
export function buildOptions(base: ResolvedOptions, packagesExternal: boolean): ResolvedOptions {
  if (!packagesExternal) return base
  const external = [...base.external]
  for (const pattern of PACKAGE_PATTERNS) if (!external.includes(pattern)) external.push(pattern)
  return { ...base, external, pinExternals: base.pinExternals ?? true }
}
